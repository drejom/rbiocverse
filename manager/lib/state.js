/**
 * State persistence and reconciliation
 * Prevents orphaned processes after container restarts
 *
 * Architecture:
 * - StateManager is the single source of truth for session state
 * - Backend polling updates state at adaptive intervals
 * - API endpoints read from cached state (instant, no SSH)
 * - Sessions use composite keys: user-hpc-ide (e.g., domeally-gemini-vscode)
 * - For single-user mode, user defaults to config.hpcUser
 */

const fs = require('fs').promises;
const path = require('path');
const { LockError } = require('./errors');
const { log } = require('./logger');
const { clusters, config } = require('../config');
const { initializeDb, getDb } = require('./db');
const dbSessions = require('./db/sessions');
const dbHealth = require('./db/health');
const { checkAndMigrate } = require('./db/migrate');

/**
 * Build session key from components
 * Format: user-hpc-ide (e.g., domeally-gemini-vscode)
 * @param {string} user - Username (defaults to config.hpcUser for single-user mode)
 * @param {string} hpc - Cluster name
 * @param {string} ide - IDE type
 * @returns {string} Session key
 */
function buildSessionKey(user, hpc, ide) {
  const effectiveUser = user || config.hpcUser;
  return `${effectiveUser}-${hpc}-${ide}`;
}

/**
 * Parse session key into components
 * Format: user-hpc-ide (e.g., domeally-gemini-vscode)
 * @param {string} sessionKey - Session key
 * @returns {{user: string, hpc: string, ide: string}|null} Parsed components or null
 */
function parseSessionKey(sessionKey) {
  const parts = sessionKey.split('-');
  if (parts.length >= 3) {
    // user-hpc-ide format (user may contain hyphens)
    // IDE is always last, HPC is second-to-last, user is everything before
    const ide = parts.pop();
    const hpc = parts.pop();
    const user = parts.join('-');
    return { user, hpc, ide };
  }
  return null;
}

// Time constants
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Polling configuration
 *
 * Two independent polling loops:
 * 1. Job polling (adaptive) - checks job status, interval varies by job state
 * 2. Health polling (fixed) - checks cluster health every 30 minutes
 *
 * Job polling uses batch queries: 1 SSH call per cluster (parallel) via getAllJobs()
 * This scales well regardless of number of active sessions.
 */
const POLLING_CONFIG = {
  // Job polling: adaptive based on job state
  JOB_POLLING: {
    // Time thresholds (seconds) for determining polling frequency
    THRESHOLDS_SECONDS: {
      NEAR_EXPIRY: 600, // 10 min - jobs about to expire
      APPROACHING_END: 1800, // 30 min - jobs approaching end
      MODERATE: 3600, // 1 hr - moderate time remaining
      STABLE: 21600, // 6 hr - long-running stable jobs
    },
    // Polling intervals (milliseconds) for each state
    INTERVALS_MS: {
      FREQUENT: 15000, // 15s - for pending jobs or near expiry
      MODERATE: 60000, // 1m - for jobs approaching end
      RELAXED: 300000, // 5m - for jobs with 30min-1hr left
      INFREQUENT: 600000, // 10m - for jobs with 1-6hr left
      IDLE: 1800000, // 30m - for very stable jobs or no sessions
      MAX: 3600000, // 1hr - absolute maximum interval
    },
    // Exponential backoff configuration
    BACKOFF: {
      START_THRESHOLD: 3, // Apply backoff after 3 unchanged polls
      MULTIPLIER: 1.5, // Multiply interval by 1.5x each time
      MAX_EXPONENT: 3, // Cap exponent at 3 (max multiplier: 3.375x)
    },
  },
  // Health polling: fixed interval (independent of job state)
  HEALTH_POLLING: {
    INTERVAL_MS: 30 * 60 * 1000, // 30 minutes
  },
};

/**
 * Create a fresh idle session object
 * Use this to ensure consistent session structure across the codebase
 * @param {string} ide - IDE type ('vscode', 'rstudio', 'jupyter')
 * @returns {Object} Fresh idle session
 */
function createIdleSession(ide) {
  return {
    status: 'idle',
    ide: ide,
    jobId: null,
    node: null,
    tunnelProcess: null,
    startedAt: null,
    cpus: null,
    memory: null,
    walltime: null,
    error: null,
    lastActivity: null,
    token: null,
    releaseVersion: null,
    gpu: null,
  };
}

class StateManager {
  constructor() {
    // Read environment variables at construction time (not module load time)
    this.stateFile = process.env.STATE_FILE || '/data/state.json';
    this.enablePersistence = process.env.ENABLE_STATE_PERSISTENCE === 'true';

    // Use SQLite by default (can be disabled for testing)
    this.useSqlite = process.env.USE_SQLITE !== 'false';

    // Dynamic session keys: gemini-vscode, apollo-jupyter, etc.
    // No hardcoded cluster names - keys created on demand
    this.state = {
      sessions: {},
      activeSession: null, // { hpc, ide } or null
    };

    // Operation locks to prevent race conditions
    this.locks = new Map();

    // Ready flag - set to true after load() completes
    this.ready = false;

    // Job polling state (adaptive)
    this.jobPollTimer = null;
    this.consecutiveUnchangedPolls = 0;
    this.lastStateSnapshot = null;
    this.lastJobPollTime = null;
    this.nextJobPollTime = null;

    // Health polling state (fixed interval)
    this.healthPollTimer = null;
    this.lastHealthPollTime = null;

    // Global polling control flag
    this.pollingStopped = false;

    this.hpcServiceFactory = null; // Function: (hpc) => HpcService instance

    // Per-user SLURM accounts (fetched on first access for fairshare queries)
    // Map: username -> { account, fetchedAt }
    this.userAccounts = new Map();

    // Callback for when sessions are cleared (for tunnel cleanup)
    // Signature: (user, hpc, ide) => void
    this.onSessionCleared = null;
  }

