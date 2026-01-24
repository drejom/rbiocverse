/**
 * Structured logging with winston
 * Provides consistent log format and levels across the application
 */

import winston from 'winston';

const { format, transports } = winston;

// Parse DEBUG_COMPONENTS env var into Set
// Examples: DEBUG_COMPONENTS=vscode,ssh or DEBUG_COMPONENTS=all
const debugComponentsEnv = process.env.DEBUG_COMPONENTS || '';
const debugComponents = new Set(
  debugComponentsEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const debugAll = debugComponents.has('all');

interface LogMeta {
  [key: string]: unknown;
}

interface TimerResult {
  done: (meta?: LogMeta) => number;
}

// Custom format for console output
const consoleFormat = format.printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
});

// Create logger with environment-based configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        consoleFormat,
      ),
    }),
  ],
});

// Add file transport in production
if (process.env.NODE_ENV === 'production' || process.env.LOG_FILE) {
  const logFile = process.env.LOG_FILE || '/data/logs/manager.log';
  logger.add(new transports.File({
    filename: logFile,
    format: format.combine(
      format.json(),
    ),
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 3,
  }));
}

// Check if debug is enabled for a component
function isDebugEnabled(component: string): boolean {
  return debugAll || debugComponents.has(component.toLowerCase());
}

// Convenience methods for structured logging
const log = {
  // General logging
  debug: (msg: string, meta: LogMeta = {}): void => { logger.debug(msg, meta); },
  info: (msg: string, meta: LogMeta = {}): void => { logger.info(msg, meta); },
  warn: (msg: string, meta: LogMeta = {}): void => { logger.warn(msg, meta); },
  error: (msg: string, meta: LogMeta = {}): void => { logger.error(msg, meta); },

  // Component-specific debug logging
  // Only logs if DEBUG_COMPONENTS includes this component or 'all'
  // Components: vscode, rstudio, ssh, cache, ui, state, tunnel, liveserver
  debugFor: (component: string, msg: string, meta: LogMeta = {}): void => {
    if (logger.isLevelEnabled('debug') && isDebugEnabled(component)) {
      logger.debug(`[${component}] ${msg}`, meta);
    }
  },

  // Domain-specific logging
  ssh: (action: string, meta: LogMeta = {}): void => { logger.info(`[SSH] ${action}`, meta); },
  job: (action: string, meta: LogMeta = {}): void => { logger.info(`[Job] ${action}`, meta); },
  tunnel: (action: string, meta: LogMeta = {}): void => { logger.info(`[Tunnel] ${action}`, meta); },
  lock: (action: string, meta: LogMeta = {}): void => { logger.debug(`[Lock] ${action}`, meta); },
  api: (action: string, meta: LogMeta = {}): void => { logger.info(`[API] ${action}`, meta); },
  ui: (action: string, meta: LogMeta = {}): void => { logger.debug(`[UI] ${action}`, meta); },

  // Port check - debug level to avoid noise from polling
  portCheck: (port: number, open: boolean, meta: LogMeta = {}): void => {
    logger.debug(`[Port] ${port} ${open ? 'open' : 'closed'}`, meta);
  },

  // State operations
  state: (action: string, meta: LogMeta = {}): void => { logger.info(`[State] ${action}`, meta); },

  // Proxy events - debug level for routine operations (connection refused is expected)
  proxy: (action: string, meta: LogMeta = {}): void => { logger.debug(`[Proxy] ${action}`, meta); },
  proxyError: (msg: string, meta: LogMeta = {}): void => { logger.debug(`[Proxy] ${msg}`, meta); },

  // Database operations - debug level for routine queries
  // Enable with DEBUG_COMPONENTS=db or LOG_LEVEL=debug
  db: (action: string, meta: LogMeta = {}): void => {
    if (logger.isLevelEnabled('debug') && isDebugEnabled('db')) {
      logger.debug(`[DB] ${action}`, meta);
    }
  },

  // Audit logging for sensitive actions (always logged at info level)
  // Use for: key generation, session start/stop, user deletion, admin actions
  // Note: winston already adds timestamp via format.timestamp()
  audit: (action: string, meta: LogMeta = {}): void => {
    logger.info(`[Audit] ${action}`, meta);
  },

  // Performance timing helper
  // Usage:
  //   const timer = log.startTimer('operation');
  //   // ... do work ...
  //   timer.done({ extraMeta: 'value' });
  startTimer: (label: string): TimerResult => {
    const start = process.hrtime.bigint();
    return {
      done: (meta: LogMeta = {}): number => {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;
        if (logger.isLevelEnabled('debug') && isDebugEnabled('perf')) {
          logger.debug(`[Perf] ${label}`, { durationMs: durationMs.toFixed(2), ...meta });
        }
        return durationMs;
      },
    };
  },

  // Check if debug is enabled for a component
  isDebugEnabled,
};

export { logger, log };
