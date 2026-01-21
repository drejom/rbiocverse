/**
 * Partition Service
 * Fetches and caches SLURM partition limits from HPC clusters
 *
 * Replaces hardcoded partitionLimits in config with dynamic data.
 * Falls back to config values when clusters are unreachable.
 */

const { log } = require('./logger');
const db = require('./db/partitions');
const { clusters } = require('../config');

// HpcService is injected to avoid circular dependency
let HpcServiceClass = null;

/**
 * Set HpcService class for SSH operations
 * @param {Class} ServiceClass - HpcService class
 */
function setHpcService(ServiceClass) {
  HpcServiceClass = ServiceClass;
}

/**
 * Parse scontrol show partition -o output
 *
 * Example line:
 * PartitionName=compute AllowGroups=ALL AllowAccounts=ALL ... Default=YES ... MaxTime=14-00:00:00 ...
 *   MaxCPUsPerNode=44 ... MaxMemPerNode=640000 ... TotalCPUs=4776 TotalNodes=85 ...
 *   TRES=cpu=4606,mem=62356400M,node=85,billing=12217,gres/gpu=120
 *
 * @param {string} output - Raw scontrol output
 * @returns {Object[]} Array of partition objects
 */
function parseScontrolOutput(output) {
  const partitions = [];
  const lines = output.split('\n').filter(line => line.trim());

  for (const line of lines) {
    const partition = parsePartitionLine(line);
    if (partition) {
      partitions.push(partition);
    }
  }

  return partitions;
}

/**
 * Parse a single partition line from scontrol output
 * @param {string} line - Single line of scontrol output
 * @returns {Object|null} Parsed partition or null
 */
function parsePartitionLine(line) {
  // Extract partition name
  const nameMatch = line.match(/PartitionName=(\S+)/);
  if (!nameMatch) return null;

  const name = nameMatch[1];

  // Parse all fields using regex
  const isDefault = /\bDefault=YES\b/.test(line);

  // MaxCPUsPerNode (may be UNLIMITED)
  const maxCpusMatch = line.match(/MaxCPUsPerNode=(\S+)/);
  let maxCpus = maxCpusMatch ? maxCpusMatch[1] : null;

  // MaxMemPerNode in MB (may be UNLIMITED)
  const maxMemMatch = line.match(/MaxMemPerNode=(\S+)/);
  let maxMemMB = maxMemMatch ? maxMemMatch[1] : null;

  // MaxTime (may be UNLIMITED)
  const maxTimeMatch = line.match(/MaxTime=(\S+)/);
  let maxTime = maxTimeMatch ? maxTimeMatch[1] : null;

  // DefaultTime
  const defaultTimeMatch = line.match(/DefaultTime=(\S+)/);
  const defaultTime = defaultTimeMatch ? defaultTimeMatch[1] : null;

  // Total resources for deriving per-node limits when UNLIMITED
  const totalCpusMatch = line.match(/TotalCPUs=(\d+)/);
  const totalCpus = totalCpusMatch ? parseInt(totalCpusMatch[1], 10) : null;

  const totalNodesMatch = line.match(/TotalNodes=(\d+)/);
  const totalNodes = totalNodesMatch ? parseInt(totalNodesMatch[1], 10) : null;

  // TRES field for total memory (format: mem=62356400M)
  const tresMemMatch = line.match(/mem=(\d+)M/);
  const totalMemMB = tresMemMatch ? parseInt(tresMemMatch[1], 10) : null;

  // Restriction detection
  const allowAccountsMatch = line.match(/AllowAccounts=(\S+)/);
  const denyAccountsMatch = line.match(/DenyAccounts=(\S+)/);
  const allowAccounts = allowAccountsMatch ? allowAccountsMatch[1] : 'ALL';
  const denyAccounts = denyAccountsMatch ? denyAccountsMatch[1] : null;

  let restricted = false;
  let restrictionReason = null;

  if (allowAccounts !== 'ALL') {
    restricted = true;
    restrictionReason = `AllowAccounts=${allowAccounts}`;
  } else if (denyAccounts) {
    restricted = true;
    restrictionReason = `DenyAccounts=${denyAccounts}`;
  }

  // Handle UNLIMITED values by deriving from totals (with division-by-zero protection)
  if (maxCpus === 'UNLIMITED') {
    maxCpus = (totalCpus && totalNodes > 0) ? Math.floor(totalCpus / totalNodes) : null;
  } else {
    maxCpus = maxCpus ? parseInt(maxCpus, 10) : null;
  }

  if (maxMemMB === 'UNLIMITED') {
    maxMemMB = (totalMemMB && totalNodes > 0) ? Math.floor(totalMemMB / totalNodes) : null;
  } else {
    maxMemMB = maxMemMB ? parseInt(maxMemMB, 10) : null;
  }

  // Handle UNLIMITED time - cap at 14 days
  if (maxTime === 'UNLIMITED') {
    maxTime = '14-00:00:00';
  }

  return {
    name,
    isDefault,
    maxCpus,
    maxMemMB,
    maxTime,
    defaultTime,
    totalCpus,
    totalNodes,
    totalMemMB,
    restricted,
    restrictionReason,
  };
}

