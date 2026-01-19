/**
 * Auth Module Index
 * Re-exports all auth-related functions for convenient importing
 *
 * Note: User data functions are now in lib/db/users.js (SQLite-backed).
 * Import from there directly for user operations.
 */

const { generateToken, verifyToken } = require('./token');
const { generateSshKeypair, encryptPrivateKey, decryptPrivateKey } = require('./ssh');
const { setSessionKey, getSessionKey, clearSessionKey, hasSessionKey } = require('./session-keys');

module.exports = {
  // Token functions
  generateToken,
  verifyToken,

  // SSH key functions
  generateSshKeypair,
  encryptPrivateKey,
  decryptPrivateKey,

  // Session key store (in-memory decrypted keys)
  setSessionKey,
  getSessionKey,
  clearSessionKey,
  hasSessionKey,
};
