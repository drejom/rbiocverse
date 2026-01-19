/**
 * Database Migration
 * Migrates data from JSON files to SQLite
 */

const fs = require('fs');
const path = require('path');
const { getDb, needsMigration } = require('../db');
const { log } = require('../logger');
const users = require('./users');
const sessions = require('./sessions');
const health = require('./health');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/**
 * Run migration from JSON files to SQLite
 * @returns {Object} Migration results
 */
function runMigration() {
  const results = {
    users: 0,
    sessions: 0,
    clusterCache: 0,
    healthHistory: 0,
    errors: [],
  };

  // Ensure database is initialized
  getDb();

  // Migrate users.json
  const usersFile = path.join(DATA_DIR, 'users.json');
  if (fs.existsSync(usersFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      results.users = users.migrateFromJson(data);

      // Rename to .migrated
      fs.renameSync(usersFile, usersFile + '.migrated');
      log.info('Renamed users.json to users.json.migrated');
    } catch (err) {
      log.error('Failed to migrate users.json', { error: err.message });
      results.errors.push(`users.json: ${err.message}`);
    }
  }

  // Migrate state.json
  const stateFile = process.env.STATE_FILE || path.join(DATA_DIR, 'state.json');
  if (fs.existsSync(stateFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

      // Migrate active sessions
      if (data.sessions) {
        results.sessions = sessions.migrateActiveSessions(data.sessions);
      }

      // Migrate cluster health cache
      if (data.clusterHealth) {
        results.clusterCache = health.migrateClusterCache(data.clusterHealth);
      }

      // Migrate activeSession state
      if (data.activeSession) {
        const db = getDb();
        db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
          .run('activeSession', JSON.stringify(data.activeSession));
      }

      // Rename to .migrated
      fs.renameSync(stateFile, stateFile + '.migrated');
      log.info('Renamed state.json to state.json.migrated');
    } catch (err) {
      log.error('Failed to migrate state.json', { error: err.message });
      results.errors.push(`state.json: ${err.message}`);
    }
  }

  // Migrate health-history/*.json files
  const healthHistoryDir = path.join(DATA_DIR, 'health-history');
  if (fs.existsSync(healthHistoryDir)) {
    try {
      const files = fs.readdirSync(healthHistoryDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(healthHistoryDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (data.cluster && data.entries) {
            const count = health.migrateHealthHistory(data.cluster, data.entries);
            results.healthHistory += count;
          }
          // Rename to .migrated
          fs.renameSync(filePath, filePath + '.migrated');
        } catch (fileErr) {
          log.warn('Failed to migrate health history file', { file, error: fileErr.message });
          results.errors.push(`${file}: ${fileErr.message}`);
        }
      }
      log.info('Migrated health history files', { count: files.length });
    } catch (err) {
      log.error('Failed to read health-history directory', { error: err.message });
      results.errors.push(`health-history: ${err.message}`);
    }
  }

  log.info('Migration complete', {
    users: results.users,
    sessions: results.sessions,
    clusterCache: results.clusterCache,
    healthHistory: results.healthHistory,
    errors: results.errors.length,
  });

  return results;
}

/**
 * Check and run migration if needed
 * @returns {Object|null} Migration results if run, null if not needed
 */
function checkAndMigrate() {
  if (needsMigration()) {
    log.info('JSON files detected, running migration to SQLite');
    return runMigration();
  }
  return null;
}

module.exports = {
  runMigration,
  checkAndMigrate,
};
