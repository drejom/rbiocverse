/**
 * Partition Limits Database Operations
 * Stores SLURM partition limits fetched dynamically from clusters
 *
 * Used for:
 * - Job validation (prevent submitting jobs that exceed queue limits)
 * - Admin panel display (show partition info per cluster)
 * - Fallback data when clusters are unreachable
 */

const { getDb } = require('../db');
const { log } = require('../logger');

/**
 * Upsert partition limits
 * @param {string} cluster - Cluster name (gemini, apollo)
 * @param {string} partition - Partition name
 * @param {Object} limits - Partition limits
 * @param {boolean} limits.isDefault - Is this the default partition
 * @param {number|null} limits.maxCpus - Max CPUs per node
 * @param {number|null} limits.maxMemMB - Max memory in MB
 * @param {string|null} limits.maxTime - Max walltime (SLURM format)
 * @param {string|null} limits.defaultTime - Default walltime
 * @param {number|null} limits.totalCpus - Total CPUs in partition
 * @param {number|null} limits.totalNodes - Total nodes in partition
 * @param {number|null} limits.totalMemMB - Total memory in partition (MB)
 * @param {number|null} limits.gpuCount - GPUs per node
 * @param {string|null} limits.gpuType - GPU type (A100, V100, etc.)
 * @param {boolean} limits.restricted - Whether partition has access restrictions
 * @param {string|null} limits.restrictionReason - Why partition is restricted
 */
function upsertPartition(cluster, partition, limits) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO partition_limits (
      cluster, partition, is_default, max_cpus, max_mem_mb, max_time, default_time,
      total_cpus, total_nodes, total_mem_mb, gpu_count, gpu_type,
      restricted, restriction_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    cluster,
    partition,
    limits.isDefault ? 1 : 0,
    limits.maxCpus ?? null,
    limits.maxMemMB ?? null,
    limits.maxTime ?? null,
    limits.defaultTime ?? null,
    limits.totalCpus ?? null,
    limits.totalNodes ?? null,
    limits.totalMemMB ?? null,
    limits.gpuCount ?? null,
    limits.gpuType ?? null,
    limits.restricted ? 1 : 0,
    limits.restrictionReason ?? null,
    Date.now()
  );

  log.debug('Upserted partition limits', { cluster, partition, maxCpus: limits.maxCpus, maxMemMB: limits.maxMemMB });
}

/**
 * Get partition limits for a specific cluster/partition
 * @param {string} cluster - Cluster name
 * @param {string} partition - Partition name
 * @returns {Object|null} Partition limits or null if not found
 */
function getPartitionLimits(cluster, partition) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM partition_limits WHERE cluster = ? AND partition = ?
  `).get(cluster, partition);

  return row ? rowToLimits(row) : null;
}

/**
 * Get all partitions for a cluster
 * @param {string} cluster - Cluster name
 * @returns {Object} Map of partition name -> limits
 */
function getClusterPartitions(cluster) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM partition_limits WHERE cluster = ? ORDER BY is_default DESC, partition ASC
  `).all(cluster);

  const partitions = {};
  for (const row of rows) {
    partitions[row.partition] = rowToLimits(row);
  }
  return partitions;
}

/**
 * Get all partitions across all clusters
 * @returns {Object} Map of cluster -> { partition -> limits }
 */
function getAllPartitions() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM partition_limits ORDER BY cluster, is_default DESC, partition ASC
  `).all();

  const result = {};
  for (const row of rows) {
    if (!result[row.cluster]) {
      result[row.cluster] = {};
    }
    result[row.cluster][row.partition] = rowToLimits(row);
  }
  return result;
}

/**
 * Delete partitions not in the provided list (cleanup after refresh)
 * @param {string} cluster - Cluster name
 * @param {string[]} validPartitions - List of valid partition names
 * @returns {number} Number of rows deleted
 */
function deleteStalePartitions(cluster, validPartitions) {
  const db = getDb();

  if (validPartitions.length === 0) {
    // No valid partitions means cluster might be down - don't delete anything
    return 0;
  }

  // Build placeholders for IN clause
  const placeholders = validPartitions.map(() => '?').join(',');
  const result = db.prepare(`
    DELETE FROM partition_limits
    WHERE cluster = ? AND partition NOT IN (${placeholders})
  `).run(cluster, ...validPartitions);

  if (result.changes > 0) {
    log.info('Deleted stale partitions', { cluster, deleted: result.changes });
  }
  return result.changes;
}

/**
 * Get the timestamp of the most recent update
 * @param {string} [cluster] - Optional cluster filter
 * @returns {number|null} Timestamp in ms or null if no data
 */
function getLastUpdated(cluster = null) {
  const db = getDb();
  let sql = 'SELECT MAX(updated_at) as last_updated FROM partition_limits';
  const params = [];

  if (cluster) {
    sql += ' WHERE cluster = ?';
    params.push(cluster);
  }

  const row = db.prepare(sql).get(...params);
  return row?.last_updated ?? null;
}

/**
 * Get default partition for a cluster
 * @param {string} cluster - Cluster name
 * @returns {Object|null} Default partition limits or null
 */
function getDefaultPartition(cluster) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM partition_limits WHERE cluster = ? AND is_default = 1
  `).get(cluster);

  return row ? rowToLimits(row) : null;
}

/**
 * Convert database row to limits object
 * @param {Object} row - Database row
 * @returns {Object} Limits object
 */
function rowToLimits(row) {
  return {
    partition: row.partition,
    isDefault: row.is_default === 1,
    maxCpus: row.max_cpus,
    maxMemMB: row.max_mem_mb,
    maxTime: row.max_time,
    defaultTime: row.default_time,
    totalCpus: row.total_cpus,
    totalNodes: row.total_nodes,
    totalMemMB: row.total_mem_mb,
    gpuCount: row.gpu_count,
    gpuType: row.gpu_type,
    restricted: row.restricted === 1,
    restrictionReason: row.restriction_reason,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  upsertPartition,
  getPartitionLimits,
  getClusterPartitions,
  getAllPartitions,
  deleteStalePartitions,
  getLastUpdated,
  getDefaultPartition,
};
