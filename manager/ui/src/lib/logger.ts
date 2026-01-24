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

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogMeta {
  action?: string;
  component?: string;
  error?: Error;
  errorMessage?: string;
  [key: string]: unknown;
}

interface ErrorEntry {
  level: LogLevel;
  message: string;
  action: string;
  context: {
    url: string;
    userAgent: string;
    [key: string]: unknown;
  };
  stack?: string;
  timestamp: string;
}

// Log levels in order of severity
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Current log level (can be overridden via localStorage for debugging)
const getLogLevel = (): LogLevel => {
  try {
    const stored = localStorage.getItem('logLevel') as LogLevel | null;
    if (stored && LOG_LEVELS[stored] !== undefined) {
      return stored;
    }
  } catch {
    // localStorage not available
  }
  return import.meta.env.PROD ? 'warn' : 'debug';
};

// Debug components (similar to backend DEBUG_COMPONENTS)
const getDebugComponents = (): Set<string> => {
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
function isLevelEnabled(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * Check if debug is enabled for a component
 */
function isDebugEnabled(component: string): boolean {
  return debugComponents.has('all') || debugComponents.has(component.toLowerCase());
}

/**
 * Format log message with metadata
 */
function formatMessage(level: LogLevel, message: string, meta: LogMeta): string {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

/**
 * Send error to backend ErrorLogger
 */
async function reportToBackend(entry: ErrorEntry): Promise<void> {
  try {
    const token = localStorage.getItem('authToken');
    const headers: Record<string, string> = {
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
function createErrorEntry(level: LogLevel, message: string, meta: LogMeta, error?: Error | null): ErrorEntry {
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
  debug(message: string, meta: LogMeta = {}): void {
    if (!isLevelEnabled('debug')) return;
    console.debug(formatMessage('debug', message, meta));
  },

  /**
   * Info level logging
   */
  info(message: string, meta: LogMeta = {}): void {
    if (!isLevelEnabled('info')) return;
    console.info(formatMessage('info', message, meta));
  },

  /**
   * Warning level logging
   * Note: Only reports to backend in development to avoid noise
   */
  warn(message: string, meta: LogMeta = {}): void {
    if (!isLevelEnabled('warn')) return;
    console.warn(formatMessage('warn', message, meta));

    // Only report warnings to backend in development (errors always reported)
    if (import.meta.env.DEV) {
      const entry = createErrorEntry('warn', message, meta);
      reportToBackend(entry);
    }
  },

  /**
   * Error level logging - always reports to backend
   */
  error(message: string, meta: LogMeta = {}): void {
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
  debugFor(component: string, message: string, meta: LogMeta = {}): void {
    if (!isLevelEnabled('debug') || !isDebugEnabled(component)) return;
    console.debug(formatMessage('debug', `[${component}] ${message}`, meta));
  },

  /**
   * Set the log level at runtime
   */
  setLevel(level: LogLevel): void {
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
   */
  setDebugComponents(components: string[]): void {
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
  getLevel(): LogLevel {
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
export type { LogLevel, LogMeta };
