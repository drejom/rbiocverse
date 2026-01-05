/**
 * State persistence and reconciliation
 * Prevents orphaned processes after container restarts
 *
 * Architecture:
 * - StateManager is the single source of truth for session state
 * - Backend polling updates state at adaptive intervals
 * - API endpoints read from cached state (instant, no SSH)
 * - Sessions use composite keys: gemini-vscode, apollo-jupyter, etc.
 */

const fs = require('fs').promises;
const path = require('path');
const { LockError } = require('./errors');
const { log } = require('./logger');
const { clusters } = require('../config');

// Time constants
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Polling configuration for adaptive backend polling
 * Migrated from frontend launcher.js for efficiency
 */
const POLLING_CONFIG = {
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

    // Polling state
    this.pollTimer = null;
    this.consecutiveUnchangedPolls = 0;
    this.lastStateSnapshot = null;
    this.lastPollTime = null;
    this.nextPollTime = null;
    this.hpcServiceFactory = null; // Function: (hpc) => HpcService instance
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
   * Load state from disk on startup
   * Reconcile with squeue to detect orphaned jobs
   */
  async load() {
    if (!this.enablePersistence) {
      this.ready = true;
      return;
    }

    try {
      const data = await fs.readFile(this.stateFile, 'utf8');
      const loadedState = JSON.parse(data);
      log.state('Loaded from disk', { file: this.stateFile });

      // Migrate from old activeHpc to new activeSession format
      if (loadedState.activeHpc && !loadedState.activeSession) {
        // Old format - activeHpc was just cluster name, convert to null
        // (we can't know which IDE, so start fresh)
        loadedState.activeSession = null;
        delete loadedState.activeHpc;
      }

      // Ensure sessions object exists
      if (!loadedState.sessions) {
        loadedState.sessions = {};
      }

      this.state = loadedState;

      // Ensure tunnelProcess is null for all sessions (can't be restored from disk)
      for (const session of Object.values(this.state.sessions)) {
        if (session) {
          session.tunnelProcess = null;
        }
      }

      await this.reconcile();
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log.error('Failed to load state', { error: e.message });
      }
      // File doesn't exist yet - normal on first run
    }

    this.ready = true;
  }

  /**
   * Save state to disk after every change
   * Excludes non-serializable fields like tunnelProcess
   */
  async save() {
    if (!this.enablePersistence) return;
    log.debugFor('state', 'saving to disk', { file: this.stateFile });

    try {
      const dir = path.dirname(this.stateFile);
      await fs.mkdir(dir, { recursive: true });

      // Create a clean copy without non-serializable fields
      const cleanState = {
        activeSession: this.state.activeSession,
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
        // Extract hpc from composite key (e.g., "gemini-vscode" -> "gemini")
        const [hpc] = sessionKey.split('-');
        const exists = await this.checkJobExists(hpc, session.jobId);
        if (!exists) {
          log.state(`Job ${session.jobId} no longer exists, clearing session`, { sessionKey });
          this._clearActiveSessionIfMatches(hpc, session.ide);
          this.state.sessions[sessionKey] = null;
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
      const status = await hpcService.getJobStatus(jobId);
      // Job exists if we got status and it's not in a terminal state
      return status !== null && !['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(status.state);
    } catch (e) {
      log.warn('Failed to check job existence, assuming exists', { hpc, jobId, error: e.message });
      return true; // Safe fallback
    }
  }

  // ============================================
  // Private helper methods
  // ============================================

  /**
   * Clear activeSession if it matches the given hpc and ide
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   * @private
   */
  _clearActiveSessionIfMatches(hpc, ide) {
    if (
      this.state.activeSession?.hpc === hpc &&
      this.state.activeSession?.ide === ide
    ) {
      this.state.activeSession = null;
    }
  }

  // ============================================
  // Session access methods (composite key based)
  // ============================================

  /**
   * Get session by composite key
   * @param {string} sessionKey - Composite key (e.g., "gemini-vscode")
   * @returns {Object|null} Session or null
   */
  getSessionByKey(sessionKey) {
    return this.state.sessions[sessionKey] || null;
  }

  /**
   * Update session by composite key and persist
   * @param {string} sessionKey - Composite key
   * @param {Object} updates - Fields to update
   */
  async updateSessionByKey(sessionKey, updates) {
    if (!this.state.sessions[sessionKey]) {
      this.state.sessions[sessionKey] = {};
    }
    Object.assign(this.state.sessions[sessionKey], updates);
    await this.save();
  }

  /**
   * Clear session by composite key and persist
   * @param {string} sessionKey - Composite key
   */
  async clearSessionByKey(sessionKey) {
    const session = this.state.sessions[sessionKey];
    if (session) {
      const [hpc] = sessionKey.split('-');
      this._clearActiveSessionIfMatches(hpc, session.ide);
    }
    this.state.sessions[sessionKey] = null;
    await this.save();
  }

  // ============================================
  // Legacy methods (kept for compatibility)
  // ============================================

  /**
   * @deprecated Use getSessionByKey instead
   */
  async updateSession(hpc, updates) {
    if (!this.state.sessions[hpc]) {
      this.state.sessions[hpc] = {};
    }
    Object.assign(this.state.sessions[hpc], updates);
    await this.save();
  }

  /**
   * @deprecated Use clearSessionByKey instead
   */
  async clearSession(hpc) {
    this.state.sessions[hpc] = null;
    await this.save();
  }

  /**
   * @deprecated Use getSessionByKey instead
   */
  getSession(hpc) {
    return this.state.sessions[hpc];
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
   * @param {string} hpc - Cluster name
   * @param {string} ide - IDE type
   */
  async setActiveSession(hpc, ide) {
    this.state.activeSession = hpc && ide ? { hpc, ide } : null;
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
  // Polling methods (Phase 2)
  // ============================================

  /**
   * Start background polling for session status
   * @param {Function} hpcServiceFactory - Factory function: (hpc) => HpcService instance
   */
  startPolling(hpcServiceFactory) {
    this.hpcServiceFactory = hpcServiceFactory;
    log.state('Starting background polling');

    // Fetch cluster health immediately on startup (don't wait for first poll)
    this.refreshClusterHealth().catch(e => {
      log.warn('Initial cluster health fetch failed', { error: e.message });
    });

    this.schedulePoll();
  }

  /**
   * Stop background polling
   */
  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.state('Stopped background polling');
  }

  /**
   * Schedule next poll with adaptive interval
   */
  schedulePoll() {
    const interval = this.getOptimalPollInterval();
    this.nextPollTime = Date.now() + interval;
    this.pollTimer = setTimeout(() => this.poll(), interval);
    log.debugFor('state', `Next poll in ${Math.round(interval / 1000)}s`);
  }

  /**
   * Execute a poll cycle
   * Refreshes all running sessions and schedules next poll
   * Error-safe: always reschedules even if refresh fails
   */
  async poll() {
    this.lastPollTime = Date.now();

    try {
      const changed = await this.refreshAllSessions();

      // Refresh cluster health (throttled - only when interval >= 60s)
      const currentInterval = this.getOptimalPollInterval();
      if (currentInterval >= POLLING_CONFIG.INTERVALS_MS.MODERATE) {
        await this.refreshClusterHealth();
      }

      if (changed) {
        this.consecutiveUnchangedPolls = 0;
        log.debugFor('state', 'Poll detected changes, resetting backoff');
      } else {
        this.consecutiveUnchangedPolls++;
        log.debugFor('state', `No changes for ${this.consecutiveUnchangedPolls} polls`);
      }
    } catch (e) {
      // Ensure polling continues even if an error occurs
      log.error('Poll cycle failed', { error: e.message });
    } finally {
      this.schedulePoll();
    }
  }

  /**
   * Refresh all running sessions from SLURM
   * @returns {Promise<boolean>} True if significant changes detected (for backoff reset)
   */
  async refreshAllSessions() {
    if (!this.hpcServiceFactory) return false;

    let significantChange = false; // Status transitions, job disappearance
    const snapshotBefore = JSON.stringify(this.state.sessions);

    for (const [sessionKey, session] of Object.entries(this.state.sessions)) {
      if (!session || !session.jobId) continue;
      if (session.status !== 'running' && session.status !== 'pending') continue;

      try {
        const [hpc] = sessionKey.split('-');
        const hpcService = this.hpcServiceFactory(hpc);
        const jobStatus = await hpcService.getJobStatus(session.jobId);

        if (!jobStatus) {
          // Job no longer exists
          log.state(`Job ${session.jobId} no longer in squeue`, { sessionKey });
          this._clearActiveSessionIfMatches(hpc, session.ide);
          this.state.sessions[sessionKey] = null;
          significantChange = true;
          continue;
        }

        // Update session with fresh data from SLURM
        if (jobStatus.state === 'RUNNING' && session.status !== 'running') {
          session.status = 'running';
          session.node = jobStatus.node;
          significantChange = true;
        } else if (jobStatus.state === 'PENDING' && session.status !== 'pending') {
          session.status = 'pending';
          significantChange = true;
        } else if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(jobStatus.state)) {
          log.state(`Job ${session.jobId} ended with ${jobStatus.state}`, { sessionKey });
          this._clearActiveSessionIfMatches(hpc, session.ide);
          this.state.sessions[sessionKey] = null;
          significantChange = true;
        }

        // Update time remaining (not a significant change for backoff purposes)
        if (jobStatus.timeLeftSeconds !== undefined) {
          session.timeLeftSeconds = jobStatus.timeLeftSeconds;
        }
      } catch (e) {
        log.warn('Failed to refresh session', { sessionKey, error: e.message });
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
   * Calculate optimal polling interval based on session state and backoff
   * @returns {number} Interval in milliseconds
   */
  getOptimalPollInterval() {
    const { THRESHOLDS_SECONDS, INTERVALS_MS, BACKOFF } = POLLING_CONFIG;

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
      lastPollTime: this.lastPollTime,
      nextPollTime: this.nextPollTime,
      consecutiveUnchangedPolls: this.consecutiveUnchangedPolls,
      currentInterval: this.getOptimalPollInterval(),
    };
  }

  // ============================================
  // Cluster Health Methods
  // ============================================

  /**
   * Refresh cluster health for all clusters
   * Called from poll() when interval >= POLLING_CONFIG.INTERVALS_MS.MODERATE
   * Polls clusters in parallel for efficiency
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
    const healthPromises = clusterNames.map(async (hpc) => {
      try {
        const hpcService = this.hpcServiceFactory(hpc);
        const health = await hpcService.getClusterHealth();

        // Reset failure counter on success
        this.state.clusterHealth[hpc].consecutiveFailures = 0;

        // Update current health
        this.state.clusterHealth[hpc].current = health;

        // Append to history (only if online and health data is valid)
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
          const ROLLOVER_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
          const lastRolloverAt = this.state.clusterHealth[hpc].lastRolloverAt || 0;
          if (now - lastRolloverAt >= ROLLOVER_MIN_INTERVAL_MS) {
            await this.rolloverHealthHistory(hpc);
            this.state.clusterHealth[hpc].lastRolloverAt = now;
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
   * @returns {Object} Cluster health data
   */
  getClusterHealth() {
    return this.state.clusterHealth || {};
  }
}

module.exports = { StateManager, createIdleSession, POLLING_CONFIG };
