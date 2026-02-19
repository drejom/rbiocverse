/**
 * ErrorLogger Service
 * Structured error logging with file persistence and admin notification support
 */

import { promises as fs } from 'fs';
import path from 'path';
import { log } from '../lib/logger';
import { errorDetails } from '../lib/errors';

// Default error log path (can be overridden via ERROR_LOG_FILE env var)
const ERROR_LOG_FILE = process.env.ERROR_LOG_FILE || '/data/logs/errors.json';

/**
 * Error entry structure for persistence
 */
export interface ErrorEntry {
  timestamp: string;
  level: string;
  user: string;
  action: string;
  message: string;
  code?: string;
  context?: Record<string, unknown>;
  stack?: string;
}

interface ErrorLoggerOptions {
  logFile?: string;
  maxEntries?: number;
}

interface LogErrorOptions {
  user?: string;
  action: string;
  error: Error | string;
  context?: Record<string, unknown>;
}

interface GetRecentErrorsOptions {
  since?: Date;
  level?: string;
}

interface ErrorSummary {
  period: {
    since: string;
    until: string;
  };
  total: number;
  byLevel: Record<string, number>;
  byUser: Record<string, number>;
  byAction: Record<string, number>;
  recent: ErrorEntry[];
}

class ErrorLogger {
  private logFile: string;
  private maxEntries: number;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: ErrorLoggerOptions = {}) {
    this.logFile = options.logFile || ERROR_LOG_FILE;
    this.maxEntries = options.maxEntries || 1000; // Keep last N entries
  }

  /**
   * Ensure the log directory exists
   */
  async ensureLogDir(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const dir = path.dirname(this.logFile);
        await fs.mkdir(dir, { recursive: true });
        this.initialized = true;
      } catch (err) {
        log.warn('Failed to create error log directory:', errorDetails(err));
      }
    })();

    return this.initPromise;
  }

  /**
   * Log an error with context
   */
  async logError({ user = 'system', action, error, context = {} }: LogErrorOptions): Promise<ErrorEntry> {
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
   */
  async logWarning({ user = 'system', action, error, context = {} }: LogErrorOptions): Promise<ErrorEntry> {
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
  createEntry(
    level: string,
    user: string,
    action: string,
    error: Error | string,
    context: Record<string, unknown>
  ): ErrorEntry {
    const isError = error instanceof Error;
    const errorWithCode = error as Error & { code?: string };

    return {
      timestamp: new Date().toISOString(),
      level,
      user,
      action,
      message: isError ? error.message : String(error),
      code: isError && errorWithCode.code ? errorWithCode.code : undefined,
      context: Object.keys(context).length > 0 ? context : undefined,
      stack: isError && level === 'error' ? error.stack : undefined,
    };
  }

  /**
   * Append an entry to the error log file
   *
   * Note: This read-then-write approach is acceptable for error logging which
   * is low-frequency. For high-frequency logging, consider switching to JSON Lines
   * (.jsonl) format with append-only writes.
   */
  async appendEntry(entry: ErrorEntry): Promise<void> {
    await this.ensureLogDir();

    try {
      // Read existing entries
      let entries: ErrorEntry[] = [];
      try {
        const content = await fs.readFile(this.logFile, 'utf8');
        entries = JSON.parse(content);
      } catch (err) {
        // File doesn't exist or is invalid - start fresh
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'ENOENT') {
          log.warn('Error log file corrupted, starting fresh');
        }
      }

      // Add new entry
      entries.push(entry);

      // Trim to max entries
      if (entries.length > this.maxEntries) {
        entries = entries.slice(-this.maxEntries);
      }

      // Write back atomically by writing to temp file first
      const tempFile = `${this.logFile}.tmp`;
      await fs.writeFile(tempFile, JSON.stringify(entries, null, 2));
      await fs.rename(tempFile, this.logFile);
    } catch (err) {
      // Don't throw - error logging should never break the app
      log.error('Failed to persist error log:', errorDetails(err));
    }
  }

  /**
   * Get recent errors for admin digest
   */
  async getRecentErrors({ since, level }: GetRecentErrorsOptions = {}): Promise<ErrorEntry[]> {
    try {
      const content = await fs.readFile(this.logFile, 'utf8');
      let entries: ErrorEntry[] = JSON.parse(content);

      if (since) {
        const sinceTime = since.getTime();
        entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
      }

      if (level) {
        entries = entries.filter(e => e.level === level);
      }

      return entries;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      log.error('Failed to read error log:', errorDetails(err));
      return [];
    }
  }

  /**
   * Get error summary for a time period
   */
  async getSummary(since: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): Promise<ErrorSummary> {
    const errors = await this.getRecentErrors({ since });

    const summary: ErrorSummary = {
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
   * @param keepDays - Keep entries from last N days
   */
  async cleanup(keepDays: number = 30): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);
      const content = await fs.readFile(this.logFile, 'utf8');
      let entries: ErrorEntry[] = JSON.parse(content);

      const beforeCount = entries.length;
      entries = entries.filter(e => new Date(e.timestamp) >= cutoff);

      if (entries.length < beforeCount) {
        await fs.writeFile(this.logFile, JSON.stringify(entries, null, 2));
        log.info(`Cleaned up ${beforeCount - entries.length} old error log entries`);
      }
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        log.error('Failed to cleanup error log:', errorDetails(err));
      }
    }
  }
}

// Singleton instance for use across the app
const errorLogger = new ErrorLogger();

export { ErrorLogger, errorLogger };

// CommonJS compatibility for existing require() calls
module.exports = { ErrorLogger, errorLogger };
