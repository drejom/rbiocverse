/**
 * Admin Authorization Helper
 * Determines admin status based on ADMIN_USER environment variable
 *
 * Security model:
 * - Single admin user defined by ADMIN_USER env var
 * - The admin user is typically the one whose SSH keys are on the container
 * - This simplifies security: only one user has fallback SSH access
 */

import { Request, Response, NextFunction } from 'express';
import { log } from '../logger';

// Admin username from environment (single user)
const ADMIN_USER: string | null = process.env.ADMIN_USER || null;

if (process.env.NODE_ENV !== 'test') {
  if (ADMIN_USER) {
    log.info('Admin user configured', { user: ADMIN_USER });
  } else {
    log.info('No admin user configured (ADMIN_USER not set)');
  }
}

/**
 * Check if a username is an admin
 * @param username - Username to check
 * @returns True if user is admin
 */
function isAdmin(username: string | undefined | null): boolean {
  if (!ADMIN_USER || !username) return false;
  return username === ADMIN_USER;
}

/**
 * Express middleware to require admin access
 * Must be used after requireAuth middleware
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { username: string } }).user;

  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!isAdmin(user.username)) {
    log.warn('Admin access denied', { username: user.username });
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}

export {
  isAdmin,
  requireAdmin,
  ADMIN_USER,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  isAdmin,
  requireAdmin,
  ADMIN_USER,
};
