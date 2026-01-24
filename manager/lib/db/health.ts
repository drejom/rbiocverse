/**
 * Cluster Health Database Operations
 * Handles cluster cache and health history
 *
 * Uses healthSchema.js for all field mappings (DRY principle)
 */

import { getDb } from '../db';
import { log } from '../logger';
import * as schema from './healthSchema';
import type { ClusterHealth, HealthHistoryEntry } from './healthSchema';

// ============================================
// Cluster Cache (Current Health)
// ============================================

/**
 * Get cached cluster health
 */
function getClusterCache(hpc: string): ClusterHealth | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM cluster_cache WHERE hpc = ?').get(hpc);
  return schema.rowToHealth(row as Parameters<typeof schema.rowToHealth>[0]);
}

/**
 * Save cluster health to cache
 */
function saveClusterCache(hpc: string, health: Partial<ClusterHealth>): void {
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
 */
function getAllClusterCaches(): Record<string, ClusterHealth> {
  const db = getDb();
  // Single query to get all clusters at once (no N+1)
  const rows = db.prepare('SELECT * FROM cluster_cache').all() as Array<{ hpc: string } & Parameters<typeof schema.rowToHealth>[0]>;
  const caches: Record<string, ClusterHealth> = {};

  for (const row of rows) {
    const health = schema.rowToHealth(row);
    if (health) {
      caches[row.hpc] = health;
    }
  }

  return caches;
}

/**
 * Update consecutive failures counter
 */
function updateConsecutiveFailures(hpc: string, failures: number): void {
  const db = getDb();
  db.prepare('UPDATE cluster_cache SET consecutive_failures = ? WHERE hpc = ?')
    .run(failures, hpc);
}

// ============================================
// Cluster Health History
// ============================================

/**
 * Add health snapshot to history
 */
function addHealthSnapshot(hpc: string, health: Partial<ClusterHealth>): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO cluster_health (
      hpc, timestamp, cpus_percent, memory_percent, nodes_percent, gpus_percent,
      running_jobs, pending_jobs, a100_cpus_percent, v100_cpus_percent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(...schema.healthToHistoryRow(hpc, health));
}

interface GetHistoryOptions {
  days?: number;
  limit?: number;
}

/**
 * Get health history for a cluster
 */
function getHealthHistory(hpc: string, options: GetHistoryOptions = {}): unknown[] {
  const db = getDb();
  const { days = 1, limit } = options;

  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  let sql = `
    SELECT * FROM cluster_health
    WHERE hpc = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `;
  const params: (string | number)[] = [hpc, cutoff];

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

/**
 * Get health history for all clusters
 */
function getAllHealthHistory(options: { days?: number } = {}): Record<string, HealthHistoryEntry[]> {
  const db = getDb();
  const { days = 1 } = options;

  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  const rows = db.prepare(`
    SELECT * FROM cluster_health
    WHERE timestamp >= ?
    ORDER BY hpc, timestamp ASC
  `).all(cutoff) as Array<{ hpc: string } & Parameters<typeof schema.historyRowToEntry>[0]>;

  const history: Record<string, HealthHistoryEntry[]> = {};
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
 */
function pruneHealthHistory(daysToKeep: number = 365): number {
  const db = getDb();
  const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
  const result = db.prepare('DELETE FROM cluster_health WHERE timestamp < ?').run(cutoff);
  if (result.changes > 0) {
    log.info('Pruned old health history', { deleted: result.changes, daysToKeep });
  }
  return result.changes;
}

interface DailyHealthAggregate {
  date: string;
  avgCpus: number;
  avgMemory: number;
  avgNodes: number;
  avgGpus: number | null;
  avgA100: number | null;
  avgV100: number | null;
  maxCpus: number;
  maxMemory: number;
  totalRunning: number;
  totalPending: number;
  sampleCount: number;
}

/**
 * Get daily aggregated health data for heatmaps
 */
function getDailyHealthAggregates(hpc: string, days: number = 365): DailyHealthAggregate[] {
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
  `).all(hpc, cutoff) as Array<{
    date: string;
    avg_cpus: number | null;
    avg_memory: number | null;
    avg_nodes: number | null;
    avg_gpus: number | null;
    avg_a100: number | null;
    avg_v100: number | null;
    max_cpus: number;
    max_memory: number;
    total_running: number;
    total_pending: number;
    sample_count: number;
  }>;

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

interface HealthHistoryJsonEntry {
  timestamp: number;
  cpus?: number | null;
  memory?: number | null;
  nodes?: number | null;
  gpus?: number | null;
}

/**
 * Migrate health history from JSON files
 */
function migrateHealthHistory(hpc: string, entries: HealthHistoryJsonEntry[]): number {
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

interface ClusterHealthCacheJson {
  current?: Partial<ClusterHealth>;
  consecutiveFailures?: number;
  history?: HealthHistoryJsonEntry[];
}

/**
 * Migrate cluster cache from state object
 */
function migrateClusterCache(clusterHealth: Record<string, ClusterHealthCacheJson>): number {
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

export {
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

// CommonJS compatibility for existing require() calls
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