  /**
   * Check if state manager is ready (loaded)
   * @returns {boolean}
   */
  isReady() {
    return this.ready;
  }

  /**
   * Acquire lock for an operation
   * @param {string} operation - Lock name (e.g., 'launch:gemini')
   * @throws {Error} If lock already held
   */
  acquireLock(operation) {
    if (this.locks.has(operation)) {
      throw new LockError('Operation already in progress', { operation });
    }
    this.locks.set(operation, Date.now());
    log.lock(`Acquired: ${operation}`);
  }

  /**
   * Release lock for an operation
   * @param {string} operation - Lock name
   */
  releaseLock(operation) {
    if (this.locks.has(operation)) {
      const held = Date.now() - this.locks.get(operation);
      log.lock(`Released: ${operation}`, { heldMs: held });
      this.locks.delete(operation);
    }
  }

  /**
   * Check if lock is held
   * @param {string} operation - Lock name
   * @returns {boolean}
   */
  isLocked(operation) {
    return this.locks.has(operation);
  }

  /**
   * Get all active locks (for debugging)
   * @returns {Array} Active lock names
   */
  getActiveLocks() {
    return Array.from(this.locks.keys());
  }

  /**
   * Load state from disk/database on startup
   * Reconcile with squeue to detect orphaned jobs
   */
  async load() {
    // Initialize SQLite database and run migration if needed
    if (this.useSqlite) {
      try {
        initializeDb();
        checkAndMigrate();
        log.state('SQLite database initialized');
      } catch (err) {
        log.error('Failed to initialize SQLite database', { error: err.message });
        // Fall back to JSON persistence
        this.useSqlite = false;
      }
    }

    if (!this.enablePersistence && !this.useSqlite) {
      this.ready = true;
      return;
    }

    // Load from SQLite if enabled
    if (this.useSqlite) {
      try {
        // Load active sessions from database
        const dbActiveSessions = dbSessions.getAllActiveSessions();
        for (const [key, session] of Object.entries(dbActiveSessions)) {
          this.state.sessions[key] = session;
        }

        // Load active session reference from app_state
        const db = getDb();
        const activeRow = db.prepare('SELECT value FROM app_state WHERE key = ?').get('activeSession');
        if (activeRow?.value) {
          this.state.activeSession = JSON.parse(activeRow.value);
        }

        // Load cluster health from database
        const clusterCaches = dbHealth.getAllClusterCaches();
        this.state.clusterHealth = {};
        for (const [hpc, cache] of Object.entries(clusterCaches)) {
          this.state.clusterHealth[hpc] = {
            current: cache,
            history: [], // History is now in database, not in-memory
            consecutiveFailures: cache.consecutiveFailures || 0,
          };
        }

        log.state('Loaded state from SQLite', {
          sessionKeys: Object.keys(this.state.sessions),
          activeSession: this.state.activeSession,
        });
      } catch (err) {
        log.error('Failed to load from SQLite', { error: err.message });
      }
    }

    // Also try loading from JSON file for backwards compatibility
    if (this.enablePersistence) {
      try {
        const data = await fs.readFile(this.stateFile, 'utf8');
        const loadedState = JSON.parse(data);
        log.state('Loaded from disk', {
          file: this.stateFile,
          sessionKeys: Object.keys(loadedState.sessions || {}),
          activeSession: loadedState.activeSession,
        });

        // Migrate from old activeHpc to new activeSession format
        if (loadedState.activeHpc && !loadedState.activeSession) {
          loadedState.activeSession = null;
          delete loadedState.activeHpc;
        }

        // Ensure sessions object exists
        if (!loadedState.sessions) {
          loadedState.sessions = {};
        }

        // Only use JSON data if SQLite didn't load anything
        if (Object.keys(this.state.sessions).length === 0) {
          this.state.activeSession = loadedState.activeSession ?? null;
          this.state.clusterHealth = loadedState.clusterHealth ?? {};

          for (const [key, session] of Object.entries(loadedState.sessions)) {
            let sessionKey = key;
            // TODO: Remove this migration before v0.1.0 release
            // Migrate legacy keys without user prefix (e.g., "gemini-vscode" -> "{user}-gemini-vscode")
            if (!parseSessionKey(key)) {
              sessionKey = `${config.hpcUser}-${key}`;
              log.warn('Migrating legacy session key', { old: key, new: sessionKey });
              if (!parseSessionKey(sessionKey)) {
                log.warn('Skipping invalid session key', { key });
                continue;
              }
            }
            if (session) {
              session.tunnelProcess = null;
            }
            this.state.sessions[sessionKey] = session;
          }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') {
          log.error('Failed to load state from JSON', { error: e.message });
        }
      }
    }

    await this.reconcile();
    this.ready = true;
  }

