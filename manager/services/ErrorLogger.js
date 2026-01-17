/**
 * ErrorLogger Service
 * Structured error logging with file persistence and admin notification support
 */

const fs = require('fs').promises;
const path = require('path');
const { log } = require('../lib/logger');

// Default error log path (can be overridden via ERROR_LOG_FILE env var)
const ERROR_LOG_FILE = process.env.ERROR_LOG_FILE || '/data/logs/errors.json';

/**
 * Error entry structure for persistence
 * @typedef {Object} ErrorEntry
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} level - Error level (error, warn)
 * @property {string} user - Username (if available)
 * @property {string} action - What the user was trying to do
 * @property {string} message - Error message
 * @property {string} [code] - Error code (if applicable)
 * @property {Object} [context] - Additional context
 * @property {string} [stack] - Stack trace (for Error objects)
 */

class ErrorLogger {
  constructor(options = {}) {
    this.logFile = options.logFile || ERROR_LOG_FILE;
    this.maxEntries = options.maxEntries || 1000; // Keep last N entries
    this.initialized = false;
    this.initPromise = null;
  }

  /**
   * Ensure the log directory exists
   */
  async ensureLogDir() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const dir = path.dirname(this.logFile);
        await fs.mkdir(dir, { recursive: true });
        this.initialized = true;
      } catch (err) {
        log.warn('Failed to create error log directory:', { error: err.message });
      }
    })();

    return this.initPromise;
  }

  /**
   * Log an error with context
   * @param {Object} options - Error details
   * @param {string} options.user - Username (optional)
   * @param {string} options.action - What the user was doing
   * @param {Error|string} options.error - The error
   * @param {Object} options.context - Additional context
   * @returns {Promise<void>}
   */
  async logError({ user = 'system', action, error, context = {} }) {
    const entry = this.createEntry('error', user, action, error, context);

    // Log to console/winston
    log.error(`[${user}] ${action}: ${entry.message}`, {
      code: entry.code,
      ...context,
    });

    // Persist to file
    await this.appendEntry(entry);

    return entry;
  }

  /**
   * Log a warning with context
   * @param {Object} options - Warning details
   * @returns {Promise<void>}
   */
  async logWarning({ user = 'system', action, error, context = {} }) {
    const entry = this.createEntry('warn', user, action, error, context);

    log.warn(`[${user}] ${action}: ${entry.message}`, {
      code: entry.code,
      ...context,
    });

    await this.appendEntry(entry);

    return entry;
  }

  /**
   * Create an error entry object
   */
  createEntry(level, user, action, error, context) {
    const isError = error instanceof Error;

    return {
      timestamp: new Date().toISOString(),
      level,
      user,
      action,
      message: isError ? error.message : String(error),
      code: isError && error.code ? error.code : undefined,
      context: Object.keys(context).length > 0 ? context : undefined,
      stack: isError && level === 'error' ? error.stack : undefined,
    };
  }

  /**
   * Append an entry to the error log file
   */
  async appendEntry(entry) {
    await this.ensureLogDir();

    try {
      // Read existing entries
      let entries = [];
      try {
        const content = await fs.readFile(this.logFile, 'utf8');
        entries = JSON.parse(content);
      } catch (err) {
        // File doesn't exist or is invalid - start fresh
        if (err.code !== 'ENOENT') {
          log.warn('Error log file corrupted, starting fresh');
        }
      }

      // Add new entry
      entries.push(entry);

      // Trim to max entries
      if (entries.length > this.maxEntries) {
        entries = entries.slice(-this.maxEntries);
      }

      // Write back
      await fs.writeFile(this.logFile, JSON.stringify(entries, null, 2));
    } catch (err) {
      // Don't throw - error logging should never break the app
      log.error('Failed to persist error log:', { error: err.message });
    }
  }

  /**
   * Get recent errors for admin digest
   * @param {Object} options - Filter options
   * @param {Date} options.since - Only errors after this date
   * @param {string} options.level - Filter by level (error, warn)
   * @returns {Promise<ErrorEntry[]>}
   */
  async getRecentErrors({ since, level } = {}) {
    try {
      const content = await fs.readFile(this.logFile, 'utf8');
      let entries = JSON.parse(content);

      if (since) {
        const sinceTime = since.getTime();
        entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
      }

      if (level) {
        entries = entries.filter(e => e.level === level);
      }

      return entries;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      log.error('Failed to read error log:', { error: err.message });
      return [];
    }
  }

  /**
   * Get error summary for a time period
   * @param {Date} since - Start of period
   * @returns {Promise<Object>} Summary with counts by level, user, action
   */
  async getSummary(since = new Date(Date.now() - 24 * 60 * 60 * 1000)) {
    const errors = await this.getRecentErrors({ since });

    const summary = {
      period: {
        since: since.toISOString(),
        until: new Date().toISOString(),
      },
      total: errors.length,
      byLevel: {},
      byUser: {},
      byAction: {},
      recent: errors.slice(-10).reverse(), // Last 10, newest first
    };

    for (const entry of errors) {
      // Count by level
      summary.byLevel[entry.level] = (summary.byLevel[entry.level] || 0) + 1;

      // Count by user
      summary.byUser[entry.user] = (summary.byUser[entry.user] || 0) + 1;

      // Count by action
      summary.byAction[entry.action] = (summary.byAction[entry.action] || 0) + 1;
    }

    return summary;
  }

  /**
   * Clear old entries
   * @param {number} keepDays - Keep entries from last N days
   */
  async cleanup(keepDays = 30) {
    try {
      const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);
      const content = await fs.readFile(this.logFile, 'utf8');
      let entries = JSON.parse(content);

      const beforeCount = entries.length;
      entries = entries.filter(e => new Date(e.timestamp) >= cutoff);

      if (entries.length < beforeCount) {
        await fs.writeFile(this.logFile, JSON.stringify(entries, null, 2));
        log.info(`Cleaned up ${beforeCount - entries.length} old error log entries`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.error('Failed to cleanup error log:', { error: err.message });
      }
    }
  }
}

// Singleton instance for use across the app
const errorLogger = new ErrorLogger();

module.exports = { ErrorLogger, errorLogger };
