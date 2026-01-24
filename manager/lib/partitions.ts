/**
 * Partition Service
 * Fetches and caches SLURM partition limits from HPC clusters
 *
 * Replaces hardcoded partitionLimits in config with dynamic data.
 * Falls back to config values when clusters are unreachable.
 */

import { log } from './logger';
import * as db from './db/partitions';
import { clusters } from '../config';
import type { PartitionLimits } from './db/partitions';

// HpcService type - injected to avoid circular dependency
interface HpcServiceInstance {
  sshExec(command: string): Promise<string>;
}

interface HpcServiceConstructor {
  new (clusterName: string, user?: string): HpcServiceInstance;
}

// HpcService is injected to avoid circular dependency
let HpcServiceClass: HpcServiceConstructor | null = null;

/**
 * Set HpcService class for SSH operations
 * @param ServiceClass - HpcService class
 */
export function setHpcService(ServiceClass: HpcServiceConstructor): void {
  HpcServiceClass = ServiceClass;
}

/**
 * Parsed partition info from scontrol
 */
export interface ParsedPartition {
  name: string;
  isDefault: boolean;
  maxCpus: number | null;
  maxMemMB: number | null;
  maxTime: string | null;
  defaultTime: string | null;
  totalCpus: number | null;
  totalNodes: number | null;
  totalMemMB: number | null;
  restricted: boolean;
  restrictionReason: string | null;
  gpuType?: string;
  gpuCount?: number;
}

/**
 * Parse scontrol show partition -o output
 *
 * Example line:
 * PartitionName=compute AllowGroups=ALL AllowAccounts=ALL ... Default=YES ... MaxTime=14-00:00:00 ...
 *   MaxCPUsPerNode=44 ... MaxMemPerNode=640000 ... TotalCPUs=4776 TotalNodes=85 ...
 *   TRES=cpu=4606,mem=62356400M,node=85,billing=12217,gres/gpu=120
 *
 * @param output - Raw scontrol output
 * @returns Array of partition objects
 */
