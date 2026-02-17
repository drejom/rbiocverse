/**
 * Async Route Handler
 * Wraps async route handlers to catch errors and pass to Express error handler
 *
 * Also enriches error context with request information.
 */

const { errorLogger } = require('../services/ErrorLogger');

/**
 * Extract request context for error logging
 * @param {Request} req - Express request
 * @returns {Object} Request context
 */
function getRequestContext(req) {
  return {
    method: req.method,
    url: req.originalUrl || req.url,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers?.['user-agent'],
    user: req.user?.username || 'anonymous',
  };
}

/**
 * Wrap async route handler to catch errors
 * @param {Function} fn - Async route handler
 * @returns {Function} Wrapped handler
 */
const asyncHandler = (fn) => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      // Enrich error with request context
      err.requestContext = getRequestContext(req);
      next(err);
    });
  } catch (err) {
    // Catch sync throws
    err.requestContext = getRequestContext(req);
    next(err);
  }
};

/**
 * Express error middleware with structured logging
 * Mount this after all routes: app.use(errorMiddleware)
 */
function errorMiddleware(err, req, res, next) {
  const context = err.requestContext || getRequestContext(req);

  // Log to ErrorLogger for persistence
  errorLogger.logError({
    user: context.user,
    action: `${context.method} ${context.url}`,
    error: err,
    context: {
      ip: context.ip,
      userAgent: context.userAgent,
      statusCode: err.status || err.statusCode || 500,
    },
  }).catch(() => {
    // Ignore ErrorLogger failures
  });

  // Send response
  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
}

module.exports = asyncHandler;
module.exports.asyncHandler = asyncHandler;
module.exports.errorMiddleware = errorMiddleware;
module.exports.getRequestContext = getRequestContext;