/**
 * Parse GPU info from sinfo output
 *
 * Example:
 * gpu-a100 gpu:A100:4
 *
 * @param {string} output - Raw sinfo -O gres output
 * @returns {Object} Map of partition -> { gpuType, gpuCount }
 */
function parseGpuInfo(output) {
  const gpus = {};
  const lines = output.split('\n').filter(line => line.trim());

  for (const line of lines) {
    // Format: partition_name gpu:TYPE:COUNT
    const match = line.match(/^(\S+)\s+gpu:(\w+):(\d+)/i);
    if (match) {
      const [, partition, gpuType, gpuCount] = match;
      gpus[partition] = {
        gpuType: gpuType.toUpperCase(),
        gpuCount: parseInt(gpuCount, 10),
      };
    }
  }

  return gpus;
}

/**
 * Fetch partition info from a single cluster
 * @param {string} clusterName - Cluster name (gemini, apollo)
 * @returns {Promise<Object[]>} Array of partition objects
 */
async function fetchClusterPartitions(clusterName) {
  if (!HpcServiceClass) {
    throw new Error('HpcService not initialized - call setHpcService first');
  }

  const hpcService = new HpcServiceClass(clusterName);

  // Fetch partition info
  const partitionOutput = await hpcService.sshExec('scontrol show partition -o 2>/dev/null');
  const partitions = parseScontrolOutput(partitionOutput);

  // Identify GPU partitions and fetch GPU info
  const gpuPartitions = partitions
    .filter(p => p.name.includes('gpu'))
    .map(p => p.name);

  if (gpuPartitions.length > 0) {
    try {
      const gpuCmd = `sinfo -p ${gpuPartitions.join(',')} -O 'partition,gres' -h 2>/dev/null`;
      const gpuOutput = await hpcService.sshExec(gpuCmd);
      const gpuInfo = parseGpuInfo(gpuOutput);

      // Merge GPU info into partitions
      for (const partition of partitions) {
        if (gpuInfo[partition.name]) {
          partition.gpuType = gpuInfo[partition.name].gpuType;
          partition.gpuCount = gpuInfo[partition.name].gpuCount;
        }
      }
    } catch (e) {
      log.warn('Failed to fetch GPU info', { cluster: clusterName, error: e.message });
    }
  }

  return partitions;
}

/**
 * Refresh partitions for a single cluster
 * @param {string} clusterName - Cluster name
 * @returns {Promise<Object>} { success, partitions, error }
 */
