/**
 * Cluster Health Schema - Single source of truth for field mappings
 *
 * Canonical field names (used in JS objects):
 *   runningJobs, pendingJobs, cpus.percent, memory.percent, etc.
 *
 * Database column names (SQLite):
 *   running_jobs, pending_jobs, cpus_percent, memory_percent, etc.
 */

export interface CpuStats {
  used: number;
  idle: number;
  total: number;
  percent: number;
}

export interface MemoryStats {
  used: number;
  total: number;
  percent: number;
}

export interface NodeStats {
  idle: number;
  busy: number;
  down: number;
  total: number;
  percent: number;
}

export interface GpuStats {
  percent?: number;
  [key: string]: unknown;
}

export interface PartitionStats {
  cpus?: CpuStats;
  [key: string]: unknown;
}

export interface ClusterHealth {
  online: boolean;
  cpus: CpuStats | null;
  memory: MemoryStats | null;
  nodes: NodeStats | null;
  gpus: GpuStats | null;
  partitions: Record<string, PartitionStats> | null;
  runningJobs: number;
  pendingJobs: number;
  fairshare: string | null;
  lastChecked: number;
  consecutiveFailures: number;
  error: string | null;
}

export interface HealthHistoryEntry {
  timestamp: number;
  cpus: number | null;
  memory: number | null;
  nodes: number | null;
  gpus: number | null;
  runningJobs: number;
  pendingJobs: number;
}

interface ClusterCacheRow {
  hpc: string;
  online: number;
  cpus_used: number | null;
  cpus_idle: number | null;
  cpus_total: number | null;
  cpus_percent: number | null;
  memory_used: number | null;
  memory_total: number | null;
  memory_percent: number | null;
  nodes_idle: number | null;
  nodes_busy: number | null;
  nodes_down: number | null;
  nodes_total: number | null;
  nodes_percent: number | null;
  gpus_json: string | null;
  partitions_json: string | null;
  running_jobs: number | null;
  pending_jobs: number | null;
  fairshare: string | null;
  last_checked: number | null;
  consecutive_failures: number | null;
  error: string | null;
}

interface ClusterHealthRow {
  hpc: string;
  timestamp: number;
  cpus_percent: number | null;
  memory_percent: number | null;
  nodes_percent: number | null;
  gpus_percent: number | null;
  running_jobs: number | null;
  pending_jobs: number | null;
  a100_cpus_percent: number | null;
  v100_cpus_percent: number | null;
}

/**
 * Map database row to health object (for reading from DB)
 * @param row - SQLite row from cluster_cache
 * @returns Health object with canonical field names
 */
function rowToHealth(row: ClusterCacheRow | undefined): ClusterHealth | null {
  if (!row) return null;

  return {
    online: !!row.online,
    cpus: row.cpus_total ? {
      used: row.cpus_used!,
      idle: row.cpus_idle!,
      total: row.cpus_total,
      percent: row.cpus_percent!,
    } : null,
    memory: row.memory_total ? {
      used: row.memory_used!,
      total: row.memory_total,
      percent: row.memory_percent!,
    } : null,
    nodes: row.nodes_total ? {
      idle: row.nodes_idle!,
      busy: row.nodes_busy!,
      down: row.nodes_down!,
      total: row.nodes_total,
      percent: row.nodes_percent!,
    } : null,
    gpus: row.gpus_json ? JSON.parse(row.gpus_json) : null,
    partitions: row.partitions_json ? JSON.parse(row.partitions_json) : null,
    runningJobs: row.running_jobs || 0,
    pendingJobs: row.pending_jobs || 0,
    fairshare: row.fairshare,
    lastChecked: row.last_checked || Date.now(),
    consecutiveFailures: row.consecutive_failures || 0,
    error: row.error,
  };
}

/**
 * Map health object to database params (for writing to DB)
 * @param hpc - Cluster name
 * @param health - Health object with canonical field names
 * @returns Parameters for INSERT statement
 */
function healthToRow(hpc: string, health: Partial<ClusterHealth>): (string | number | null)[] {
  return [
    hpc,
    health.online ? 1 : 0,
    health.cpus?.used ?? null,
    health.cpus?.idle ?? null,
    health.cpus?.total ?? null,
    health.cpus?.percent ?? null,
    health.memory?.used ?? null,
    health.memory?.total ?? null,
    health.memory?.percent ?? null,
    health.nodes?.idle ?? null,
    health.nodes?.busy ?? null,
    health.nodes?.down ?? null,
    health.nodes?.total ?? null,
    health.nodes?.percent ?? null,
    health.gpus ? JSON.stringify(health.gpus) : null,
    health.partitions ? JSON.stringify(health.partitions) : null,
    health.runningJobs || 0,
    health.pendingJobs || 0,
    health.fairshare || null,
    health.lastChecked || Date.now(),
    health.consecutiveFailures || 0,
    health.error || null,
  ];
}

/**
 * Map health object to history snapshot params
 * @param hpc - Cluster name
 * @param health - Health object
 * @returns Parameters for INSERT statement
 */
function healthToHistoryRow(hpc: string, health: Partial<ClusterHealth>): (string | number | null)[] {
  // Extract partition CPU percentages if available
  const a100Percent = health.partitions?.['gpu-a100']?.cpus?.percent ?? null;
  const v100Percent = health.partitions?.['gpu-v100']?.cpus?.percent ?? null;

  return [
    hpc,
    Date.now(),
    health.cpus?.percent ?? null,
    health.memory?.percent ?? null,
    health.nodes?.percent ?? null,
    health.gpus?.percent ?? null,
    health.runningJobs || 0,
    health.pendingJobs || 0,
    a100Percent,
    v100Percent,
  ];
}

/**
 * Map history row to history object
 * @param row - SQLite row from cluster_health
 * @returns History entry
 */
function historyRowToEntry(row: ClusterHealthRow): HealthHistoryEntry {
  return {
    timestamp: row.timestamp,
    cpus: row.cpus_percent,
    memory: row.memory_percent,
    nodes: row.nodes_percent,
    gpus: row.gpus_percent,
    runningJobs: row.running_jobs || 0,
    pendingJobs: row.pending_jobs || 0,
  };
}

export {
  rowToHealth,
  healthToRow,
  healthToHistoryRow,
  historyRowToEntry,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  rowToHealth,
  healthToRow,
  healthToHistoryRow,
  historyRowToEntry,
};
