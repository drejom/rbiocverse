/**
 * Async Route Handler
 * Wraps async route handlers to catch errors and pass to Express error handler
 *
 * Also enriches error context with request information.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { errorLogger } from '../services/ErrorLogger';

interface RequestContext {
  method: string;
  url: string;
  ip: string | undefined;
  userAgent: string | undefined;
  user: string;
}

interface AuthenticatedRequest extends Request {
  user?: {
    username: string;
  };
}

interface EnrichedError extends Error {
  requestContext?: RequestContext;
  status?: number;
  statusCode?: number;
}

/**
 * Extract request context for error logging
 */
function getRequestContext(req: Request): RequestContext {
  const authReq = req as AuthenticatedRequest;
  return {
    method: req.method,
    url: req.originalUrl || req.url,
    ip: req.ip || req.socket?.remoteAddress,
    userAgent: req.headers?.['user-agent'],
    user: authReq.user?.username || 'anonymous',
  };
}

/**
 * Wrap async route handler to catch errors
 */
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      Promise.resolve(fn(req, res, next)).catch((err: EnrichedError) => {
        // Enrich error with request context
        err.requestContext = getRequestContext(req);
        next(err);
      });
    } catch (err) {
      // Catch sync throws
      (err as EnrichedError).requestContext = getRequestContext(req);
      next(err);
    }
  };
};

/**
 * Express error middleware with structured logging
 * Mount this after all routes: app.use(errorMiddleware)
 */
function errorMiddleware(err: EnrichedError, req: Request, res: Response, _next: NextFunction): void {
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

export default asyncHandler;
export { asyncHandler, errorMiddleware, getRequestContext };

// CommonJS compatibility for existing require() calls
// Supports both: require('./asyncHandler') and require('./asyncHandler').asyncHandler
module.exports = asyncHandler;
module.exports.asyncHandler = asyncHandler;
module.exports.errorMiddleware = errorMiddleware;
module.exports.getRequestContext = getRequestContext;
