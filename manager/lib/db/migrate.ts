/**
 * Database Migration
 * Migrates data from JSON files to SQLite
 */

import fs from 'fs';
import path from 'path';
import { getDb, needsMigration } from '../db';
import { log } from '../logger';
import { errorDetails, errorMessage } from '../errors';
import * as users from './users';
import * as sessions from './sessions';
import * as health from './health';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

interface MigrationResults {
  users: number;
  sessions: number;
  clusterCache: number;
  healthHistory: number;
  errors: string[];
}

interface StateJson {
  sessions?: Record<string, unknown>;
  clusterHealth?: Record<string, unknown>;
  activeSession?: unknown;
}

interface HealthHistoryJson {
  cluster?: string;
  entries?: Array<{ timestamp: number; cpus?: number; memory?: number; nodes?: number; gpus?: number }>;
}

/**
 * Run migration from JSON files to SQLite
 */
function runMigration(): MigrationResults {
  const results: MigrationResults = {
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
      log.error('Failed to migrate users.json', errorDetails(err));
      results.errors.push(`users.json: ${errorMessage(err)}`);
    }
  }

  // Migrate state.json
  const stateFile = process.env.STATE_FILE || path.join(DATA_DIR, 'state.json');
  if (fs.existsSync(stateFile)) {
    try {
      const data: StateJson = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

      // Migrate active sessions
      if (data.sessions) {
        results.sessions = sessions.migrateActiveSessions(data.sessions as Record<string, sessions.Session>);
      }

      // Migrate cluster health cache
      if (data.clusterHealth) {
        results.clusterCache = health.migrateClusterCache(data.clusterHealth as Parameters<typeof health.migrateClusterCache>[0]);
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
      log.error('Failed to migrate state.json', errorDetails(err));
      results.errors.push(`state.json: ${errorMessage(err)}`);
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
          const data: HealthHistoryJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (data.cluster && data.entries) {
            const count = health.migrateHealthHistory(data.cluster, data.entries);
            results.healthHistory += count;
          }
          // Rename to .migrated
          fs.renameSync(filePath, filePath + '.migrated');
        } catch (fileErr) {
          log.warn('Failed to migrate health history file', { file, ...errorDetails(fileErr) });
          results.errors.push(`${file}: ${errorMessage(fileErr)}`);
        }
      }
      log.info('Migrated health history files', { count: files.length });
    } catch (err) {
      log.error('Failed to read health-history directory', errorDetails(err));
      results.errors.push(`health-history: ${errorMessage(err)}`);
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
 */
function checkAndMigrate(): MigrationResults | null {
  if (needsMigration()) {
    log.info('JSON files detected, running migration to SQLite');
    return runMigration();
  }
  return null;
}

export {
  runMigration,
  checkAndMigrate,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  runMigration,
  checkAndMigrate,
};
