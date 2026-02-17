/**
 * Admin Authorization Helper
 * Determines admin status based on ADMIN_USERS environment variable
 *
 * Security model:
 * - Admin users defined by ADMIN_USERS env var (comma-separated)
 * - Primary admin (first in list) is used for HPC operations when user has no key
 * - Supports backwards compatibility with ADMIN_USER (single user)
 */

import { Request, Response, NextFunction } from 'express';
import { log } from '../logger';

// Parse admin users from environment
// Supports both ADMIN_USERS (comma-separated) and legacy ADMIN_USER (single)
function parseAdminUsers(): string[] {
  const adminUsersEnv = process.env.ADMIN_USERS;
  const legacyAdminUser = process.env.ADMIN_USER;

  if (adminUsersEnv) {
    return adminUsersEnv
      .split(',')
      .map(u => u.trim())
      .filter(u => u.length > 0);
  }

  if (legacyAdminUser) {
    return [legacyAdminUser.trim()];
  }

  return [];
}

const ADMIN_USERS = parseAdminUsers();

// Legacy export for backwards compatibility
const ADMIN_USER: string | null = ADMIN_USERS.length > 0 ? ADMIN_USERS[0] : null;

if (process.env.NODE_ENV !== 'test') {
  if (ADMIN_USERS.length > 0) {
    log.info('Admin users configured', { users: ADMIN_USERS, count: ADMIN_USERS.length });
  } else {
    log.info('No admin users configured (ADMIN_USERS not set)');
  }
}

/**
 * Check if a username is an admin
 * @param username - Username to check
 * @returns True if user is admin
 */
function isAdmin(username: string | undefined | null): boolean {
  if (!username || ADMIN_USERS.length === 0) return false;
  return ADMIN_USERS.includes(username);
}

/**
 * Get list of all admin users
 * @returns Array of admin usernames
 */
function getAdminUsers(): string[] {
  return [...ADMIN_USERS];
}

/**
 * Get the primary admin (first in the list)
 * Used for HPC operations when user has no key
 * @returns Primary admin username or null if none configured
 */
function getPrimaryAdmin(): string | null {
  return ADMIN_USERS.length > 0 ? ADMIN_USERS[0] : null;
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
  getAdminUsers,
  getPrimaryAdmin,
  ADMIN_USERS,
  ADMIN_USER, // Legacy export for backwards compatibility
};

// CommonJS compatibility for existing require() calls
module.exports = {
  isAdmin,
  requireAdmin,
  getAdminUsers,
  getPrimaryAdmin,
  ADMIN_USERS,
  ADMIN_USER,
};
