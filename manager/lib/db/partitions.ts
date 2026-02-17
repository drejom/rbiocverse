/**
 * Partition Limits Database Operations
 * Stores SLURM partition limits fetched dynamically from clusters
 *
 * Used for:
 * - Job validation (prevent submitting jobs that exceed queue limits)
 * - Admin panel display (show partition info per cluster)
 * - Fallback data when clusters are unreachable
 */

import { getDb } from '../db';
import { log } from '../logger';

/**
 * Partition limits input data from SLURM
 */
export interface PartitionLimitsInput {
  isDefault?: boolean;
  maxCpus?: number | null;
  maxMemMB?: number | null;
  maxTime?: string | null;
  defaultTime?: string | null;
  totalCpus?: number | null;
  totalNodes?: number | null;
  totalMemMB?: number | null;
  gpuCount?: number | null;
  gpuType?: string | null;
  restricted?: boolean;
  restrictionReason?: string | null;
}

/**
 * Partition limits output data
 */
export interface PartitionLimits {
  partition: string;
  isDefault: boolean;
  maxCpus: number | null;
  maxMemMB: number | null;
  maxTime: string | null;
  defaultTime: string | null;
  totalCpus: number | null;
  totalNodes: number | null;
  totalMemMB: number | null;
  gpuCount: number | null;
  gpuType: string | null;
  restricted: boolean;
  restrictionReason: string | null;
  updatedAt: number | null;
}

/**
 * Database row type for partition_limits table
 */
interface PartitionRow {
  partition: string;
  is_default: number;
  max_cpus: number | null;
  max_mem_mb: number | null;
  max_time: string | null;
  default_time: string | null;
  total_cpus: number | null;
  total_nodes: number | null;
  total_mem_mb: number | null;
  gpu_count: number | null;
  gpu_type: string | null;
  restricted: number;
  restriction_reason: string | null;
  updated_at: number | null;
  cluster?: string;
}

/**
 * Upsert partition limits
 * @param cluster - Cluster name (gemini, apollo)
 * @param partition - Partition name
 * @param limits - Partition limits
 */
export function upsertPartition(
  cluster: string,
  partition: string,
  limits: PartitionLimitsInput
): void {
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
 * @param cluster - Cluster name
 * @param partition - Partition name
 * @returns Partition limits or null if not found
 */
export function getPartitionLimits(
  cluster: string,
  partition: string
): PartitionLimits | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM partition_limits WHERE cluster = ? AND partition = ?
  `).get(cluster, partition) as PartitionRow | undefined;

  return row ? rowToLimits(row) : null;
}

/**
 * Get all partitions for a cluster
 * @param cluster - Cluster name
 * @returns Map of partition name -> limits
 */
export function getClusterPartitions(cluster: string): Record<string, PartitionLimits> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM partition_limits WHERE cluster = ? ORDER BY is_default DESC, partition ASC
  `).all(cluster) as PartitionRow[];

  const partitions: Record<string, PartitionLimits> = {};
  for (const row of rows) {
    partitions[row.partition] = rowToLimits(row);
  }
  return partitions;
}

/**
 * Get all partitions across all clusters
 * @returns Map of cluster -> { partition -> limits }
 */
export function getAllPartitions(): Record<string, Record<string, PartitionLimits>> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM partition_limits ORDER BY cluster, is_default DESC, partition ASC
  `).all() as (PartitionRow & { cluster: string })[];

  const result: Record<string, Record<string, PartitionLimits>> = {};
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
 * @param cluster - Cluster name
 * @param validPartitions - List of valid partition names
 * @returns Number of rows deleted
 */
export function deleteStalePartitions(cluster: string, validPartitions: string[]): number {
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
 * @param cluster - Optional cluster filter
 * @returns Timestamp in ms or null if no data
 */
export function getLastUpdated(cluster: string | null = null): number | null {
  const db = getDb();
  let sql = 'SELECT MAX(updated_at) as last_updated FROM partition_limits';
  const params: string[] = [];

  if (cluster) {
    sql += ' WHERE cluster = ?';
    params.push(cluster);
  }

  const row = db.prepare(sql).get(...params) as { last_updated: number | null } | undefined;
  return row?.last_updated ?? null;
}

/**
 * Get default partition for a cluster
 * @param cluster - Cluster name
 * @returns Default partition limits or null
 */
export function getDefaultPartition(cluster: string): PartitionLimits | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM partition_limits WHERE cluster = ? AND is_default = 1
  `).get(cluster) as PartitionRow | undefined;

  return row ? rowToLimits(row) : null;
}

/**
 * Convert database row to limits object
 * @param row - Database row
 * @returns Limits object
 */
function rowToLimits(row: PartitionRow): PartitionLimits {
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

// CommonJS compatibility for existing require() calls
module.exports = {
  upsertPartition,
  getPartitionLimits,
  getClusterPartitions,
  getAllPartitions,
  deleteStalePartitions,
  getLastUpdated,
  getDefaultPartition,
};
