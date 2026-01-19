/**
 * Frontend Structured Logger
 * Provides consistent logging with levels and optional backend reporting
 *
 * Features:
 * - Configurable log levels (debug, info, warn, error)
 * - Structured metadata support
 * - Error reporting to backend ErrorLogger
 * - Component-specific debug logging
 */

// Log levels in order of severity
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Current log level (can be overridden via localStorage for debugging)
const getLogLevel = () => {
  try {
    const stored = localStorage.getItem('logLevel');
    if (stored && LOG_LEVELS[stored] !== undefined) {
      return stored;
    }
  } catch {
    // localStorage not available
  }
  return process.env.NODE_ENV === 'production' ? 'warn' : 'debug';
};

// Debug components (similar to backend DEBUG_COMPONENTS)
const getDebugComponents = () => {
  try {
    const stored = localStorage.getItem('debugComponents');
    if (stored) {
      return new Set(stored.split(',').map(s => s.trim().toLowerCase()));
    }
  } catch {
    // localStorage not available
  }
  return new Set();
};

let currentLevel = getLogLevel();
let debugComponents = getDebugComponents();

/**
 * Check if a log level is enabled
 */
function isLevelEnabled(level) {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * Check if debug is enabled for a component
 */
function isDebugEnabled(component) {
  return debugComponents.has('all') || debugComponents.has(component.toLowerCase());
}

/**
 * Format log message with metadata
 */
function formatMessage(level, message, meta) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

/**
 * Send error to backend ErrorLogger
 */
async function reportToBackend(entry) {
  try {
    const token = localStorage.getItem('authToken');
    const headers = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    await fetch('/api/client-errors', {
      method: 'POST',
      headers,
      body: JSON.stringify(entry),
    });
  } catch {
    // Silently fail - don't cause more errors trying to report errors
  }
}

/**
 * Create an error entry for backend reporting
 */
function createErrorEntry(level, message, meta, error) {
  return {
    level,
    message,
    action: meta.action || meta.component || 'unknown',
    context: {
      ...meta,
      url: window.location.href,
      userAgent: navigator.userAgent,
    },
    stack: error?.stack,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Main logger object
 */
const log = {
  /**
   * Debug level logging
   */
  debug(message, meta = {}) {
    if (!isLevelEnabled('debug')) return;
    console.debug(formatMessage('debug', message, meta));
  },

  /**
   * Info level logging
   */
  info(message, meta = {}) {
    if (!isLevelEnabled('info')) return;
    console.info(formatMessage('info', message, meta));
  },

  /**
   * Warning level logging
   */
  warn(message, meta = {}) {
    if (!isLevelEnabled('warn')) return;
    console.warn(formatMessage('warn', message, meta));

    // Report warnings to backend
    const entry = createErrorEntry('warn', message, meta);
    reportToBackend(entry);
  },

  /**
   * Error level logging - always reports to backend
   */
  error(message, meta = {}) {
    const error = meta.error instanceof Error ? meta.error : null;
    const cleanMeta = { ...meta };
    if (error) {
      cleanMeta.errorMessage = error.message;
      delete cleanMeta.error;
    }

    console.error(formatMessage('error', message, cleanMeta));

    // Always report errors to backend
    const entry = createErrorEntry('error', message, cleanMeta, error);
    reportToBackend(entry);
  },

  /**
   * Component-specific debug logging
   * Only logs if the component is in debugComponents
   */
  debugFor(component, message, meta = {}) {
    if (!isLevelEnabled('debug') || !isDebugEnabled(component)) return;
    console.debug(formatMessage('debug', `[${component}] ${message}`, meta));
  },

  /**
   * Set the log level at runtime
   */
  setLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      currentLevel = level;
      try {
        localStorage.setItem('logLevel', level);
      } catch {
        // localStorage not available
      }
    }
  },

  /**
   * Enable debug for specific components
   * @param {string[]} components - Component names to enable
   */
  setDebugComponents(components) {
    debugComponents = new Set(components.map(c => c.toLowerCase()));
    try {
      localStorage.setItem('debugComponents', components.join(','));
    } catch {
      // localStorage not available
    }
  },

  /**
   * Get current log level
   */
  getLevel() {
    return currentLevel;
  },

  /**
   * Check if a level is enabled
   */
  isLevelEnabled,

  /**
   * Check if debug is enabled for a component
   */
  isDebugEnabled,
};

export default log;
export { log, LOG_LEVELS };
