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

export interface LogMeta {
  [key: string]: unknown;
}

// Helper to convert string to meta object (with overloads for type safety)
function toMeta(): LogMeta;
function toMeta(meta: LogMeta): LogMeta;
function toMeta(detail: string): LogMeta;
function toMeta(metaOrString: LogMeta | string): LogMeta;
function toMeta(metaOrString?: LogMeta | string): LogMeta {
  if (typeof metaOrString === 'string') {
    return { detail: metaOrString };
  }
  return metaOrString ?? {};
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
  // General logging - accepts LogMeta or string for convenience
  debug: (msg: string, meta: LogMeta | string = {}): void => { logger.debug(msg, toMeta(meta)); },
  info: (msg: string, meta: LogMeta | string = {}): void => { logger.info(msg, toMeta(meta)); },
  warn: (msg: string, meta: LogMeta | string = {}): void => { logger.warn(msg, toMeta(meta)); },
  error: (msg: string, meta: LogMeta | string = {}): void => { logger.error(msg, toMeta(meta)); },

  // Component-specific debug logging
  // Only logs if DEBUG_COMPONENTS includes this component or 'all'
  // Components: vscode, rstudio, ssh, cache, ui, state, tunnel, liveserver
  debugFor: (component: string, msg: string, meta: LogMeta | string = {}): void => {
    if (logger.isLevelEnabled('debug') && isDebugEnabled(component)) {
      logger.debug(`[${component}] ${msg}`, toMeta(meta));
    }
  },

  // Domain-specific logging
  ssh: (action: string, meta: LogMeta | string = {}): void => { logger.info(`[SSH] ${action}`, toMeta(meta)); },
  job: (action: string, meta: LogMeta | string = {}): void => { logger.info(`[Job] ${action}`, toMeta(meta)); },
  tunnel: (action: string, meta: LogMeta | string = {}): void => { logger.info(`[Tunnel] ${action}`, toMeta(meta)); },
  lock: (action: string, meta: LogMeta | string = {}): void => { logger.debug(`[Lock] ${action}`, toMeta(meta)); },
  api: (action: string, meta: LogMeta | string = {}): void => { logger.info(`[API] ${action}`, toMeta(meta)); },
  ui: (action: string, meta: LogMeta | string = {}): void => { logger.debug(`[UI] ${action}`, toMeta(meta)); },

  // Port check - debug level to avoid noise from polling
  portCheck: (port: number, open: boolean, meta: LogMeta | string = {}): void => {
    logger.debug(`[Port] ${port} ${open ? 'open' : 'closed'}`, toMeta(meta));
  },

  // State operations
  state: (action: string, meta: LogMeta | string = {}): void => { logger.info(`[State] ${action}`, toMeta(meta)); },

  // Proxy events - debug level for routine operations (connection refused is expected)
  proxy: (action: string, meta: LogMeta | string = {}): void => { logger.debug(`[Proxy] ${action}`, toMeta(meta)); },
  proxyError: (msg: string, meta: LogMeta | string = {}): void => { logger.debug(`[Proxy] ${msg}`, toMeta(meta)); },

  // Database operations - debug level for routine queries
  // Enable with DEBUG_COMPONENTS=db or LOG_LEVEL=debug
  db: (action: string, meta: LogMeta | string = {}): void => {
    if (logger.isLevelEnabled('debug') && isDebugEnabled('db')) {
      logger.debug(`[DB] ${action}`, toMeta(meta));
    }
  },

  // Audit logging for sensitive actions (always logged at info level)
  // Use for: key generation, session start/stop, user deletion, admin actions
  // Note: winston already adds timestamp via format.timestamp()
  audit: (action: string, meta: LogMeta | string = {}): void => {
    logger.info(`[Audit] ${action}`, toMeta(meta));
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

// CommonJS compatibility for existing require() calls
module.exports = { logger, log };
