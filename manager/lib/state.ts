/**
 * StateManager - orchestrates session state, polling, and persistence.
 *
 * Architecture:
 * - StateManager is the single source of truth for session state
 * - Backend polling updates state at adaptive intervals
 * - API endpoints read from cached state (instant, no SSH)
 * - Sessions use composite keys: user-hpc-ide (e.g., domeally-gemini-vscode)
 * - For single-user mode, user defaults to config.hpcUser
 *
 * Sub-modules handle each concern:
 * - LockManager: mutex for concurrent operation prevention (state/locking.ts)
 * - SessionManager: in-memory session CRUD (state/sessions.ts)
 * - JobPoller: adaptive SLURM job polling loop (state/jobPolling.ts)
 * - ClusterHealthPoller: fixed-interval health polling (state/clusterHealth.ts)
 */

import { promises as fs } from 'fs';
import path from 'path';
import { errorDetails } from './errors';
import { log } from './logger';
import { clusters, config } from '../config';
import { initializeDb, getDb } from './db';
import * as dbSessions from './db/sessions';
import * as dbHealth from './db/health';
import { checkAndMigrate } from './db/migrate';

import {
  POLLING_CONFIG,
  buildSessionKey,
  parseSessionKey,
  createIdleSession,
} from './state/types';

import type {
  HpcServiceFactory,
  ActiveSession,
  ClusterHealthState,
  AppState,
  UserAccountCache,
  PollingInfo,
  ClearSessionOptions,
  Session,
  HealthHistoryEntry,
} from './state/types';

import { LockManager } from './state/locking';
import { SessionManager } from './state/sessions';
import { JobPoller } from './state/jobPolling';
import { ClusterHealthPoller } from './state/clusterHealth';

class StateManager {
  private stateFile: string;
  private enablePersistence: boolean;
  private useSqlite: boolean;
  private state: AppState;
  private ready: boolean;
  private pollingStopped: boolean;
  private hpcServiceFactory: HpcServiceFactory | null;
  private userAccounts: Map<string, UserAccountCache>;
  onSessionCleared: ((user: string, hpc: string, ide: string) => void) | null;

  private lockManager: LockManager;
  private sessionManager: SessionManager;
  private jobPoller: JobPoller;
  private healthPoller: ClusterHealthPoller;

  constructor() {
    this.stateFile = process.env.STATE_FILE || '/data/state.json';
    this.enablePersistence = process.env.ENABLE_STATE_PERSISTENCE === 'true';
    this.useSqlite = process.env.USE_SQLITE !== 'false';
    this.state = { sessions: {}, activeSession: null };
    this.ready = false;
    this.pollingStopped = false;
    this.hpcServiceFactory = null;
    this.userAccounts = new Map();
    this.onSessionCleared = null;

    this.lockManager = new LockManager();

    // Sub-managers share this.state by reference — mutations are visible to all
    this.sessionManager = new SessionManager(
      this.state,
      this.useSqlite,
      () => this.save(),
      () => this.onSessionCleared,
      () => this.jobPoller.triggerFastPoll(),
    );

    this.jobPoller = new JobPoller(
      this.state,
      () => this.hpcServiceFactory,
      () => this.pollingStopped,
      () => this.save(),
      (user, hpc, ide, options) => this.sessionManager.clearSession(user, hpc, ide, options),
    );

    this.healthPoller = new ClusterHealthPoller(
      this.state,
      this.useSqlite,
      this.stateFile,
      () => this.hpcServiceFactory,
      () => this.pollingStopped,
      (user) => this.getUserAccount(user),
      () => this.save(),
    );
  }

  // ============================================
  // Readiness
  // ============================================

  isReady(): boolean {
    return this.ready;
  }

  // ============================================
  // Locking (delegates to LockManager)
  // ============================================

  acquireLock(operation: string): void {
    this.lockManager.acquireLock(operation);
  }

  releaseLock(operation: string): void {
    this.lockManager.releaseLock(operation);
  }

  isLocked(operation: string): boolean {
    return this.lockManager.isLocked(operation);
  }

  getActiveLocks(): string[] {
    return this.lockManager.getActiveLocks();
  }

  // ============================================
  // Persistence
  // ============================================

