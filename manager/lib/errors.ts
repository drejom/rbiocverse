/**
 * Custom error classes for structured error handling
 * Provides consistent error responses across API endpoints
 */

interface ErrorDetails {
  [key: string]: unknown;
}

interface ErrorJSON {
  error: string;
  code: number;
  type: string;
  details: ErrorDetails;
  timestamp: string;
}

/**
 * Base error class for HPC-related errors
 */
class HpcError extends Error {
  code: number;
  details: ErrorDetails;

  constructor(message: string, code = 500, details: ErrorDetails = {}) {
    super(message);
    this.name = 'HpcError';
    this.code = code;
    this.details = details;
  }

  toJSON(): ErrorJSON {
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
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, 400, details);
    this.name = 'ValidationError';
  }
}

/**
 * SSH/connection errors (502 Bad Gateway)
 */
class SshError extends HpcError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, 502, details);
    this.name = 'SshError';
  }
}

/**
 * SLURM job errors (500 Internal Server Error)
 */
class JobError extends HpcError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, 500, details);
    this.name = 'JobError';
  }
}

/**
 * Tunnel errors (502 Bad Gateway)
 */
class TunnelError extends HpcError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, 502, details);
    this.name = 'TunnelError';
  }
}

/**
 * Rate limiting / lock errors (429 Too Many Requests)
 */
class LockError extends HpcError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, 429, details);
    this.name = 'LockError';
  }
}

/**
 * Not found errors (404 Not Found)
 */
class NotFoundError extends HpcError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, 404, details);
    this.name = 'NotFoundError';
  }
}

export {
  HpcError,
  ValidationError,
  SshError,
  JobError,
  TunnelError,
  LockError,
  NotFoundError,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  HpcError,
  ValidationError,
  SshError,
  JobError,
  TunnelError,
  LockError,
  NotFoundError,
};
