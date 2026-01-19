/**
 * User Data Store
 * Persistent storage for user authentication data, SSH keys, and setup state
 *
 * This is a thin wrapper that delegates to the SQLite database module.
 * Maintains backwards compatibility with existing code.
 */

const path = require('path');
const { log } = require('../logger');
const dbUsers = require('../db/users');
const { initializeDb } = require('../db');
const { checkAndMigrate } = require('../db/migrate');

// Legacy path reference for compatibility
const USER_DATA_FILE = process.env.USER_DATA_FILE || path.join(__dirname, '..', '..', 'data', 'users.json');

// In-memory cache for compatibility with code that expects Map
let usersCache = null;

/**
 * Load users from database
 * Also runs migration if JSON files exist
 */
function loadUsers() {
  try {
    // Initialize database
    initializeDb();

    // Check and run migration from JSON if needed
    checkAndMigrate();

    // Load users into cache
    usersCache = dbUsers.getAllUsers();
    log.info('Loaded user data from database', { count: usersCache.size });
  } catch (err) {
    log.error('Failed to load user data', { error: err.message });
    usersCache = new Map();
  }
}

/**
 * Save users to database
 * This is now a no-op since setUser saves immediately
 * Kept for backwards compatibility
 */
function saveUsers() {
  // Database saves are immediate in setUser()
  // This function is kept for backwards compatibility
}

/**
 * Get a user by username
 * @param {string} username
 * @returns {Object|undefined}
 */
function getUser(username) {
  return dbUsers.getUser(username);
}

/**
 * Set a user record
 * @param {string} username
 * @param {Object} user
 */
function setUser(username, user) {
  dbUsers.setUser(username, user);
  // Update cache
  if (usersCache) {
    usersCache.set(username, user);
  }
}

/**
 * Get all users
 * @returns {Map}
 */
function getAllUsers() {
  // Return fresh data from database
  return dbUsers.getAllUsers();
}

module.exports = {
  loadUsers,
  saveUsers,
  getUser,
  setUser,
  getAllUsers,
  USER_DATA_FILE,
};