  /**
   * Load state from disk/database on startup
   * Reconcile with squeue to detect orphaned jobs
   */
  async load(): Promise<void> {
    if (this.useSqlite) {
      try {
        initializeDb();
        checkAndMigrate();
        log.state('SQLite database initialized');
      } catch (err) {
        log.error('Failed to initialize SQLite database', errorDetails(err));
        this.useSqlite = false;
      }
    }

    if (!this.enablePersistence && !this.useSqlite) {
      this.ready = true;
      return;
    }

    if (this.useSqlite) {
      try {
        const dbActiveSessions = dbSessions.getAllActiveSessions();
        for (const [key, session] of Object.entries(dbActiveSessions)) {
          this.state.sessions[key] = session;
        }

        const db = getDb();
        const activeRow = db.prepare('SELECT value FROM app_state WHERE key = ?').get('activeSession') as { value: string } | undefined;
        if (activeRow?.value) {
          this.state.activeSession = JSON.parse(activeRow.value);
        }

        const clusterCaches = dbHealth.getAllClusterCaches();
        this.state.clusterHealth = {};
        for (const [hpc, cache] of Object.entries(clusterCaches)) {
          this.state.clusterHealth[hpc] = {
            current: cache,
            history: [],
            consecutiveFailures: cache.consecutiveFailures || 0,
          };
        }

        log.state('Loaded state from SQLite', {
          sessionKeys: Object.keys(this.state.sessions),
          activeSession: this.state.activeSession,
        });
      } catch (err) {
        log.error('Failed to load from SQLite', errorDetails(err));
      }
    }

    if (this.enablePersistence) {
      try {
        const data = await fs.readFile(this.stateFile, 'utf8');
        const loadedState = JSON.parse(data);
        log.state('Loaded from disk', {
          file: this.stateFile,
          sessionKeys: Object.keys(loadedState.sessions || {}),
          activeSession: loadedState.activeSession,
        });

        if (loadedState.activeHpc && !loadedState.activeSession) {
          loadedState.activeSession = null;
          delete loadedState.activeHpc;
        }

        if (!loadedState.sessions) {
          loadedState.sessions = {};
        }

        if (Object.keys(this.state.sessions).length === 0) {
          this.state.activeSession = loadedState.activeSession ?? null;
          this.state.clusterHealth = loadedState.clusterHealth ?? {};

          for (const [key, session] of Object.entries(loadedState.sessions)) {
            if (!parseSessionKey(key)) {
              log.warn('Skipping invalid session key', { key });
              continue;
            }
            if (session) {
              (session as Session).tunnelProcess = null;
            }
            this.state.sessions[key] = session as Session | null;
          }
        }
      } catch (e) {
        const nodeErr = e as NodeJS.ErrnoException;
        if (nodeErr.code !== 'ENOENT') {
          log.error('Failed to load state from JSON', errorDetails(e));
        }
      }
    }

    await this.reconcile();
    this.ready = true;
  }

