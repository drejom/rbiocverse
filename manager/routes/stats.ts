/**
 * Public Stats API
 * Provides anonymized aggregate statistics without authentication.
 *
 * These stats are useful for:
 * - Help page variable interpolation (e.g., {{avgLaunchTime}})
 * - Public dashboards showing cluster health
 * - Documentation with live data
 *
 * No PII or user-specific data is exposed.
 */

import express, { Request, Response } from 'express';
import asyncHandler from '../lib/asyncHandler';
import * as analytics from '../lib/db/analytics';
import * as partitions from '../lib/partitions';
import { parseQueryInt } from '../lib/validation';

const router = express.Router();

// Helper to safely get string from req.params (Express types it as string | string[] but it's always string for route params)
const param = (req: Request, name: string): string => req.params[name] as string;

// StateManager type (simplified for this module)
interface StateManager {
  getClusterHealth(): Record<string, {
    current?: {
      online?: boolean;
      cpus?: { percent?: number | null; used?: number | null; total?: number | null };
      memory?: { percent?: number | null };
      nodes?: { percent?: number | null; idle?: number | null; busy?: number | null; down?: number | null };
      gpus?: unknown;
      runningJobs?: number;
      pendingJobs?: number;
      lastChecked?: string | null;
    };
  }>;
}

// StateManager injected via setStateManager()
let stateManager: StateManager | null = null;

/**
 * Set the state manager for cluster health data
 * @param sm - State manager instance
 */
function setStateManager(sm: StateManager): void {
  stateManager = sm;
}

interface ReleaseUsage {
  version: string;
  sessions: number;
  uniqueUsers: number;
}

interface IdeUsage {
  ide: string;
  sessions: number;
  avgDurationMinutes: number | null;
}

interface DailySession {
  date: string;
  sessions: number;
}

interface PartitionLimits {
  isDefault?: boolean;
  maxCpus?: number;
  maxMemMB?: number | null;
  maxTime?: string;
  defaultTime?: string;
  gpuType?: string | null;
  gpuCount?: number | null;
  restricted?: boolean;
  restrictionReason?: string | null;
}

/**
 * GET /api/stats/clusters
 * Cluster health summary (public)
 *
 * Returns current cluster status without sensitive data.
 */
