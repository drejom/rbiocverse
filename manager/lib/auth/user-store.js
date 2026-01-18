/**
 * User Data Store
 * Persistent storage for user authentication data, SSH keys, and setup state
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../logger');

// Persistent user data file (tracks setupComplete, public keys, etc.)
const USER_DATA_FILE = path.join(__dirname, '..', '..', 'data', 'users.json');

// Persistent user store (JSON file)
// Structure: { username: { fullName, publicKey, privateKey, setupComplete, createdAt } }
// publicKey: null (no managed key) or "ssh-ed25519 ..." (managed key exists)
// privateKey: null (no managed key) or encrypted private key (for SSH connections)
//
// Private keys are encrypted at rest using password-derived AES-256-GCM.
// Format v2: "enc:v2:<salt_hex>:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
// Legacy v1 keys need re-encryption on next login.
let users = new Map();

/**
 * Load users from disk
 */
function loadUsers() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
      users = new Map(Object.entries(data));
      log.info('Loaded user data', { count: users.size });
    }
  } catch (err) {
    log.error('Failed to load user data', { error: err.message });
  }
}

/**
 * Save users to disk atomically
 * Uses temp file + rename to prevent corruption on crash/interrupt
 */
function saveUsers() {
  try {
    const dir = path.dirname(USER_DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = Object.fromEntries(users);
    // Write to temp file first, then atomically rename
    const tempFile = `${USER_DATA_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    fs.renameSync(tempFile, USER_DATA_FILE);
  } catch (err) {
    log.error('Failed to save user data', { error: err.message });
  }
}

/**
 * Get a user by username
 * @param {string} username
 * @returns {Object|undefined}
 */
function getUser(username) {
  return users.get(username);
}

/**
 * Set a user record
 * @param {string} username
 * @param {Object} user
 */
function setUser(username, user) {
  users.set(username, user);
}

/**
 * Get all users
 * @returns {Map}
 */
function getAllUsers() {
  return users;
}

module.exports = {
  loadUsers,
  saveUsers,
  getUser,
  setUser,
  getAllUsers,
  USER_DATA_FILE,
};
