/**
 * Admin Authorization Helper
 * Determines admin status based on ADMIN_USER environment variable
 *
 * Security model:
 * - Single admin user defined by ADMIN_USER env var
 * - The admin user is typically the one whose SSH keys are on the container
 * - This simplifies security: only one user has fallback SSH access
 */

const { log } = require('../logger');

// Admin username from environment (single user)
const ADMIN_USER = process.env.ADMIN_USER || null;

if (process.env.NODE_ENV !== 'test') {
  if (ADMIN_USER) {
    log.info('Admin user configured', { user: ADMIN_USER });
  } else {
    log.info('No admin user configured (ADMIN_USER not set)');
  }
}

/**
 * Check if a username is an admin
 * @param {string} username - Username to check
 * @returns {boolean} True if user is admin
 */
function isAdmin(username) {
  if (!ADMIN_USER || !username) return false;
  return username === ADMIN_USER;
}

/**
 * Express middleware to require admin access
 * Must be used after requireAuth middleware
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!isAdmin(req.user.username)) {
    log.warn('Admin access denied', { username: req.user.username });
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}

module.exports = {
  isAdmin,
  requireAdmin,
  ADMIN_USER,
};
