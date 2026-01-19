/**
 * Cluster Health Schema - Single source of truth for field mappings
 *
 * Canonical field names (used in JS objects):
 *   runningJobs, pendingJobs, cpus.percent, memory.percent, etc.
 *
 * Database column names (SQLite):
 *   running_jobs, pending_jobs, cpus_percent, memory_percent, etc.
 */

/**
 * Map database row to health object (for reading from DB)
 * @param {Object} row - SQLite row from cluster_cache
 * @returns {Object} Health object with canonical field names
 */
function rowToHealth(row) {
  if (!row) return null;

  return {
    online: !!row.online,
    cpus: row.cpus_total ? {
      used: row.cpus_used,
      idle: row.cpus_idle,
      total: row.cpus_total,
      percent: row.cpus_percent,
    } : null,
    memory: row.memory_total ? {
      used: row.memory_used,
      total: row.memory_total,
      percent: row.memory_percent,
    } : null,
    nodes: row.nodes_total ? {
      idle: row.nodes_idle,
      busy: row.nodes_busy,
      down: row.nodes_down,
      total: row.nodes_total,
      percent: row.nodes_percent,
    } : null,
    gpus: row.gpus_json ? JSON.parse(row.gpus_json) : null,
    partitions: row.partitions_json ? JSON.parse(row.partitions_json) : null,
    runningJobs: row.running_jobs || 0,
    pendingJobs: row.pending_jobs || 0,
    fairshare: row.fairshare,
    lastChecked: row.last_checked,
    consecutiveFailures: row.consecutive_failures || 0,
    error: row.error,
  };
}

/**
 * Map health object to database params (for writing to DB)
 * @param {string} hpc - Cluster name
 * @param {Object} health - Health object with canonical field names
 * @returns {Array} Parameters for INSERT statement
 */
function healthToRow(hpc, health) {
  return [
    hpc,
    health.online ? 1 : 0,
    health.cpus?.used || null,
    health.cpus?.idle || null,
    health.cpus?.total || null,
    health.cpus?.percent || null,
    health.memory?.used || null,
    health.memory?.total || null,
    health.memory?.percent || null,
    health.nodes?.idle || null,
    health.nodes?.busy || null,
    health.nodes?.down || null,
    health.nodes?.total || null,
    health.nodes?.percent || null,
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
 * @param {string} hpc - Cluster name
 * @param {Object} health - Health object
 * @returns {Array} Parameters for INSERT statement
 */
function healthToHistoryRow(hpc, health) {
  // Extract partition CPU percentages if available
  const a100Percent = health.partitions?.['gpu-a100']?.cpus?.percent || null;
  const v100Percent = health.partitions?.['gpu-v100']?.cpus?.percent || null;

  return [
    hpc,
    Date.now(),
    health.cpus?.percent || null,
    health.memory?.percent || null,
    health.nodes?.percent || null,
    health.gpus?.percent || null,
    health.runningJobs || 0,
    health.pendingJobs || 0,
    a100Percent,
    v100Percent,
  ];
}

/**
 * Map history row to history object
 * @param {Object} row - SQLite row from cluster_health
 * @returns {Object} History entry
 */
function historyRowToEntry(row) {
  return {
    timestamp: row.timestamp,
    cpus: row.cpus_percent,
    memory: row.memory_percent,
    nodes: row.nodes_percent,
    gpus: row.gpus_percent,
    runningJobs: row.running_jobs,
    pendingJobs: row.pending_jobs,
  };
}

module.exports = {
  rowToHealth,
  healthToRow,
  healthToHistoryRow,
  historyRowToEntry,
};
