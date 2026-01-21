/**
 * Database Connection and Schema Management
 * Central SQLite database for all application data
 *
 * Replaces scattered JSON files:
 * - data/users.json -> users table
 * - data/state.json -> active_sessions, cluster_cache, app_state tables
 * - data/health-history/*.json -> cluster_health table
 * - (new) session_history table for analytics
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Database path priority:
// 1. DB_PATH env var (for testing or custom paths)
// 2. /data/app.db (Docker volume mount - production)
// 3. ./data/app.db (local development fallback)
function getDefaultDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  // In production (Docker), use the mounted /data volume
  const dockerPath = '/data/app.db';
  if (fs.existsSync('/data') || process.env.NODE_ENV === 'production') {
    return dockerPath;
  }

  // Local development fallback
  return path.join(__dirname, '..', 'data', 'app.db');
}

const DEFAULT_DB_PATH = getDefaultDbPath();

let db = null;

/**
 * Initialize database connection and schema
 * @param {string} [dbPath] - Optional database path (defaults to DEFAULT_DB_PATH)
 * @returns {Database} The database connection
 */
function initializeDb(dbPath = DEFAULT_DB_PATH) {
  if (db) return db;

  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent performance
  db.pragma('journal_mode = WAL');

  // Create schema
  db.exec(`
    -- Users (replaces users.json)
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      full_name TEXT,
      public_key TEXT,
      private_key_encrypted TEXT,
      setup_complete INTEGER DEFAULT 0,
      created_at TEXT,
      last_login TEXT
    );

    -- Active sessions (replaces state.json sessions)
    CREATE TABLE IF NOT EXISTS active_sessions (
      session_key TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      hpc TEXT NOT NULL,
      ide TEXT NOT NULL,
      status TEXT,
      job_id TEXT,
      node TEXT,
      cpus INTEGER,
      memory TEXT,
      walltime TEXT,
      gpu TEXT,
      release_version TEXT,
      account TEXT,
      token TEXT,
      submitted_at TEXT,
      started_at TEXT,
      error TEXT,
      time_left_seconds INTEGER,
      last_activity INTEGER,
      used_shiny INTEGER DEFAULT 0,
      used_live_server INTEGER DEFAULT 0
    );

    -- Session history (archives completed sessions for analytics)
    CREATE TABLE IF NOT EXISTS session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT NOT NULL,
      hpc TEXT NOT NULL,
      ide TEXT NOT NULL,
      account TEXT,
      cpus INTEGER,
      memory TEXT,
      walltime TEXT,
      gpu TEXT,
      release_version TEXT,
      submitted_at TEXT,
      started_at TEXT,
      ended_at TEXT,
      wait_seconds INTEGER,
      duration_minutes INTEGER,
      end_reason TEXT,
      error_message TEXT,
      used_shiny INTEGER DEFAULT 0,
      used_live_server INTEGER DEFAULT 0,
      job_id TEXT,
      node TEXT
    );

    -- Cluster health snapshots (replaces health-history/*.json)
    CREATE TABLE IF NOT EXISTS cluster_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hpc TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      cpus_percent INTEGER,
      memory_percent INTEGER,
      nodes_percent INTEGER,
      gpus_percent INTEGER,
      running_jobs INTEGER,
      pending_jobs INTEGER,
      -- Partition-specific CPU percentages (for GPU partitions)
      a100_cpus_percent INTEGER,
      v100_cpus_percent INTEGER
    );

    -- Cluster cache (replaces state.json clusterHealth.current)
    CREATE TABLE IF NOT EXISTS cluster_cache (
      hpc TEXT PRIMARY KEY,
      online INTEGER,
      cpus_used INTEGER,
      cpus_idle INTEGER,
      cpus_total INTEGER,
      cpus_percent INTEGER,
      memory_used INTEGER,
      memory_total INTEGER,
      memory_percent INTEGER,
      nodes_idle INTEGER,
      nodes_busy INTEGER,
      nodes_down INTEGER,
      nodes_total INTEGER,
      nodes_percent INTEGER,
      gpus_json TEXT,
      partitions_json TEXT,
      running_jobs INTEGER,
      pending_jobs INTEGER,
      fairshare REAL,
      last_checked INTEGER,
      consecutive_failures INTEGER DEFAULT 0,
      error TEXT
    );

    -- App state (replaces misc state.json fields like activeSession)
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Partition limits (dynamic SLURM partition info)
    CREATE TABLE IF NOT EXISTS partition_limits (
      cluster TEXT NOT NULL,
      partition TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      max_cpus INTEGER,
      max_mem_mb INTEGER,
      max_time TEXT,
      default_time TEXT,
      total_cpus INTEGER,
      total_nodes INTEGER,
      total_mem_mb INTEGER,
      gpu_count INTEGER,
      gpu_type TEXT,
      restricted INTEGER DEFAULT 0,
      restriction_reason TEXT,
      updated_at INTEGER,
      PRIMARY KEY (cluster, partition)
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_session_history_user ON session_history(user);
    CREATE INDEX IF NOT EXISTS idx_session_history_started ON session_history(started_at);
    CREATE INDEX IF NOT EXISTS idx_session_history_hpc ON session_history(hpc);
    CREATE INDEX IF NOT EXISTS idx_session_history_ended ON session_history(ended_at);
    CREATE INDEX IF NOT EXISTS idx_cluster_health_hpc_ts ON cluster_health(hpc, timestamp);
    CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user);
  `);

  // Run migrations for existing databases (add new columns if they don't exist)
  runMigrations(db);

  return db;
}

/**
 * Run database migrations for schema changes
 * @param {Database} database - The database connection
 */
function runMigrations(database) {
  // Check if partition columns exist in cluster_health
  const tableInfo = database.prepare('PRAGMA table_info(cluster_health)').all();
  const columns = new Set(tableInfo.map(col => col.name));

  // Migration: Add partition CPU columns
  if (!columns.has('a100_cpus_percent')) {
    database.exec('ALTER TABLE cluster_health ADD COLUMN a100_cpus_percent INTEGER');
  }
  if (!columns.has('v100_cpus_percent')) {
    database.exec('ALTER TABLE cluster_health ADD COLUMN v100_cpus_percent INTEGER');
  }
}

/**
 * Get database connection (initializes if needed)
 * @param {string} [dbPath] - Optional database path
 * @returns {Database} The database connection
 */
function getDb(dbPath) {
  if (!db) {
    initializeDb(dbPath);
  }
  return db;
}

/**
 * Close database connection
 */
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Reset database connection (for testing)
 * @param {string} [dbPath] - Optional database path
 * @returns {Database} The new database connection
 */
function resetDb(dbPath) {
  closeDb();
  return initializeDb(dbPath);
}

/**
 * Check if migration from JSON files is needed
 * @returns {boolean} True if JSON files exist and need migration
 */
function needsMigration() {
  const dataDir = path.join(__dirname, '..', 'data');
  const usersJson = path.join(dataDir, 'users.json');
  const stateJson = path.join(dataDir, 'state.json');

  return fs.existsSync(usersJson) || fs.existsSync(stateJson);
}

module.exports = {
  initializeDb,
  getDb,
  closeDb,
  resetDb,
  needsMigration,
  DEFAULT_DB_PATH,
};
