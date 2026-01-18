/**
 * User Data Store
 * Persistent storage for user authentication data, SSH keys, and setup state
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../logger');
const { encryptPrivateKey } = require('./ssh');

// Persistent user data file (tracks setupComplete, public keys, etc.)
const USER_DATA_FILE = path.join(__dirname, '..', '..', 'data', 'users.json');

// Persistent user store (JSON file)
// Structure: { username: { fullName, publicKey, privateKey, setupComplete, createdAt } }
// publicKey: null (no managed key) or "ssh-ed25519 ..." (managed key exists)
// privateKey: null (no managed key) or encrypted private key (for SSH connections)
//
// Private keys are encrypted at rest using AES-256-GCM with a key derived from JWT_SECRET.
// Format: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
let users = new Map();

/**
 * Load users from disk with migration for keyMode removal and key encryption
 */
function loadUsers() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));

      let needsSave = false;
      for (const [username, user] of Object.entries(data)) {
        // Migrate: remove keyMode field if present (no longer used)
        if ('keyMode' in user) {
          delete user.keyMode;
          needsSave = true;
          log.info('Migrated user: removed keyMode field', { username });
        }

        // Migrate: encrypt plaintext private keys
        if (user.privateKey && user.privateKey.startsWith('-----BEGIN')) {
          user.privateKey = encryptPrivateKey(user.privateKey);
          needsSave = true;
          log.info('Migrated user: encrypted private key', { username });
        }
      }

      users = new Map(Object.entries(data));
      log.info('Loaded user data', { count: users.size });

      // Save migration changes
      if (needsSave) {
        saveUsers();
      }
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