  /**
   * Save state to disk/database after every change
   * Excludes non-serializable fields like tunnelProcess
   */
  async save() {
    // Save to SQLite if enabled
    if (this.useSqlite) {
      try {
        // Save active sessions to database
        for (const [sessionKey, session] of Object.entries(this.state.sessions)) {
          if (session) {
            dbSessions.saveActiveSession(sessionKey, session);
          }
        }

        // Save active session reference
        const db = getDb();
        db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
          .run('activeSession', JSON.stringify(this.state.activeSession));

      } catch (err) {
        log.error('Failed to save to SQLite', { error: err.message });
      }
    }

    // Also save to JSON file if persistence is enabled
    if (!this.enablePersistence) return;
    log.state('Saving state to disk', {
      file: this.stateFile,
      sessionKeys: Object.keys(this.state.sessions),
      activeSession: this.state.activeSession,
    });

    try {
      const dir = path.dirname(this.stateFile);
      await fs.mkdir(dir, { recursive: true });

      // Create a clean copy without non-serializable fields
      const cleanState = {
        activeSession: this.state.activeSession,
        clusterHealth: this.state.clusterHealth || {},
        sessions: {},
      };

      for (const [sessionKey, session] of Object.entries(this.state.sessions)) {
        if (session) {
          // Exclude tunnelProcess - it's a process handle that can't be serialized
          const { tunnelProcess, ...rest } = session;
          cleanState.sessions[sessionKey] = rest;
        } else {
          cleanState.sessions[sessionKey] = null;
        }
      }

      await fs.writeFile(this.stateFile, JSON.stringify(cleanState, null, 2));
    } catch (e) {
      log.error('Failed to save state', { error: e.message });
    }
  }

