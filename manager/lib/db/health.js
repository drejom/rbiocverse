/**
 * Cluster Health Database Operations
 * Handles cluster cache and health history
 *
 * Uses healthSchema.js for all field mappings (DRY principle)
 */

const { getDb } = require('../db');
const { log } = require('../logger');
const schema = require('./healthSchema');

// ============================================
// Cluster Cache (Current Health)
// ============================================

/**
 * Get cached cluster health
 * @param {string} hpc - Cluster name
 * @returns {Object|null}
 */
function getClusterCache(hpc) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM cluster_cache WHERE hpc = ?').get(hpc);
  return schema.rowToHealth(row);
}

/**
 * Save cluster health to cache
 * @param {string} hpc - Cluster name
 * @param {Object} health - Health data
 */
function saveClusterCache(hpc, health) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cluster_cache (
      hpc, online, cpus_used, cpus_idle, cpus_total, cpus_percent,
      memory_used, memory_total, memory_percent,
      nodes_idle, nodes_busy, nodes_down, nodes_total, nodes_percent,
      gpus_json, partitions_json, running_jobs, pending_jobs,
      fairshare, last_checked, consecutive_failures, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(...schema.healthToRow(hpc, health));
}

/**
 * Get all cluster caches
 * @returns {Object} Map of hpc -> health
 */
function getAllClusterCaches() {
  const db = getDb();
  // Single query to get all clusters at once (no N+1)
  const rows = db.prepare('SELECT * FROM cluster_cache').all();
  const caches = {};

  for (const row of rows) {
    caches[row.hpc] = schema.rowToHealth(row);
  }

  return caches;
}

/**
 * Update consecutive failures counter
 * @param {string} hpc
 * @param {number} failures
 */
function updateConsecutiveFailures(hpc, failures) {
  const db = getDb();
  db.prepare('UPDATE cluster_cache SET consecutive_failures = ? WHERE hpc = ?')
    .run(failures, hpc);
}

// ============================================
// Cluster Health History
// ============================================

/**
 * Add health snapshot to history
 * @param {string} hpc - Cluster name
 * @param {Object} health - Health data with percentages
 */
function addHealthSnapshot(hpc, health) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO cluster_health (
      hpc, timestamp, cpus_percent, memory_percent, nodes_percent, gpus_percent,
      running_jobs, pending_jobs, a100_cpus_percent, v100_cpus_percent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(...schema.healthToHistoryRow(hpc, health));
}

/**
 * Get health history for a cluster
 * @param {string} hpc - Cluster name
 * @param {Object} [options]
 * @param {number} [options.days=1] - Number of days to look back
 * @param {number} [options.limit] - Max records to return
 * @returns {Array<Object>}
 */
