/**
 * Custom error classes for structured error handling
 * Provides consistent error responses across API endpoints
 */

/**
 * Base error class for HPC-related errors
 */
class HpcError extends Error {
  constructor(message, code = 500, details = {}) {
    super(message);
    this.name = 'HpcError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      type: this.name,
      details: this.details,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Validation errors (400 Bad Request)
 */
class ValidationError extends HpcError {
  constructor(message, details = {}) {
    super(message, 400, details);
    this.name = 'ValidationError';
  }
}

/**
 * SSH/connection errors (502 Bad Gateway)
 */
class SshError extends HpcError {
  constructor(message, details = {}) {
    super(message, 502, details);
    this.name = 'SshError';
  }
}

/**
 * SLURM job errors (500 Internal Server Error)
 */
class JobError extends HpcError {
  constructor(message, details = {}) {
    super(message, 500, details);
    this.name = 'JobError';
  }
}

/**
 * Tunnel errors (502 Bad Gateway)
 */
class TunnelError extends HpcError {
  constructor(message, details = {}) {
    super(message, 502, details);
    this.name = 'TunnelError';
  }
}

/**
 * Rate limiting / lock errors (429 Too Many Requests)
 */
class LockError extends HpcError {
  constructor(message, details = {}) {
    super(message, 429, details);
    this.name = 'LockError';
  }
}

/**
 * Not found errors (404 Not Found)
 */
class NotFoundError extends HpcError {
  constructor(message, details = {}) {
    super(message, 404, details);
    this.name = 'NotFoundError';
  }
}

module.exports = {
  HpcError,
  ValidationError,
  SshError,
  JobError,
  TunnelError,
  LockError,
  NotFoundError,
};