  /**
   * Reconcile state with reality
   * Check if "running" jobs still exist in squeue
   * Mark as idle if job no longer exists
   */
  async reconcile() {
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
          this._clearActiveSessionIfMatches(user, hpc, ide);
          delete this.state.sessions[sessionKey];
          // Notify listener (e.g., for tunnel cleanup)
          if (this.onSessionCleared) {
            this.onSessionCleared(user, hpc, ide);
          }
        }
      }
    }
    await this.save();
  }

  /**
   * Check if job exists in squeue
   * Uses injected hpcServiceFactory if available
   * @param {string} hpc - Cluster name (gemini, apollo)
   * @param {string} jobId - SLURM job ID
   * @returns {Promise<boolean>} True if job exists
   */
  async checkJobExists(hpc, jobId) {
    if (!this.hpcServiceFactory) {
      // No HPC service factory - assume job exists (safer than prematurely clearing)
      return true;
    }

    try {
      const hpcService = this.hpcServiceFactory(hpc);
      return await hpcService.checkJobExists(jobId);
    } catch (e) {
      log.warn('Failed to check job existence, assuming exists', { hpc, jobId, error: e.message });
      return true; // Safe fallback
    }
  }

  // ============================================
  // Private helper methods
  // ============================================

  /**
   * Clear activeSession if it matches the given user, hpc and ide
   * @param {string} user - Username (null for default/single-user mode)
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   * @private
   */
  _clearActiveSessionIfMatches(user, hpc, ide) {
    const effectiveUser = user || config.hpcUser;
    if (
      this.state.activeSession?.user === effectiveUser &&
      this.state.activeSession?.hpc === hpc &&
      this.state.activeSession?.ide === ide
    ) {
      this.state.activeSession = null;
    }
  }

  // ============================================
  // Session access methods (user, hpc, ide based)
  // ============================================

  /**
   * Create a new session with optional initial properties
   * Throws if session already exists (use getOrCreateSession for get-or-create pattern)
   * @param {string} user - Username (null for default/single-user mode)
   * @param {string} hpc - Cluster name (gemini, apollo)
   * @param {string} ide - IDE type (vscode, jupyter, rstudio)
   * @param {Object} initialProperties - Optional initial values to merge
   * @returns {Promise<Object>} The created session
   * @throws {Error} If session already exists
   */
  async createSession(user, hpc, ide, initialProperties = {}) {
    const sessionKey = buildSessionKey(user, hpc, ide);
    log.state('Creating session', { sessionKey, user: user || config.hpcUser, hpc, ide });
    if (this.state.sessions[sessionKey]) {
      throw new Error(`Session already exists: ${sessionKey}`);
    }
    const newSession = createIdleSession(ide);
    newSession.user = user || config.hpcUser;  // Store user in session
    this.state.sessions[sessionKey] = Object.assign(newSession, initialProperties);
    await this.save();
    return this.state.sessions[sessionKey];
  }

  /**
   * Get session, or create one if it doesn't exist
   * Handles race condition where concurrent callers may try to create simultaneously
   * @param {string} user - Username (null for default/single-user mode)
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   * @returns {Promise<Object>} The existing or newly created session
   */
  async getOrCreateSession(user, hpc, ide) {
    const existing = this.getSession(user, hpc, ide);
    if (existing) {
      return existing;
    }

    try {
      // Attempt to create the session. This may race with another caller.
      return await this.createSession(user, hpc, ide);
    } catch (err) {
      // If another concurrent caller created the session first, gracefully return it.
      if (err && typeof err.message === 'string' && err.message.includes('Session already exists')) {
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
   * @param {string} user - Username (null for default/single-user mode)
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   * @returns {Object|null} Session or null
   */
  getSession(user, hpc, ide) {
    const sessionKey = buildSessionKey(user, hpc, ide);
    return this.state.sessions[sessionKey] || null;
  }

  /**
   * Update session and persist
   * @param {string} user - Username (null for default/single-user mode)
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated session
   * @throws {Error} If session doesn't exist
   */
  async updateSession(user, hpc, ide, updates) {
    const sessionKey = buildSessionKey(user, hpc, ide);
    const session = this.state.sessions[sessionKey];
    if (!session) {
      throw new Error(`No session exists: ${sessionKey}`);
    }
    log.state('Updating session', { sessionKey, fields: Object.keys(updates) });
    Object.assign(session, updates);
    await this.save();
    return session;
  }

  /**
   * Clear (delete) session and archive to history
   * @param {string} user - Username (null for default/single-user mode)
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   * @param {Object} [options] - Optional archive options
   * @param {string} [options.endReason='completed'] - completed, cancelled, timeout, error
   * @param {string} [options.errorMessage] - Error message if applicable
   */
  async clearSession(user, hpc, ide, options = {}) {
    const sessionKey = buildSessionKey(user, hpc, ide);
    const session = this.state.sessions[sessionKey];
    if (!session) {
      log.warn(`clearSession called for non-existent session: ${sessionKey}`);
      return;
    }

    // Archive to SQLite history before deleting
    // Archive if session was ever started (has startedAt), regardless of current status
    // Sessions transition to 'idle' before clearSession is called, so we can't check status
    if (this.useSqlite && session.startedAt) {
      const { endReason = 'completed', errorMessage = null } = options;
      try {
        dbSessions.archiveSession(session, sessionKey, endReason, errorMessage);
        // Also delete from active_sessions table
        dbSessions.deleteActiveSession(sessionKey, { archive: false }); // Already archived above
      } catch (err) {
        log.error('Failed to archive session to history', { sessionKey, error: err.message });
      }
    }

    this._clearActiveSessionIfMatches(user, hpc, ide);
    delete this.state.sessions[sessionKey];
    await this.save();

    // Notify listener (e.g., for tunnel cleanup)
    if (this.onSessionCleared) {
      this.onSessionCleared(user, hpc, ide);
    }
  }

  /**
   * Get all sessions (shallow copy)
   * @returns {Object} All sessions keyed by sessionKey
   */
  getAllSessions() {
    return { ...this.state.sessions };
  }

  /**
   * Get all sessions for a specific user
   * @param {string} user - Username (null for default/single-user mode)
   * @returns {Object} Sessions for user keyed by sessionKey
   */
  getSessionsForUser(user) {
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
   * @returns {Object} Active sessions keyed by sessionKey
   */
  getActiveSessions() {
    return Object.fromEntries(
      Object.entries(this.state.sessions).filter(
        ([, session]) => session && (session.status === 'running' || session.status === 'pending')
      )
    );
  }

  /**
   * Get active sessions for a specific user
   * @param {string} user - Username (null for default/single-user mode)
   * @returns {Object} Active sessions for user
   */
  getActiveSessionsForUser(user) {
    const userSessions = this.getSessionsForUser(user);
    return Object.fromEntries(
      Object.entries(userSessions).filter(
        ([, session]) => session && (session.status === 'running' || session.status === 'pending')
      )
    );
  }

  /**
   * Check if a session exists and is active
   * @param {string} user - Username (null for default/single-user mode)
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   * @returns {boolean}
   */
  hasActiveSession(user, hpc, ide) {
    const session = this.getSession(user, hpc, ide);
    return !!(session && (session.status === 'running' || session.status === 'pending'));
  }

  /**
   * Get the active session reference
   * @returns {Object|null} { user, hpc, ide } or null
   */
  getActiveSession() {
    return this.state.activeSession;
  }

  /**
   * Clear the active session reference
   */
  async clearActiveSession() {
    this.state.activeSession = null;
    await this.save();
  }

  /**
   * Get current state (for API responses)
   * @returns {Object} Current state
   */
  getState() {
    return this.state;
  }

  /**
   * Set active session and persist
   * @param {string} user - Username (null for default/single-user mode)
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   */
  async setActiveSession(user, hpc, ide) {
    const effectiveUser = user || config.hpcUser;
    this.state.activeSession = hpc && ide ? { user: effectiveUser, hpc, ide } : null;
    await this.save();
  }

  /**
   * @deprecated Use setActiveSession instead
   */
  async setActiveHpc(hpc) {
    // For backwards compatibility, just clear activeSession if hpc is null
    if (!hpc) {
      this.state.activeSession = null;
    }
    await this.save();
  }

  // ============================================
  // User account methods (for fairshare queries)
  // ============================================

  /**
   * Get user's SLURM default account from cache
   * Note: This only reads from cache. Use fetchUserAccount() to populate cache.
   * @param {string} user - Username (null for default/single-user mode)
   * @returns {string|null} Account name or null if not cached
   */
  getUserAccount(user) {
    const effectiveUser = user || config.hpcUser;
    const cached = this.userAccounts.get(effectiveUser);
    if (cached) {
      return cached.account;
    }
    return null;  // Not fetched yet - use fetchUserAccount() to populate
  }

  /**
   * Fetch and cache user's SLURM default account
   * @param {string} user - Username (null for default/single-user mode)
   * @returns {Promise<string|null>} Account name or null
   */
  async fetchUserAccount(user) {
    const effectiveUser = user || config.hpcUser;

    // Check cache first
    if (this.userAccounts.has(effectiveUser)) {
      return this.userAccounts.get(effectiveUser).account;
    }

    // Fetch from cluster
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
      log.warn('Failed to fetch user account', { user: effectiveUser, error: e.message });
      return null;
    }
  }

  // ============================================
  // Polling methods (Phase 2)
  // ============================================

  /**
   * Start background polling for session status and cluster health
   *
   * Two independent polling loops:
   * 1. Job polling (adaptive) - 1 SSH call per cluster via getAllJobs()
   * 2. Health polling (fixed 30 min) - 1 SSH call per cluster via getClusterHealth()
   *
   * On startup, fetches current user's default SLURM account (once) for fairshare queries.
   *
   * @param {Function} hpcServiceFactory - Factory function: (hpc) => HpcService instance
   */
  async startPolling(hpcServiceFactory) {
    this.pollingStopped = false;
    this.hpcServiceFactory = hpcServiceFactory;
    log.state('Starting background polling (jobs: adaptive, health: 30 min)');

    // Fetch current user's default account on startup (for fairshare queries)
    await this.fetchUserAccount(null);  // null = config.hpcUser

    // Start job polling immediately
    this.scheduleJobPoll();

    // Start health polling - check if ALL clusters have fresh AND successful cached data
    const { INTERVAL_MS } = POLLING_CONFIG.HEALTH_POLLING;
    const clusterNames = Object.keys(clusters);
    const allClustersHaveFreshHealth = clusterNames.length > 0 &&
      clusterNames.every(hpc => {
        const h = this.state.clusterHealth?.[hpc];
        // Require fresh data AND online status - refresh if any cluster is offline/errored
        return h?.current?.lastChecked &&
               h?.current?.online !== false &&
               (Date.now() - h.current.lastChecked) < INTERVAL_MS;
      });

    if (allClustersHaveFreshHealth) {
      log.state('Using cached cluster health data (all clusters < 30 min old)');
      // Schedule next health poll after remaining TTL of oldest cluster
      const oldestCheck = Math.min(
        ...clusterNames
          .map(hpc => this.state.clusterHealth[hpc]?.current?.lastChecked)
          .filter(ts => ts)
      );
      const elapsed = Date.now() - oldestCheck;
      const remaining = Math.max(INTERVAL_MS - elapsed, 1000);
      this.healthPollTimer = setTimeout(() => this.healthPoll(), remaining);
    } else {
      // Fetch cluster health immediately - at least one cluster needs refresh
      this.healthPoll();
    }
  }

  /**
   * Stop background polling (both job and health)
   */
  stopPolling() {
    this.pollingStopped = true;
    if (this.jobPollTimer) {
      clearTimeout(this.jobPollTimer);
      this.jobPollTimer = null;
    }
    if (this.healthPollTimer) {
      clearTimeout(this.healthPollTimer);
      this.healthPollTimer = null;
    }
    log.state('Stopped background polling');
  }

  /**
   * Schedule next job poll with adaptive interval
   */
  scheduleJobPoll() {
    if (this.pollingStopped) return;
    const interval = this.getOptimalJobPollInterval();
    this.nextJobPollTime = Date.now() + interval;
    this.jobPollTimer = setTimeout(() => this.jobPoll(), interval);
    log.debugFor('state', `Next job poll in ${Math.round(interval / 1000)}s`);
  }

  /**
   * Execute a job poll cycle
   * Uses batch queries: 1 SSH call per cluster (parallel) via getAllJobs()
   * Error-safe: always reschedules even if refresh fails
   */
  async jobPoll() {
    this.lastJobPollTime = Date.now();

    try {
      const changed = await this.refreshAllSessions();

      if (changed) {
        this.consecutiveUnchangedPolls = 0;
        log.debugFor('state', 'Job poll detected changes, resetting backoff');
      } else {
        this.consecutiveUnchangedPolls++;
        log.debugFor('state', `No job changes for ${this.consecutiveUnchangedPolls} polls`);
      }
    } catch (e) {
      log.error('Job poll cycle failed', { error: e.message });
    } finally {
      this.scheduleJobPoll();
    }
  }

  /**
   * Execute a health poll cycle (fixed 30-min interval)
   * 1 SSH call per cluster (parallel) via getClusterHealth()
   */
  async healthPoll() {
    this.lastHealthPollTime = Date.now();

    try {
      await this.refreshClusterHealth();
    } catch (e) {
      log.error('Health poll cycle failed', { error: e.message });
    } finally {
      if (this.pollingStopped) return;
      // Always schedule next health poll at fixed interval
      const { INTERVAL_MS } = POLLING_CONFIG.HEALTH_POLLING;
      this.healthPollTimer = setTimeout(() => this.healthPoll(), INTERVAL_MS);
      log.debugFor('state', `Next health poll in ${Math.round(INTERVAL_MS / 60000)} min`);
    }
  }

  /**
   * Refresh all sessions from SLURM using batch queries
   * 1 SSH call per cluster (parallel) via getAllJobs()
   * Scales efficiently regardless of number of active sessions
   *
   * @returns {Promise<boolean>} True if significant changes detected (for backoff reset)
   */
  async refreshAllSessions() {
    if (!this.hpcServiceFactory) return false;

    let significantChange = false;
    const snapshotBefore = JSON.stringify(this.state.sessions);

    // Fetch all jobs from all clusters in parallel (1 SSH call per cluster)
    const clusterNames = Object.keys(clusters);
    const jobResults = await Promise.all(
      clusterNames.map(async (hpc) => {
        try {
          const hpcService = this.hpcServiceFactory(hpc);
          const jobs = await hpcService.getAllJobs();
          return { hpc, jobs, error: null };
        } catch (e) {
          log.warn('Failed to fetch jobs from cluster', { hpc, error: e.message });
          return { hpc, jobs: {}, error: e.message };
        }
      })
    );

    // Build a map of cluster -> ide -> jobInfo from batch results
    const jobsByCluster = {};
    for (const { hpc, jobs } of jobResults) {
      jobsByCluster[hpc] = jobs;
    }

    // Update each session from batch results
    for (const [sessionKey, session] of Object.entries(this.state.sessions)) {
      if (!session || !session.jobId) continue;
      if (session.status !== 'running' && session.status !== 'pending') continue;

      const parsed = parseSessionKey(sessionKey);
      if (!parsed) {
        log.warn('Failed to parse session key during refresh', { sessionKey });
        continue;
      }
      const { user, hpc, ide } = parsed;
      const clusterJobs = jobsByCluster[hpc] || {};
      const jobInfo = clusterJobs[ide];

      // Check if our job is still in the batch results
      // Note: getAllJobs filters by job name and states (R,PD only), so ended jobs won't appear
      if (!jobInfo || jobInfo.jobId !== session.jobId) {
        // Job no longer exists or is a different job
        log.state(`Job ${session.jobId} no longer in squeue`, { sessionKey });
        this._clearActiveSessionIfMatches(user, hpc, ide);
        this.state.sessions[sessionKey] = null;
        significantChange = true;
        continue;
      }

      // Update session with fresh data from SLURM
      if (jobInfo.state === 'RUNNING' && session.status !== 'running') {
        session.status = 'running';
        session.node = jobInfo.node;
        significantChange = true;
      } else if (jobInfo.state === 'PENDING' && session.status !== 'pending') {
        session.status = 'pending';
        significantChange = true;
      }
      // Note: Terminal states (COMPLETED, FAILED, etc.) won't appear in getAllJobs
      // results since it filters by --states=R,PD. Ended jobs are caught above.

      // Update time remaining (not a significant change for backoff purposes)
      if (jobInfo.timeLeftSeconds !== undefined) {
        session.timeLeftSeconds = jobInfo.timeLeftSeconds;
      }
    }

    // Save if any modification occurred (including timeLeftSeconds updates)
    const snapshotAfter = JSON.stringify(this.state.sessions);
    if (snapshotBefore !== snapshotAfter) {
      await this.save();
    }

    // Also detect external state changes between polls (for backoff reset)
    if (!significantChange && snapshotBefore !== this.lastStateSnapshot) {
      significantChange = true;
    }
    this.lastStateSnapshot = snapshotAfter;

    return significantChange;
  }

  /**
   * Calculate optimal job polling interval based on session state and backoff
   * @returns {number} Interval in milliseconds
   */
  getOptimalJobPollInterval() {
    const { THRESHOLDS_SECONDS, INTERVALS_MS, BACKOFF } = POLLING_CONFIG.JOB_POLLING;

    let hasPending = false;
    let minTimeLeft = Infinity;
    let hasAnySessions = false;

    for (const session of Object.values(this.state.sessions)) {
      if (!session) continue;

      if (session.status === 'pending') {
        hasPending = true;
        hasAnySessions = true;
      } else if (session.status === 'running') {
        hasAnySessions = true;
        const timeLeft = session.timeLeftSeconds || Infinity;
        if (timeLeft < minTimeLeft) {
          minTimeLeft = timeLeft;
        }
      }
    }

    // Pending jobs need frequent updates
    if (hasPending) {
      return INTERVALS_MS.FREQUENT;
    }

    // No sessions - very infrequent polling
    if (!hasAnySessions) {
      return INTERVALS_MS.IDLE;
    }

    // Determine base interval from time remaining
    let baseInterval;
    if (minTimeLeft < THRESHOLDS_SECONDS.NEAR_EXPIRY) {
      baseInterval = INTERVALS_MS.FREQUENT;
    } else if (minTimeLeft < THRESHOLDS_SECONDS.APPROACHING_END) {
      baseInterval = INTERVALS_MS.MODERATE;
    } else if (minTimeLeft < THRESHOLDS_SECONDS.MODERATE) {
      baseInterval = INTERVALS_MS.RELAXED;
    } else if (minTimeLeft < THRESHOLDS_SECONDS.STABLE) {
      baseInterval = INTERVALS_MS.INFREQUENT;
    } else {
      baseInterval = INTERVALS_MS.IDLE;
    }

    // Apply exponential backoff if no changes detected
    if (this.consecutiveUnchangedPolls >= BACKOFF.START_THRESHOLD) {
      const exponent = Math.min(
        this.consecutiveUnchangedPolls - BACKOFF.START_THRESHOLD + 1,
        BACKOFF.MAX_EXPONENT
      );
      const backoffMultiplier = Math.pow(BACKOFF.MULTIPLIER, exponent);
      const backedOffInterval = baseInterval * backoffMultiplier;
      return Math.min(backedOffInterval, INTERVALS_MS.MAX);
    }

    return baseInterval;
  }

  /**
   * Get polling info for API responses
   * @returns {Object} Polling metadata
   */
  getPollingInfo() {
    return {
      jobPolling: {
        lastPollTime: this.lastJobPollTime,
        nextPollTime: this.nextJobPollTime,
        consecutiveUnchangedPolls: this.consecutiveUnchangedPolls,
        currentInterval: this.getOptimalJobPollInterval(),
      },
      healthPolling: {
        lastPollTime: this.lastHealthPollTime,
        interval: POLLING_CONFIG.HEALTH_POLLING.INTERVAL_MS,
      },
    };
  }

  // ============================================
  // Cluster Health Methods
  // ============================================

  /**
   * Refresh cluster health for all clusters
   * Called from healthPoll() on fixed 30-min interval
   * 1 SSH call per cluster (parallel) via getClusterHealth()
   */
  async refreshClusterHealth() {
    if (!this.hpcServiceFactory) return;

    const now = Date.now();

    // Initialize clusterHealth if needed
    if (!this.state.clusterHealth) {
      this.state.clusterHealth = {};
    }

    // Refresh health for each cluster in parallel
    const clusterNames = Object.keys(clusters);

    // Initialize all cluster health objects first
    for (const hpc of clusterNames) {
      if (!this.state.clusterHealth[hpc]) {
        this.state.clusterHealth[hpc] = {
          current: null,
          history: [],
          lastRolloverAt: 0,
          consecutiveFailures: 0,
        };
      }
    }

    // Fetch health from all clusters in parallel
    // Pass userAccount for fairshare query (use current user's cached account)
    const userAccount = this.getUserAccount(null);  // null = config.hpcUser
    const healthPromises = clusterNames.map(async (hpc) => {
      try {
        const hpcService = this.hpcServiceFactory(hpc);
        const health = await hpcService.getClusterHealth({ userAccount });

        // Reset failure counter on success
        this.state.clusterHealth[hpc].consecutiveFailures = 0;

        // Update current health
        this.state.clusterHealth[hpc].current = health;

        // Save to SQLite if enabled
        if (this.useSqlite) {
          try {
            dbHealth.saveClusterCache(hpc, health);
            // Also save health snapshot to history
            if (health.online && health.cpus && health.memory && health.nodes) {
              dbHealth.addHealthSnapshot(hpc, health);
            }
          } catch (err) {
            log.error('Failed to save cluster health to SQLite', { hpc, error: err.message });
          }
        }

        // Append to in-memory history (only if online and health data is valid)
        // Use pre-calculated percentages from hpc.js
        if (health.online && health.cpus && health.memory && health.nodes) {
          this.state.clusterHealth[hpc].history.push({
            timestamp: now,
            cpus: health.cpus.percent ?? 0,
            memory: health.memory.percent ?? 0,
            nodes: health.nodes.percent ?? 0,
            gpus: health.gpus?.percent ?? null,
          });

          // Throttle rollover to avoid repeated file I/O (at most once per hour)
          // Skip if using SQLite (history is in database)
          if (!this.useSqlite) {
            const ROLLOVER_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
            const lastRolloverAt = this.state.clusterHealth[hpc].lastRolloverAt || 0;
            if (now - lastRolloverAt >= ROLLOVER_MIN_INTERVAL_MS) {
              await this.rolloverHealthHistory(hpc);
              this.state.clusterHealth[hpc].lastRolloverAt = now;
            }
          }
        }

        log.debugFor('state', `Cluster health refreshed: ${hpc}`, {
          cpus: health.cpus?.percent,
          memory: health.memory?.percent,
          nodes: health.nodes,
        });
      } catch (e) {
        // Track consecutive failures
        this.state.clusterHealth[hpc].consecutiveFailures =
          (this.state.clusterHealth[hpc].consecutiveFailures || 0) + 1;

        // Mark cluster as offline
        this.state.clusterHealth[hpc].current = {
          online: false,
          error: e.message,
          lastChecked: now,
        };

        // Escalate logging if failures persist
        const failures = this.state.clusterHealth[hpc].consecutiveFailures;
        if (failures >= 5) {
          log.error('Cluster health check failing persistently', { hpc, failures, error: e.message });
        } else {
          log.warn('Failed to refresh cluster health', { hpc, failures, error: e.message });
        }
      }
    });

    // Wait for all health checks to complete
    await Promise.all(healthPromises);

    // Persist cluster health to disk
    await this.save();
  }

  /**
   * Roll over history entries older than 24h to dated archive files
   * Keeps state.json lightweight while preserving historical data
   *
   * Downsampling strategy:
   * - Current day (in state.json): full resolution (every poll)
   * - Archives: 1 sample per hour (24 samples/day max)
   *
   * @param {string} hpc - Cluster name
   */
  async rolloverHealthHistory(hpc) {
    const history = this.state.clusterHealth[hpc]?.history || [];
    const cutoff = Date.now() - ONE_DAY_MS;

    // Find entries to archive (older than 24h)
    const toArchive = history.filter(e => e.timestamp < cutoff);
    if (toArchive.length === 0) return;

    // Group by date (YYYY-MM-DD)
    const byDate = {};
    for (const entry of toArchive) {
      const date = new Date(entry.timestamp).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(entry);
    }

    // Write each date's entries to archive file
    const archiveDir = path.join(path.dirname(this.stateFile), 'health-history');
    await fs.mkdir(archiveDir, { recursive: true });

    for (const [date, entries] of Object.entries(byDate)) {
      const archiveFile = path.join(archiveDir, `${hpc}-${date}.json`);

      // Merge with existing archive if present
      let existing = { cluster: hpc, date, entries: [] };
      try {
        const data = await fs.readFile(archiveFile, 'utf8');
        const parsed = JSON.parse(data);
        // Validate structure before using
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
          existing = parsed;
        } else {
          log.warn('Invalid archive JSON structure, using fresh archive', { archiveFile, hpc, date });
        }
      } catch (e) {
        if (e.code !== 'ENOENT') {
          // Log unexpected errors (not just missing file)
          log.warn('Failed to read archive file, using fresh archive', { archiveFile, hpc, date, error: e.message });
        }
      }

      // Combine existing and new entries, then downsample to 1 per hour
      const allEntries = [...existing.entries, ...entries];
      const downsampled = this.downsampleToHourly(allEntries);

      existing.entries = downsampled;
      await fs.writeFile(archiveFile, JSON.stringify(existing, null, 2));
      log.state(`Archived health entries`, { hpc, date, raw: entries.length, downsampled: downsampled.length });
    }

    // Remove archived entries from state
    this.state.clusterHealth[hpc].history = history.filter(e => e.timestamp >= cutoff);
  }

  /**
   * Downsample health entries to one per hour
   * Uses the median value for each metric within each hour bucket
   * @param {Array} entries - Health history entries
   * @returns {Array} Downsampled entries (1 per hour)
   */
  downsampleToHourly(entries) {
    if (entries.length === 0) return [];

    // Group by hour (YYYY-MM-DDTHH)
    const byHour = {};
    for (const entry of entries) {
      const hourKey = new Date(entry.timestamp).toISOString().slice(0, 13); // "2025-01-04T14"
      if (!byHour[hourKey]) byHour[hourKey] = [];
      byHour[hourKey].push(entry);
    }

    // For each hour, compute representative sample (median of each metric)
    const result = [];
    for (const [hourKey, hourEntries] of Object.entries(byHour)) {
      // Use middle timestamp for the hour
      const sortedByTime = hourEntries.sort((a, b) => a.timestamp - b.timestamp);
      const midIndex = Math.floor(sortedByTime.length / 2);

      result.push({
        timestamp: sortedByTime[midIndex].timestamp,
        cpus: this.median(hourEntries.map(e => e.cpus)),
        memory: this.median(hourEntries.map(e => e.memory)),
        nodes: this.median(hourEntries.map(e => e.nodes)),
        gpus: this.medianNullable(hourEntries.map(e => e.gpus)),
        sampleCount: hourEntries.length, // Track how many samples were aggregated
      });
    }

    // Sort by timestamp
    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Calculate median of numeric array
   * @param {number[]} values
   * @returns {number}
   */
  median(values) {
    const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  /**
   * Calculate median for nullable values (e.g., GPUs which may be null)
   * @param {(number|null)[]} values
   * @returns {number|null}
   */
  medianNullable(values) {
    const nonNull = values.filter(v => v !== null && typeof v === 'number');
    if (nonNull.length === 0) return null;
    return this.median(nonNull);
  }

  /**
   * Get cluster health data for API responses
   * Combines current state with history from database
   * @returns {Object} Cluster health data with current and history
   */
  getClusterHealth() {
    const clusterHealth = this.state.clusterHealth || {};

    // If SQLite enabled, replace in-memory history with database history
    if (this.useSqlite) {
      try {
        const dbHistory = dbHealth.getAllHealthHistory({ days: 1 });
        for (const hpc of Object.keys(clusterHealth)) {
          if (clusterHealth[hpc]) {
            clusterHealth[hpc].history = dbHistory[hpc] || [];
          }
        }
      } catch (err) {
        log.error('Failed to get cluster history from SQLite', { error: err.message });
      }
    }

    return clusterHealth;
  }

  /**
   * Get cluster health history from database
   * @param {Object} [options]
   * @param {number} [options.days=1] - Number of days to look back
   * @returns {Object} Map of hpc -> history array
   */
  getClusterHistory(options = {}) {
    if (!this.useSqlite) {
      // Return in-memory history if SQLite not enabled
      const result = {};
      for (const [hpc, data] of Object.entries(this.state.clusterHealth || {})) {
        result[hpc] = data.history || [];
      }
      return result;
    }

    try {
      return dbHealth.getAllHealthHistory(options);
    } catch (err) {
      log.error('Failed to get cluster history from SQLite', { error: err.message });
      return {};
    }
  }
}

module.exports = { StateManager, POLLING_CONFIG };