export function parseScontrolOutput(output: string): ParsedPartition[] {
  const partitions: ParsedPartition[] = [];
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
 * @param line - Single line of scontrol output
 * @returns Parsed partition or null
 */
export function parsePartitionLine(line: string): ParsedPartition | null {
  // Extract partition name
  const nameMatch = line.match(/PartitionName=(\S+)/);
  if (!nameMatch) return null;

  const name = nameMatch[1];

  // Parse all fields using regex
  const isDefault = /\bDefault=YES\b/.test(line);

  // MaxCPUsPerNode (may be UNLIMITED)
  const maxCpusMatch = line.match(/MaxCPUsPerNode=(\S+)/);
  const maxCpusRaw = maxCpusMatch ? maxCpusMatch[1] : null;

  // MaxMemPerNode in MB (may be UNLIMITED)
  const maxMemMatch = line.match(/MaxMemPerNode=(\S+)/);
  const maxMemRaw = maxMemMatch ? maxMemMatch[1] : null;

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
  let restrictionReason: string | null = null;

  if (allowAccounts !== 'ALL') {
    restricted = true;
    restrictionReason = `AllowAccounts=${allowAccounts}`;
  } else if (denyAccounts) {
    restricted = true;
    restrictionReason = `DenyAccounts=${denyAccounts}`;
  }

  // Handle UNLIMITED values by deriving from totals (with division-by-zero protection)
  let maxCpus: number | null;
  if (maxCpusRaw === 'UNLIMITED') {
    maxCpus = (totalCpus && totalNodes && totalNodes > 0) ? Math.floor(totalCpus / totalNodes) : null;
  } else {
    maxCpus = maxCpusRaw ? parseInt(maxCpusRaw, 10) : null;
  }

  let maxMemMB: number | null;
  if (maxMemRaw === 'UNLIMITED') {
    maxMemMB = (totalMemMB && totalNodes && totalNodes > 0) ? Math.floor(totalMemMB / totalNodes) : null;
  } else {
    maxMemMB = maxMemRaw ? parseInt(maxMemRaw, 10) : null;
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
 * GPU info from sinfo
 */
interface GpuInfo {
  gpuType: string;
  gpuCount: number;
}

/**
 * Parse GPU info from sinfo output
 *
 * Example:
 * gpu-a100 gpu:A100:4
 *
 * @param output - Raw sinfo -O gres output
 * @returns Map of partition -> { gpuType, gpuCount }
 */
export function parseGpuInfo(output: string): Record<string, GpuInfo> {
  const gpus: Record<string, GpuInfo> = {};
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
 * @param clusterName - Cluster name (gemini, apollo)
 * @returns Array of partition objects
 */
async function fetchClusterPartitions(clusterName: string): Promise<ParsedPartition[]> {
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
      log.warn('Failed to fetch GPU info', { cluster: clusterName, error: (e as Error).message });
    }
  }

  return partitions;
}

/**
 * Refresh result for a cluster
 */
interface RefreshResult {
  success: boolean;
  partitions?: ParsedPartition[];
  error?: string;
}

/**
 * Refresh partitions for a single cluster
 * @param clusterName - Cluster name
 * @returns Refresh result
 */
export async function refreshClusterPartitions(clusterName: string): Promise<RefreshResult> {
  try {
    log.info('Refreshing partition info', { cluster: clusterName });
    const partitions = await fetchClusterPartitions(clusterName);

    // Store in database
    const partitionNames: string[] = [];
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
    log.warn('Failed to refresh partitions', { cluster: clusterName, error: (e as Error).message });
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Refresh partitions for all configured clusters
 * @returns Results per cluster
 */
export async function refreshAllPartitions(): Promise<Record<string, RefreshResult>> {
  // Fetch from all clusters in parallel
  const clusterNames = Object.keys(clusters);
  const resultsArray = await Promise.all(
    clusterNames.map(name => refreshClusterPartitions(name))
  );

  // Build results object after all promises resolve (avoids race condition)
  const results: Record<string, RefreshResult> = {};
  clusterNames.forEach((name, index) => {
    results[name] = resultsArray[index];
  });

  return results;
}

/**
 * Get partition limits for validation
 * Returns dynamic limits from DB, or null if not available
 *
 * @param cluster - Cluster name
 * @param partition - Partition name
 * @returns Partition limits or null
 */
export function getPartitionLimits(cluster: string, partition: string): PartitionLimits | null {
  const limits = db.getPartitionLimits(cluster, partition);
  if (!limits) return null;

  return {
    partition: limits.partition,
    isDefault: limits.isDefault,
    maxCpus: limits.maxCpus,
    maxMemMB: limits.maxMemMB,
    maxTime: limits.maxTime,
    defaultTime: limits.defaultTime,
    totalCpus: limits.totalCpus,
    totalNodes: limits.totalNodes,
    totalMemMB: limits.totalMemMB,
    // Include additional fields for API responses
    gpuType: limits.gpuType,
    gpuCount: limits.gpuCount,
    restricted: limits.restricted,
    restrictionReason: limits.restrictionReason,
    updatedAt: limits.updatedAt,
  };
}

/**
 * Get all partitions (for API responses)
 * @returns Map of cluster -> { partition -> limits }
 */
export function getAllPartitions(): Record<string, Record<string, PartitionLimits>> {
  return db.getAllPartitions();
}

/**
 * Get partitions for a specific cluster
 * @param cluster - Cluster name
 * @returns Map of partition -> limits
 */
export function getClusterPartitions(cluster: string): Record<string, PartitionLimits> {
  return db.getClusterPartitions(cluster);
}

/**
 * Get last update timestamp
 * @param cluster - Optional cluster filter
 * @returns Timestamp in ms
 */
export function getLastUpdated(cluster: string | null = null): number | null {
  return db.getLastUpdated(cluster);
}

/**
 * Initialize partition service
 * Fetches partition info on startup
 */
export async function initialize(): Promise<void> {
  log.info('Initializing partition service');

  // Don't block startup if clusters are unreachable
  try {
    const results = await refreshAllPartitions();
    const successful = Object.values(results).filter(r => r.success).length;
    const total = Object.keys(results).length;
    log.info('Partition service initialized', { successful, total });
  } catch (e) {
    log.warn('Partition service initialization failed', { error: (e as Error).message });
    // Continue with stale/config data
  }
}

// CommonJS compatibility for existing require() calls
module.exports = {
  initialize,
  setHpcService,
  refreshAllPartitions,
  refreshClusterPartitions,
  getPartitionLimits,
  getAllPartitions,
  getClusterPartitions,
  getLastUpdated,
  parseScontrolOutput,
  parsePartitionLine,
  parseGpuInfo,
};