function getHealthHistory(hpc, options = {}) {
  const db = getDb();
  const { days = 1, limit } = options;

  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  let sql = `
    SELECT * FROM cluster_health
    WHERE hpc = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `;
  const params = [hpc, cutoff];

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

/**
 * Get health history for all clusters
 * @param {Object} [options]
 * @param {number} [options.days=1] - Number of days to look back
 * @returns {Object} Map of hpc -> history array
 */
function getAllHealthHistory(options = {}) {
  const db = getDb();
  const { days = 1 } = options;

  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  const rows = db.prepare(`
    SELECT * FROM cluster_health
    WHERE timestamp >= ?
    ORDER BY hpc, timestamp ASC
  `).all(cutoff);

  const history = {};
  for (const row of rows) {
    if (!history[row.hpc]) {
      history[row.hpc] = [];
    }
    history[row.hpc].push(schema.historyRowToEntry(row));
  }

  return history;
}

/**
 * Delete old health history (retention policy)
 * @param {number} [daysToKeep=365] - Keep history for this many days
 * @returns {number} Number of rows deleted
 */
function pruneHealthHistory(daysToKeep = 365) {
  const db = getDb();
  const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
  const result = db.prepare('DELETE FROM cluster_health WHERE timestamp < ?').run(cutoff);
  if (result.changes > 0) {
    log.info('Pruned old health history', { deleted: result.changes, daysToKeep });
  }
  return result.changes;
}

/**
 * Get daily aggregated health data for heatmaps
 * @param {string} hpc - Cluster name
 * @param {number} [days=365] - Number of days
 * @returns {Array<Object>}
 */
function getDailyHealthAggregates(hpc, days = 365) {
  const db = getDb();
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  // SQLite doesn't have great date functions, so we group by day
  // timestamp is stored as milliseconds, divide by 86400000 to get day
  const rows = db.prepare(`
    SELECT
      date(timestamp / 1000, 'unixepoch') as date,
      AVG(cpus_percent) as avg_cpus,
      AVG(memory_percent) as avg_memory,
      AVG(nodes_percent) as avg_nodes,
      AVG(gpus_percent) as avg_gpus,
      AVG(a100_cpus_percent) as avg_a100,
      AVG(v100_cpus_percent) as avg_v100,
      MAX(cpus_percent) as max_cpus,
      MAX(memory_percent) as max_memory,
      SUM(running_jobs) as total_running,
      SUM(pending_jobs) as total_pending,
      COUNT(*) as sample_count
    FROM cluster_health
    WHERE hpc = ? AND timestamp >= ?
    GROUP BY date(timestamp / 1000, 'unixepoch')
    ORDER BY date ASC
  `).all(hpc, cutoff);

  return rows.map(row => ({
    date: row.date,
    avgCpus: Math.round(row.avg_cpus || 0),
    avgMemory: Math.round(row.avg_memory || 0),
    avgNodes: Math.round(row.avg_nodes || 0),
    avgGpus: row.avg_gpus ? Math.round(row.avg_gpus) : null,
    avgA100: row.avg_a100 ? Math.round(row.avg_a100) : null,
    avgV100: row.avg_v100 ? Math.round(row.avg_v100) : null,
    maxCpus: row.max_cpus,
    maxMemory: row.max_memory,
    totalRunning: row.total_running,
    totalPending: row.total_pending,
    sampleCount: row.sample_count,
  }));
}

/**
 * Migrate health history from JSON files
 * @param {string} hpc - Cluster name
 * @param {Array<Object>} entries - Health entries from JSON
 * @returns {number} Number of entries migrated
 */
function migrateHealthHistory(hpc, entries) {
  const db = getDb();
  let count = 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO cluster_health (
      hpc, timestamp, cpus_percent, memory_percent, nodes_percent, gpus_percent,
      running_jobs, pending_jobs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    for (const entry of entries) {
      insert.run(
        hpc,
        entry.timestamp,
        entry.cpus || null,
        entry.memory || null,
        entry.nodes || null,
        entry.gpus || null,
        0, // Old format didn't track job counts
        0
      );
      count++;
    }
  });

  transaction();
  log.info('Migrated health history to database', { hpc, count });
  return count;
}

/**
 * Migrate cluster cache from state object
 * @param {Object} clusterHealth - clusterHealth object from state.json
 * @returns {number} Number of clusters migrated
 */
function migrateClusterCache(clusterHealth) {
  const db = getDb();
  let count = 0;

  const transaction = db.transaction(() => {
    for (const [hpc, data] of Object.entries(clusterHealth)) {
      if (data?.current) {
        saveClusterCache(hpc, {
          ...data.current,
          consecutiveFailures: data.consecutiveFailures || 0,
        });
        count++;
      }

      // Also migrate in-memory history if present
      if (data?.history && Array.isArray(data.history)) {
        migrateHealthHistory(hpc, data.history);
      }
    }
  });

  transaction();
  log.info('Migrated cluster cache to database', { count });
  return count;
}

module.exports = {
  // Cluster cache
  getClusterCache,
  saveClusterCache,
  getAllClusterCaches,
  updateConsecutiveFailures,

  // Health history
  addHealthSnapshot,
  getHealthHistory,
  getAllHealthHistory,
  pruneHealthHistory,
  getDailyHealthAggregates,

  // Migration
  migrateHealthHistory,
  migrateClusterCache,
};
