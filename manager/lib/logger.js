/**
 * Structured logging with winston
 * Provides consistent log format and levels across the application
 */

const winston = require('winston');

const { format, transports } = winston;

// Parse DEBUG_COMPONENTS env var into Set
// Examples: DEBUG_COMPONENTS=vscode,ssh or DEBUG_COMPONENTS=all
const debugComponentsEnv = process.env.DEBUG_COMPONENTS || '';
const debugComponents = new Set(
  debugComponentsEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const debugAll = debugComponents.has('all');

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
function isDebugEnabled(component) {
  return debugAll || debugComponents.has(component.toLowerCase());
}

// Convenience methods for structured logging
const log = {
  // General logging
  debug: (msg, meta = {}) => logger.debug(msg, meta),
  info: (msg, meta = {}) => logger.info(msg, meta),
  warn: (msg, meta = {}) => logger.warn(msg, meta),
  error: (msg, meta = {}) => logger.error(msg, meta),

  // Component-specific debug logging
  // Only logs if DEBUG_COMPONENTS includes this component or 'all'
  // Components: vscode, rstudio, ssh, cache, ui, state, tunnel, liveserver
  debugFor: (component, msg, meta = {}) => {
    if (logger.isLevelEnabled('debug') && isDebugEnabled(component)) {
      logger.debug(`[${component}] ${msg}`, meta);
    }
  },

  // Domain-specific logging
  ssh: (action, meta = {}) => logger.info(`[SSH] ${action}`, meta),
  job: (action, meta = {}) => logger.info(`[Job] ${action}`, meta),
  tunnel: (action, meta = {}) => logger.info(`[Tunnel] ${action}`, meta),
  lock: (action, meta = {}) => logger.debug(`[Lock] ${action}`, meta),
  api: (action, meta = {}) => logger.info(`[API] ${action}`, meta),
  ui: (action, meta = {}) => logger.debug(`[UI] ${action}`, meta),

  // Port check - debug level to avoid noise from polling
  portCheck: (port, open, meta = {}) => {
    logger.debug(`[Port] ${port} ${open ? 'open' : 'closed'}`, meta);
  },

  // State operations
  state: (action, meta = {}) => logger.info(`[State] ${action}`, meta),

  // Proxy events - debug level for routine operations (connection refused is expected)
  proxy: (action, meta = {}) => logger.debug(`[Proxy] ${action}`, meta),
  proxyError: (msg, meta = {}) => logger.debug(`[Proxy] ${msg}`, meta),
};

module.exports = { logger, log };
