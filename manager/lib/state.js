/**
 * State persistence and reconciliation
 * Prevents orphaned processes after container restarts
 */

const fs = require('fs').promises;
const path = require('path');
const { LockError } = require('./errors');

class StateManager {
  constructor() {
    // Read environment variables at construction time (not module load time)
    this.stateFile = process.env.STATE_FILE || '/data/state.json';
    this.enablePersistence = process.env.ENABLE_STATE_PERSISTENCE === 'true';

    this.state = {
      sessions: {
        gemini: null,
        apollo: null,
      },
      activeHpc: null,
    };

    // Operation locks to prevent race conditions
    this.locks = new Map();
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
    console.log(`[Lock] Acquired: ${operation}`);
  }

  /**
   * Release lock for an operation
   * @param {string} operation - Lock name
   */
  releaseLock(operation) {
    if (this.locks.has(operation)) {
      const held = Date.now() - this.locks.get(operation);
      console.log(`[Lock] Released: ${operation} (held ${held}ms)`);
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
    if (!this.enablePersistence) return;

    try {
      const data = await fs.readFile(this.stateFile, 'utf8');
      this.state = JSON.parse(data);
      console.log('State loaded from', this.stateFile);

      // Ensure tunnelProcess is null for all sessions (can't be restored from disk)
      for (const [hpc, session] of Object.entries(this.state.sessions)) {
        if (session) {
          session.tunnelProcess = null;
        }
      }

      await this.reconcile();
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('Failed to load state:', e.message);
      }
      // File doesn't exist yet - normal on first run
    }
  }

  /**
   * Save state to disk after every change
   * Excludes non-serializable fields like tunnelProcess
   */
  async save() {
    if (!this.enablePersistence) return;

    try {
      const dir = path.dirname(this.stateFile);
      await fs.mkdir(dir, { recursive: true });

      // Create a clean copy without non-serializable fields
      const cleanState = {
        activeHpc: this.state.activeHpc,
        sessions: {},
      };

      for (const [hpc, session] of Object.entries(this.state.sessions)) {
        if (session) {
          // Exclude tunnelProcess - it's a process handle that can't be serialized
          const { tunnelProcess, ...rest } = session;
          cleanState.sessions[hpc] = rest;
        } else {
          cleanState.sessions[hpc] = null;
        }
      }

      await fs.writeFile(this.stateFile, JSON.stringify(cleanState, null, 2));
    } catch (e) {
      console.error('Failed to save state:', e.message);
    }
  }

  /**
   * Reconcile state with reality
   * Check if "running" jobs still exist in squeue
   * Mark as idle if job no longer exists
   */
  async reconcile() {
    for (const [hpc, session] of Object.entries(this.state.sessions)) {
      if (session?.status === 'running' && session.jobId) {
        const exists = await this.checkJobExists(hpc, session.jobId);
        if (!exists) {
          console.log(`Job ${session.jobId} no longer exists, marking as idle`);
          this.state.sessions[hpc] = null;
        }
      }
    }
    await this.save();
  }

  /**
   * Check if job exists in squeue
   * @param {string} hpc - Cluster name (gemini, apollo)
   * @param {string} jobId - SLURM job ID
   * @returns {Promise<boolean>} True if job exists
   */
  async checkJobExists(hpc, jobId) {
    // TODO: Implement squeue check via SSH
    // For now, assume job exists (safer than prematurely clearing)
    // This will be implemented when HPC service is extracted in Phase 2
    return true;
  }

  /**
   * Update session and persist
   * @param {string} hpc - Cluster name
   * @param {Object} updates - Fields to update
   */
  async updateSession(hpc, updates) {
    if (!this.state.sessions[hpc]) {
      this.state.sessions[hpc] = {};
    }
    Object.assign(this.state.sessions[hpc], updates);
    await this.save();
  }

  /**
   * Clear session and persist
   * @param {string} hpc - Cluster name
   */
  async clearSession(hpc) {
    this.state.sessions[hpc] = null;
    if (this.state.activeHpc === hpc) {
      this.state.activeHpc = null;
    }
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
   * Get session for specific HPC
   * @param {string} hpc - Cluster name
   * @returns {Object|null} Session or null
   */
  getSession(hpc) {
    return this.state.sessions[hpc];
  }

  /**
   * Set active HPC and persist
   * @param {string} hpc - Cluster name
   */
  async setActiveHpc(hpc) {
    this.state.activeHpc = hpc;
    await this.save();
  }
}

module.exports = StateManager;
