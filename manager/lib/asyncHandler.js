/**
 * Async Handler - Centralized error handling for Express routes
 *
 * Wraps async route handlers to catch errors and pass to Express error middleware.
 * Eliminates repetitive try/catch blocks in route handlers.
 *
 * Usage:
 *   const asyncHandler = require('../lib/asyncHandler');
 *
 *   router.get('/users', asyncHandler(async (req, res) => {
 *     const users = await getUsers();
 *     res.json(users);
 *     // No try/catch needed - errors automatically passed to error middleware
 *   }));
 */

/**
 * Wrap an async route handler to catch errors
 * @param {Function} fn - Async route handler (req, res, next) => Promise
 * @returns {Function} Wrapped handler that catches errors
 */
const asyncHandler = (fn) => (req, res, next) => {
  // Use try/catch to also handle synchronous throws
  try {
    Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    next(err);
  }
};

module.exports = asyncHandler;
