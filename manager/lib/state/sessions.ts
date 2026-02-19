/**
 * SessionManager - in-memory session CRUD and active session tracking.
 * Extracted from StateManager for separation of concerns.
 */

import { config } from '../../config';
import { log } from '../logger';
import * as dbSessions from '../db/sessions';
import { buildSessionKey, parseSessionKey, createIdleSession } from './types';
import type { AppState, ActiveSession, Session, ClearSessionOptions } from './types';

export class SessionManager {
  constructor(
    private state: AppState,
    private useSqlite: boolean,
    private save: () => Promise<void>,
    private getOnSessionCleared: () => ((user: string, hpc: string, ide: string) => void) | null,
    private onTriggerFastPoll: () => void,
  ) {}

  /**
   * Clear activeSession if it matches the given user, hpc and ide
   */
  clearActiveSessionIfMatches(user: string | null, hpc: string, ide: string): void {
    const effectiveUser = user || config.hpcUser;
    if (
      this.state.activeSession?.user === effectiveUser &&
      this.state.activeSession?.hpc === hpc &&
      this.state.activeSession?.ide === ide
    ) {
      this.state.activeSession = null;
    }
  }

  /**
   * Create a new session with optional initial properties
   * Throws if session already exists (use getOrCreateSession for get-or-create pattern)
   */
  async createSession(user: string | null, hpc: string, ide: string, initialProperties: Partial<Session> = {}): Promise<Session> {
    const sessionKey = buildSessionKey(user, hpc, ide);
    log.state('Creating session', { sessionKey, user: user || config.hpcUser, hpc, ide });
    if (this.state.sessions[sessionKey]) {
      throw new Error(`Session already exists: ${sessionKey}`);
    }
    const newSession = createIdleSession(ide);
    newSession.user = user || config.hpcUser;
    this.state.sessions[sessionKey] = Object.assign(newSession, initialProperties);
    await this.save();
    return this.state.sessions[sessionKey]!;
  }

  /**
   * Get session, or create one if it doesn't exist
   */
  async getOrCreateSession(user: string | null, hpc: string, ide: string): Promise<Session> {
    const existing = this.getSession(user, hpc, ide);
    if (existing) {
      return existing;
    }

    try {
      return await this.createSession(user, hpc, ide);
    } catch (err) {
      if (err && typeof (err as Error).message === 'string' && (err as Error).message.includes('Session already exists')) {
        const session = this.getSession(user, hpc, ide);
        if (session) {
          return session;
        }
      }
      throw err;
    }
  }

  /**
   * Get session by user, hpc and ide
   */
  getSession(user: string | null, hpc: string, ide: string): Session | null {
    const sessionKey = buildSessionKey(user, hpc, ide);
    return this.state.sessions[sessionKey] || null;
  }

  /**
   * Update session and persist
   */
  async updateSession(user: string | null, hpc: string, ide: string, updates: Partial<Session>): Promise<Session> {
    const sessionKey = buildSessionKey(user, hpc, ide);
    const session = this.state.sessions[sessionKey];
    if (!session) {
      throw new Error(`No session exists: ${sessionKey}`);
    }
    log.state('Updating session', { sessionKey, fields: Object.keys(updates) });
    Object.assign(session, updates);
    await this.save();

    if (updates.status === 'pending') {
      this.onTriggerFastPoll();
    }

    return session;
  }

  /**
   * Clear (delete) session and archive to history
   */
  async clearSession(user: string | null, hpc: string, ide: string, options: ClearSessionOptions = {}): Promise<void> {
    const sessionKey = buildSessionKey(user, hpc, ide);
    const session = this.state.sessions[sessionKey];
    if (!session) {
      log.warn(`clearSession called for non-existent session: ${sessionKey}`);
      return;
    }

    if (this.useSqlite && session.startedAt) {
      const { endReason = 'completed', errorMessage = null } = options;
      try {
        dbSessions.archiveSession(session, sessionKey, endReason, errorMessage);
        dbSessions.deleteActiveSession(sessionKey, { archive: false });
      } catch (err) {
        log.error('Failed to archive session to history', { sessionKey, ...{ detail: String(err) } });
      }
    }

    this.clearActiveSessionIfMatches(user, hpc, ide);
    delete this.state.sessions[sessionKey];
    await this.save();

    const cb = this.getOnSessionCleared();
    if (cb) {
      cb(user || config.hpcUser, hpc, ide);
    }
  }

  /**
   * Get all sessions (shallow copy)
   */
  getAllSessions(): Record<string, Session | null> {
    return { ...this.state.sessions };
  }

  /**
   * Get all sessions for a specific user
   */
  getSessionsForUser(user: string | null): Record<string, Session | null> {
    const effectiveUser = user || config.hpcUser;
    return Object.fromEntries(
      Object.entries(this.state.sessions).filter(([key]) => {
        const parsed = parseSessionKey(key);
        return parsed && parsed.user === effectiveUser;
      })
    );
  }

  /**
   * Get active sessions (running or pending only)
   */
  getActiveSessions(): Record<string, Session> {
    return Object.fromEntries(
      Object.entries(this.state.sessions).filter(
        ([, session]) => session && (session.status === 'running' || session.status === 'pending')
      )
    ) as Record<string, Session>;
  }

  /**
   * Get active sessions for a specific user
   */
  getActiveSessionsForUser(user: string | null): Record<string, Session> {
    const userSessions = this.getSessionsForUser(user);
    return Object.fromEntries(
      Object.entries(userSessions).filter(
        ([, session]) => session && (session.status === 'running' || session.status === 'pending')
      )
    ) as Record<string, Session>;
  }

  /**
   * Check if a session exists and is active
   */
  hasActiveSession(user: string | null, hpc: string, ide: string): boolean {
    const session = this.getSession(user, hpc, ide);
    return !!(session && (session.status === 'running' || session.status === 'pending'));
  }

  /**
   * Get the active session reference
   */
  getActiveSession(): ActiveSession | null {
    return this.state.activeSession;
  }

  /**
   * Clear the active session reference
   */
  async clearActiveSession(): Promise<void> {
    this.state.activeSession = null;
    await this.save();
  }

  /**
   * Get current state (for API responses)
   */
  getState(): AppState {
    return this.state;
  }

  /**
   * Set active session and persist
   */
  async setActiveSession(user: string | null, hpc: string | null, ide: string | null): Promise<void> {
    const effectiveUser = user || config.hpcUser;
    this.state.activeSession = hpc && ide ? { user: effectiveUser, hpc, ide } : null;
    await this.save();
  }

  /**
   * @deprecated Use setActiveSession instead
   */
  async setActiveHpc(hpc: string | null): Promise<void> {
    if (!hpc) {
      this.state.activeSession = null;
    }
    await this.save();
  }
}
