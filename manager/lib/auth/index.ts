/**
 * Auth Module Index
 * Re-exports all auth-related functions for convenient importing
 *
 * Note: User data functions are now in lib/db/users.js (SQLite-backed).
 * Import from there directly for user operations.
 */

import { generateToken, verifyToken } from './token';
import { generateSshKeypair, encryptPrivateKey, decryptPrivateKey } from './ssh';
import { setSessionKey, getSessionKey, clearSessionKey, hasSessionKey } from './session-keys';

export {
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

// CommonJS compatibility for existing require() calls
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
