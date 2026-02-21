/**
 * Database Module Index
 * Re-exports all database operations
 */

import * as db from '../db';
import * as users from './users';
import * as sessions from './sessions';
import * as health from './health';
import * as analytics from './analytics';
import * as settings from './settings';

export {
  // Core database operations
  db,

  // Domain-specific modules
  users,
  sessions,
  health,
  analytics,
  settings,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  // Core database operations
  ...db,

  // Domain-specific modules
  users,
  sessions,
  health,
  analytics,
  settings,
};