  /**
   * Save state to disk/database after every change
   */
  async save(): Promise<void> {
    if (this.useSqlite) {
      try {
        for (const [sessionKey, session] of Object.entries(this.state.sessions)) {
          if (session) {
            dbSessions.saveActiveSession(sessionKey, session);
          }
        }

        const db = getDb();
        db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
          .run('activeSession', JSON.stringify(this.state.activeSession));
      } catch (err) {
        log.error('Failed to save to SQLite', errorDetails(err));
      }
    }

    if (!this.enablePersistence) return;
    log.state('Saving state to disk', {
      file: this.stateFile,
      sessionKeys: Object.keys(this.state.sessions),
      activeSession: this.state.activeSession,
    });

    try {
      const dir = path.dirname(this.stateFile);
      await fs.mkdir(dir, { recursive: true });

      const cleanState: {
        activeSession: ActiveSession | null;
        clusterHealth: Record<string, ClusterHealthState>;
        sessions: Record<string, Partial<Session> | null>;
      } = {
        activeSession: this.state.activeSession,
        clusterHealth: this.state.clusterHealth || {},
        sessions: {},
      };

      for (const [sessionKey, session] of Object.entries(this.state.sessions)) {
        if (session) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { tunnelProcess: _unused, ...rest } = session;
          cleanState.sessions[sessionKey] = rest;
        } else {
          cleanState.sessions[sessionKey] = null;
        }
      }

      await fs.writeFile(this.stateFile, JSON.stringify(cleanState, null, 2));
    } catch (e) {
      log.error('Failed to save state', errorDetails(e));
    }
  }

  /**
   * Reconcile state with reality on startup
   */
  async reconcile(): Promise<void> {
    for (const [sessionKey, session] of Object.entries(this.state.sessions)) {
      if (session?.status === 'running' && session.jobId) {
        const parsed = parseSessionKey(sessionKey);
        if (!parsed) {
          log.warn('Failed to parse session key during reconcile', { sessionKey });
          continue;
        }
        const { user, hpc, ide } = parsed;
        const exists = await this.checkJobExists(hpc, session.jobId);
        if (!exists) {
          log.state(`Job ${session.jobId} no longer exists, clearing session`, { sessionKey });
          await this.sessionManager.clearSession(user, hpc, ide, { endReason: 'reconciled' });
        }
      }
    }
    await this.save();
  }

  /**
   * Check if job exists in squeue (delegates to JobPoller)
   */
  async checkJobExists(hpc: string, jobId: string): Promise<boolean> {
    return this.jobPoller.checkJobExists(hpc, jobId);
  }

  // ============================================
  // Session management (delegates to SessionManager)
  // ============================================

  async createSession(user: string | null, hpc: string, ide: string, initialProperties: Partial<Session> = {}): Promise<Session> {
    return this.sessionManager.createSession(user, hpc, ide, initialProperties);
  }

  async getOrCreateSession(user: string | null, hpc: string, ide: string): Promise<Session> {
    return this.sessionManager.getOrCreateSession(user, hpc, ide);
  }

  getSession(user: string | null, hpc: string, ide: string): Session | null {
    return this.sessionManager.getSession(user, hpc, ide);
  }

  async updateSession(user: string | null, hpc: string, ide: string, updates: Partial<Session>): Promise<Session> {
    return this.sessionManager.updateSession(user, hpc, ide, updates);
  }

  async clearSession(user: string | null, hpc: string, ide: string, options: ClearSessionOptions = {}): Promise<void> {
    return this.sessionManager.clearSession(user, hpc, ide, options);
  }

  getAllSessions(): Record<string, Session | null> {
    return this.sessionManager.getAllSessions();
  }

  getSessionsForUser(user: string | null): Record<string, Session | null> {
    return this.sessionManager.getSessionsForUser(user);
  }

  getActiveSessions(): Record<string, Session> {
    return this.sessionManager.getActiveSessions();
  }

  getActiveSessionsForUser(user: string | null): Record<string, Session> {
    return this.sessionManager.getActiveSessionsForUser(user);
  }

  hasActiveSession(user: string | null, hpc: string, ide: string): boolean {
    return this.sessionManager.hasActiveSession(user, hpc, ide);
  }

  getActiveSession(): ActiveSession | null {
    return this.sessionManager.getActiveSession();
  }

  async clearActiveSession(): Promise<void> {
    return this.sessionManager.clearActiveSession();
  }

  getState(): AppState {
    return this.sessionManager.getState();
  }

  async setActiveSession(user: string | null, hpc: string | null, ide: string | null): Promise<void> {
    return this.sessionManager.setActiveSession(user, hpc, ide);
  }

  async setActiveHpc(hpc: string | null): Promise<void> {
    return this.sessionManager.setActiveHpc(hpc);
  }

  // ============================================
  // User account cache
  // ============================================

  getUserAccount(user: string | null): string | null {
    const effectiveUser = user || config.hpcUser;
    const cached = this.userAccounts.get(effectiveUser);
    if (cached) {
      return cached.account;
    }
    return null;
  }

  async fetchUserAccount(user: string | null): Promise<string | null> {
    const effectiveUser = user || config.hpcUser;

    if (this.userAccounts.has(effectiveUser)) {
      return this.userAccounts.get(effectiveUser)!.account;
    }

    if (!this.hpcServiceFactory) return null;
    const clusterNames = Object.keys(clusters);
    if (clusterNames.length === 0) return null;

    try {
      const hpcService = this.hpcServiceFactory(clusterNames[0]);
      const account = await hpcService.getUserDefaultAccount(effectiveUser);
      this.userAccounts.set(effectiveUser, { account, fetchedAt: Date.now() });
      log.state('User account fetched', { user: effectiveUser, account });
      return account;
    } catch (e) {
      log.warn('Failed to fetch user account', { user: effectiveUser, ...errorDetails(e) });
      return null;
    }
  }

  // ============================================
  // Polling control
  // ============================================

  async startPolling(hpcServiceFactory: HpcServiceFactory): Promise<void> {
    this.pollingStopped = false;
    this.hpcServiceFactory = hpcServiceFactory;
    log.state('Starting background polling (jobs: adaptive, health: 30 min)');

    await this.fetchUserAccount(null);

    this.jobPoller.start();
    this.healthPoller.start();
  }

  stopPolling(): void {
    this.pollingStopped = true;
    this.jobPoller.stop();
    this.healthPoller.stop();
    log.state('Stopped background polling');
  }

  getOptimalJobPollInterval(): number {
    return this.jobPoller.getOptimalJobPollInterval();
  }

  getPollingInfo(): PollingInfo {
    return this.jobPoller.getPollingInfoWith(this.healthPoller.lastHealthPollTime);
  }

  // ============================================
  // Cluster health (delegates to ClusterHealthPoller)
  // ============================================

  getClusterHealth(): Record<string, ClusterHealthState> {
    return this.healthPoller.getClusterHealth();
  }

  getClusterHistory(options: { days?: number } = {}): Record<string, HealthHistoryEntry[]> {
    return this.healthPoller.getClusterHistory(options);
  }
}

// Re-export types and utilities for external consumers
export { StateManager };
export { POLLING_CONFIG, buildSessionKey, parseSessionKey, createIdleSession } from './state/types';
export type {
  HpcService,
  JobInfo,
  HpcServiceFactory,
  ParsedSessionKey,
  ActiveSession,
  ClusterHealthState,
  AppState,
  UserAccountCache,
  PollingInfo,
  ClearSessionOptions,
  Session,
  ClusterHealth,
  HealthHistoryEntry,
} from './state/types';

// CommonJS compatibility for existing require() calls
module.exports = { StateManager, POLLING_CONFIG, buildSessionKey, parseSessionKey, createIdleSession };
