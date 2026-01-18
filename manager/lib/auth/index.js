/**
 * Auth Module Index
 * Re-exports all auth-related functions for convenient importing
 */

const { generateToken, verifyToken } = require('./token');
const { generateSshKeypair, encryptPrivateKey, decryptPrivateKey } = require('./ssh');
const { loadUsers, saveUsers, getUser, setUser, getAllUsers, USER_DATA_FILE } = require('./user-store');

module.exports = {
  // Token functions
  generateToken,
  verifyToken,

  // SSH key functions
  generateSshKeypair,
  encryptPrivateKey,
  decryptPrivateKey,

  // User store functions
  loadUsers,
  saveUsers,
  getUser,
  setUser,
  getAllUsers,
  USER_DATA_FILE,
};