router.get('/clusters', asyncHandler(async (req: Request, res: Response) => {
  if (!stateManager) {
    return res.status(503).json({ error: 'Stats service not available' });
  }

  const clusterHealth = stateManager.getClusterHealth();
  const summary: Record<string, unknown> = {};

  for (const [cluster, health] of Object.entries(clusterHealth)) {
    if (!health?.current) continue;

    const current = health.current;
    summary[cluster] = {
      online: current.online ?? false,
      cpus: {
        percent: current.cpus?.percent ?? null,
        used: current.cpus?.used ?? null,
        total: current.cpus?.total ?? null,
      },
      memory: {
        percent: current.memory?.percent ?? null,
      },
      nodes: {
        percent: current.nodes?.percent ?? null,
        idle: current.nodes?.idle ?? null,
        busy: current.nodes?.busy ?? null,
        down: current.nodes?.down ?? null,
      },
      gpus: current.gpus ?? null,
      runningJobs: current.runningJobs ?? 0,
      pendingJobs: current.pendingJobs ?? 0,
      lastChecked: current.lastChecked ?? null,
    };
  }

  res.json({
    clusters: summary,
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * GET /api/stats/usage
 * Anonymized usage statistics (public)
 *
 * Aggregate stats without usernames or PII.
 */
router.get('/usage', asyncHandler(async (req: Request, res: Response) => {
  const days = parseQueryInt(req.query, 'days', 7, { min: 1, max: 365 });

  // Get aggregate stats (no usernames)
  const releases = analytics.getReleaseUsage(days) as ReleaseUsage[];
  const ides = analytics.getIdePopularity(days) as IdeUsage[];
  const features = analytics.getFeatureUsage(days) as {
    shiny?: { percent?: number };
    liveServer?: { percent?: number };
  };
  const capacity = analytics.getCapacityMetrics(days) as {
    queueWaitTimes?: { avg?: number | null; p50?: number | null; p90?: number | null };
  };
  const dailySessions = analytics.getDailySessionCounts(days) as DailySession[];

  // Calculate totals
  const totalSessions = releases.reduce((sum, r) => sum + r.sessions, 0);
  const totalUniqueUsers = releases.reduce((sum, r) => sum + r.uniqueUsers, 0);

  res.json({
    period: { days },
    summary: {
      totalSessions,
      totalUniqueUsers,
    },
    releases: releases.map(r => ({
      version: r.version,
      sessions: r.sessions,
      // Omit uniqueUsers per-release to avoid user tracking
    })),
    ides: ides.map(i => ({
      ide: i.ide,
      sessions: i.sessions,
      avgDurationMinutes: Math.round(i.avgDurationMinutes || 0),
    })),
    features: {
      shinyPercent: features.shiny?.percent ?? 0,
      liveServerPercent: features.liveServer?.percent ?? 0,
    },
    queueWait: {
      avgSeconds: capacity.queueWaitTimes?.avg ?? null,
      p50Seconds: capacity.queueWaitTimes?.p50 ?? null,
      p90Seconds: capacity.queueWaitTimes?.p90 ?? null,
    },
    dailyTrend: dailySessions.map(d => ({
      date: d.date,
      sessions: d.sessions,
    })),
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * GET /api/stats/variables
 * Key stats as key-value pairs for markdown interpolation
 *
 * Help content can use {{variableName}} syntax.
 * These variables are computed from recent data.
 */
router.get('/variables', asyncHandler(async (req: Request, res: Response) => {
  const days = 7; // Week of data for averages

  const capacity = analytics.getCapacityMetrics(days) as {
    queueWaitTimes?: { avg?: number | null; p90?: number | null };
    growth?: { sessionGrowthPercent?: number | null; userGrowthPercent?: number | null };
  };
  const dailySessions = analytics.getDailySessionCounts(days) as DailySession[];

  // Calculate weekly totals
  const totalSessionsThisWeek = dailySessions.reduce((sum, d) => sum + d.sessions, 0);

  // Get cluster-specific queue wait times
  const queueWaitByCluster = analytics.getQueueWaitTimesByCluster(days) as Record<string, { avg?: number | null }>;

  // Build variables map
  const variables: Record<string, unknown> = {
    // Session stats
    totalSessionsThisWeek,
    avgSessionsPerDay: Math.round(totalSessionsThisWeek / Math.max(days, 1)),

    // Queue wait times (in human-readable format)
    avgQueueWaitSeconds: capacity.queueWaitTimes?.avg ?? null,
    avgQueueWaitFormatted: formatSeconds(capacity.queueWaitTimes?.avg ?? null),
    p90QueueWaitFormatted: formatSeconds(capacity.queueWaitTimes?.p90 ?? null),

    // Cluster-specific wait times
    geminiQueueWait: formatSeconds(queueWaitByCluster.gemini?.avg ?? null),
    apolloQueueWait: formatSeconds(queueWaitByCluster.apollo?.avg ?? null),

    // Growth
    sessionGrowthPercent: capacity.growth?.sessionGrowthPercent ?? null,
    userGrowthPercent: capacity.growth?.userGrowthPercent ?? null,
  };

  // Add cluster health if available
  if (stateManager) {
    const clusterHealth = stateManager.getClusterHealth();

    for (const [cluster, health] of Object.entries(clusterHealth)) {
      if (!health?.current) continue;
      const c = health.current;

      variables[`${cluster}Online`] = c.online ?? false;
      variables[`${cluster}CpuPercent`] = c.cpus?.percent ?? null;
      variables[`${cluster}MemoryPercent`] = c.memory?.percent ?? null;
      variables[`${cluster}RunningJobs`] = c.runningJobs ?? 0;
      variables[`${cluster}PendingJobs`] = c.pendingJobs ?? 0;
    }
  }

  res.json({
    variables,
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * GET /api/stats/queue/:cluster
 * Queue wait time stats for a specific cluster
 */
router.get('/queue/:cluster', asyncHandler(async (req: Request, res: Response) => {
  const cluster = param(req, 'cluster');
  const days = parseQueryInt(req.query, 'days', 7, { min: 1, max: 365 });

  const queueWaitByCluster = analytics.getQueueWaitTimesByCluster(days) as Record<string, {
    count?: number;
    avg?: number | null;
    p50?: number | null;
    p90?: number | null;
    p99?: number | null;
  }>;
  const clusterStats = queueWaitByCluster[cluster];

  if (!clusterStats) {
    return res.status(404).json({
      error: `No queue data for cluster: ${cluster}`,
      availableClusters: Object.keys(queueWaitByCluster),
    });
  }

  res.json({
    cluster,
    period: { days },
    stats: {
      count: clusterStats.count,
      avgSeconds: clusterStats.avg,
      avgFormatted: formatSeconds(clusterStats.avg ?? null),
      p50Seconds: clusterStats.p50,
      p50Formatted: formatSeconds(clusterStats.p50 ?? null),
      p90Seconds: clusterStats.p90,
      p90Formatted: formatSeconds(clusterStats.p90 ?? null),
      p99Seconds: clusterStats.p99,
      p99Formatted: formatSeconds(clusterStats.p99 ?? null),
    },
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * Transform partition limits for public API responses
 * @param limits - Raw partition limits from DB
 * @returns Transformed object for API response
 */
function transformPartitionForApi(limits: PartitionLimits): Record<string, unknown> {
  return {
    isDefault: limits.isDefault,
    maxCpus: limits.maxCpus,
    maxMemGB: limits.maxMemMB ? Math.floor(limits.maxMemMB / 1024) : null,
    maxMemMB: limits.maxMemMB,
    maxTime: limits.maxTime,
    defaultTime: limits.defaultTime,
    gpuType: limits.gpuType || null,
    gpuCount: limits.gpuCount || null,
    restricted: limits.restricted,
    restrictionReason: limits.restrictionReason || null,
  };
}

/**
 * GET /api/stats/partitions
 * Partition limits for all clusters (public)
 *
 * Returns dynamic partition data for resource validation.
 */
router.get('/partitions', asyncHandler(async (req: Request, res: Response) => {
  const allPartitions = partitions.getAllPartitions() as Record<string, Record<string, PartitionLimits>>;
  const lastUpdated = partitions.getLastUpdated();

  // Transform for API response
  const result: Record<string, Record<string, unknown>> = {};
  for (const [cluster, clusterPartitions] of Object.entries(allPartitions)) {
    result[cluster] = {};
    for (const [partitionName, limits] of Object.entries(clusterPartitions)) {
      result[cluster][partitionName] = transformPartitionForApi(limits);
    }
  }

  res.json({
    partitions: result,
    lastUpdated,
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * GET /api/stats/partitions/:cluster
 * Partition limits for a specific cluster (public)
 */
router.get('/partitions/:cluster', asyncHandler(async (req: Request, res: Response) => {
  const cluster = param(req, 'cluster');
  const clusterPartitions = partitions.getClusterPartitions(cluster) as Record<string, PartitionLimits>;
  const lastUpdated = partitions.getLastUpdated(cluster);

  if (Object.keys(clusterPartitions).length === 0) {
    return res.status(404).json({
      error: `No partition data for cluster: ${cluster}`,
      availableClusters: Object.keys(partitions.getAllPartitions()),
    });
  }

  // Transform for API response
  const result: Record<string, unknown> = {};
  for (const [partitionName, limits] of Object.entries(clusterPartitions)) {
    result[partitionName] = transformPartitionForApi(limits);
  }

  res.json({
    cluster,
    partitions: result,
    lastUpdated,
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * Format seconds into human-readable string
 * @param seconds
 * @returns Formatted string
 */
function formatSeconds(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return 'N/A';

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  } else if (seconds < 3600) {
    const mins = Math.round(seconds / 60);
    return `${mins}m`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.round((seconds % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
}

export default router;
export { setStateManager };

// CommonJS compatibility for existing require() calls
module.exports = router;
module.exports.setStateManager = setStateManager;
