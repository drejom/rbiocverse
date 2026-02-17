/**
 * Database Module Index
 * Re-exports all database operations
 */

const db = require('../db');
const users = require('./users');
const sessions = require('./sessions');
const health = require('./health');
const analytics = require('./analytics');

module.exports = {
  // Core database operations
  ...db,

  // Domain-specific modules
  users,
  sessions,
  health,
  analytics,
};
