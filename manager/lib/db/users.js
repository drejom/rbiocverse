/**
 * User Database Operations
 * Replaces lib/auth/user-store.js JSON file operations
 */

const { getDb } = require('../db');
const { log } = require('../logger');

/**
 * Convert database row to user object
 * @param {Object} row - Database row
 * @returns {Object} User object
 */
function rowToUser(row) {
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
 * @param {string} username
 * @returns {Object|undefined} User object or undefined
 */
function getUser(username) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row) return undefined;
  return rowToUser(row);
}

/**
 * Set/update a user record
 * @param {string} username
 * @param {Object} user - User data
 */
function setUser(username, user) {
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
 * @param {string} username
 * @returns {boolean} True if user was deleted
 */
function deleteUser(username) {
  const db = getDb();
  const result = db.prepare('DELETE FROM users WHERE username = ?').run(username);
  return result.changes > 0;
}

/**
 * Get all users
 * @returns {Map<string, Object>} Map of username -> user object
 */
function getAllUsers() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users').all();
  const users = new Map();

  for (const row of rows) {
    users.set(row.username, rowToUser(row));
  }

  return users;
}

/**
 * Get user count
 * @returns {number} Total number of users
 */
function getUserCount() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
  return row.count;
}

/**
 * Update user's last login timestamp
 * @param {string} username
 */
function updateLastLogin(username) {
  const db = getDb();
  db.prepare('UPDATE users SET last_login = ? WHERE username = ?')
    .run(new Date().toISOString(), username);
}

/**
 * Migrate users from JSON file to database
 * @param {Object} usersData - Object mapping username -> user data
 * @returns {number} Number of users migrated
 */
function migrateFromJson(usersData) {
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

module.exports = {
  getUser,
  setUser,
  deleteUser,
  getAllUsers,
  getUserCount,
  updateLastLogin,
  migrateFromJson,
};