async function refreshClusterPartitions(clusterName) {
  try {
    log.info('Refreshing partition info', { cluster: clusterName });
    const partitions = await fetchClusterPartitions(clusterName);

    // Store in database
    const partitionNames = [];
    for (const partition of partitions) {
      db.upsertPartition(clusterName, partition.name, {
        isDefault: partition.isDefault,
        maxCpus: partition.maxCpus,
        maxMemMB: partition.maxMemMB,
        maxTime: partition.maxTime,
        defaultTime: partition.defaultTime,
        totalCpus: partition.totalCpus,
        totalNodes: partition.totalNodes,
        totalMemMB: partition.totalMemMB,
        gpuCount: partition.gpuCount,
        gpuType: partition.gpuType,
        restricted: partition.restricted,
        restrictionReason: partition.restrictionReason,
      });
      partitionNames.push(partition.name);
    }

    // Clean up stale partitions (removed from cluster)
    db.deleteStalePartitions(clusterName, partitionNames);

    log.info('Partition refresh complete', { cluster: clusterName, count: partitions.length });
    return { success: true, partitions };
  } catch (e) {
    log.warn('Failed to refresh partitions', { cluster: clusterName, error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Refresh partitions for all configured clusters
 * @returns {Promise<Object>} Results per cluster
 */
async function refreshAllPartitions() {
  // Fetch from all clusters in parallel
  const clusterNames = Object.keys(clusters);
  const resultsArray = await Promise.all(
    clusterNames.map(name => refreshClusterPartitions(name))
  );

  // Build results object after all promises resolve (avoids race condition)
  const results = {};
  clusterNames.forEach((name, index) => {
    results[name] = resultsArray[index];
  });

  return results;
}

/**
 * Get partition limits for validation
 * Returns dynamic limits from DB, or null if not available
 *
 * @param {string} cluster - Cluster name
 * @param {string} partition - Partition name
 * @returns {Object|null} { maxCpus, maxMemMB, maxTime } or null
 */
function getPartitionLimits(cluster, partition) {
  const limits = db.getPartitionLimits(cluster, partition);
  if (!limits) return null;

  return {
    maxCpus: limits.maxCpus,
    maxMemMB: limits.maxMemMB,
    maxTime: limits.maxTime,
    // Include additional fields for API responses
    gpuType: limits.gpuType,
    gpuCount: limits.gpuCount,
    restricted: limits.restricted,
    restrictionReason: limits.restrictionReason,
  };
}

/**
 * Get all partitions (for API responses)
 * @returns {Object} Map of cluster -> { partition -> limits }
 */
function getAllPartitions() {
  return db.getAllPartitions();
}

/**
 * Get partitions for a specific cluster
 * @param {string} cluster - Cluster name
 * @returns {Object} Map of partition -> limits
 */
function getClusterPartitions(cluster) {
  return db.getClusterPartitions(cluster);
}

/**
 * Get last update timestamp
 * @param {string} [cluster] - Optional cluster filter
 * @returns {number|null} Timestamp in ms
 */
function getLastUpdated(cluster = null) {
  return db.getLastUpdated(cluster);
}

/**
 * Initialize partition service
 * Fetches partition info on startup
 */
async function initialize() {
  log.info('Initializing partition service');

  // Don't block startup if clusters are unreachable
  try {
    const results = await refreshAllPartitions();
    const successful = Object.values(results).filter(r => r.success).length;
    const total = Object.keys(results).length;
    log.info('Partition service initialized', { successful, total });
  } catch (e) {
    log.warn('Partition service initialization failed', { error: e.message });
    // Continue with stale/config data
  }
}

module.exports = {
  // Initialization
  initialize,
  setHpcService,

  // Refresh operations
  refreshAllPartitions,
  refreshClusterPartitions,

  // Query operations
  getPartitionLimits,
  getAllPartitions,
  getClusterPartitions,
  getLastUpdated,

  // Parsing (exported for testing)
  parseScontrolOutput,
  parsePartitionLine,
  parseGpuInfo,
};
