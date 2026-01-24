/**
 * User Database Operations
 * Replaces lib/auth/user-store.js JSON file operations
 */

import { getDb } from '../db';
import { log } from '../logger';

export interface User {
  username: string;
  fullName: string | null;
  publicKey: string | null;
  privateKey: string | null;
  setupComplete: boolean;
  createdAt: string | null;
  lastLogin: string | null;
}

interface UserRow {
  username: string;
  full_name: string | null;
  public_key: string | null;
  private_key_encrypted: string | null;
  setup_complete: number;
  created_at: string | null;
  last_login: string | null;
}

/**
 * Convert database row to user object
 * @param row - Database row
 * @returns User object
 */
function rowToUser(row: UserRow): User {
  return {
    username: row.username,
    fullName: row.full_name,
    publicKey: row.public_key,
    privateKey: row.private_key_encrypted,
    setupComplete: !!row.setup_complete,
    createdAt: row.created_at,
    lastLogin: row.last_login,
  };
}

/**
 * Get a user by username
 * @param username
 * @returns User object or undefined
 */
function getUser(username: string): User | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!row) return undefined;
  return rowToUser(row);
}

/**
 * Set/update a user record
 * @param username
 * @param user - User data
 */
function setUser(username: string, user: Partial<User>): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO users (
      username, full_name, public_key, private_key_encrypted,
      setup_complete, created_at, last_login
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    username,
    user.fullName || null,
    user.publicKey || null,
    user.privateKey || null,
    user.setupComplete ? 1 : 0,
    user.createdAt || null,
    user.lastLogin || null
  );
}

/**
 * Delete a user
 * @param username
 * @returns True if user was deleted
 */
function deleteUser(username: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM users WHERE username = ?').run(username);
  return result.changes > 0;
}

/**
 * Get all users
 * @returns Map of username -> user object
 */
function getAllUsers(): Map<string, User> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users').all() as UserRow[];
  const users = new Map<string, User>();

  for (const row of rows) {
    users.set(row.username, rowToUser(row));
  }

  return users;
}

/**
 * Get user count
 * @returns Total number of users
 */
function getUserCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return row.count;
}

/**
 * Update user's last login timestamp
 * @param username
 */
function updateLastLogin(username: string): void {
  const db = getDb();
  db.prepare('UPDATE users SET last_login = ? WHERE username = ?')
    .run(new Date().toISOString(), username);
}

/**
 * Migrate users from JSON file to database
 * @param usersData - Object mapping username -> user data
 * @returns Number of users migrated
 */
function migrateFromJson(usersData: Record<string, Partial<User>>): number {
  const db = getDb();
  let count = 0;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO users (
      username, full_name, public_key, private_key_encrypted,
      setup_complete, created_at, last_login
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    for (const [username, user] of Object.entries(usersData)) {
      insert.run(
        username,
        user.fullName || null,
        user.publicKey || null,
        user.privateKey || null,
        user.setupComplete ? 1 : 0,
        user.createdAt || null,
        user.lastLogin || null
      );
      count++;
    }
  });

  transaction();
  log.info('Migrated users to database', { count });
  return count;
}

export {
  getUser,
  setUser,
  deleteUser,
  getAllUsers,
  getUserCount,
  updateLastLogin,
  migrateFromJson,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  getUser,
  setUser,
  deleteUser,
  getAllUsers,
  getUserCount,
  updateLastLogin,
  migrateFromJson,
};
