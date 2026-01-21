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

const express = require('express');
const router = express.Router();
const asyncHandler = require('../lib/asyncHandler');
const analytics = require('../lib/db/analytics');
const partitions = require('../lib/partitions');
const { parseQueryInt } = require('../lib/validation');

// StateManager injected via setStateManager()
let stateManager = null;

/**
 * Set the state manager for cluster health data
 * @param {StateManager} sm - State manager instance
 */
function setStateManager(sm) {
  stateManager = sm;
}

/**
 * GET /api/stats/clusters
 * Cluster health summary (public)
 *
 * Returns current cluster status without sensitive data.
 */
router.get('/clusters', asyncHandler(async (req, res) => {
  if (!stateManager) {
    return res.status(503).json({ error: 'Stats service not available' });
  }

  const clusterHealth = stateManager.getClusterHealth();
  const summary = {};

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
router.get('/usage', asyncHandler(async (req, res) => {
  const days = parseQueryInt(req.query, 'days', 7, { min: 1, max: 365 });

  // Get aggregate stats (no usernames)
  const releases = analytics.getReleaseUsage(days);
  const ides = analytics.getIdePopularity(days);
  const features = analytics.getFeatureUsage(days);
  const capacity = analytics.getCapacityMetrics(days);
  const dailySessions = analytics.getDailySessionCounts(days);

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
router.get('/variables', asyncHandler(async (req, res) => {
  const days = 7; // Week of data for averages

  const capacity = analytics.getCapacityMetrics(days);
  const dailySessions = analytics.getDailySessionCounts(days);

  // Calculate weekly totals
  const totalSessionsThisWeek = dailySessions.reduce((sum, d) => sum + d.sessions, 0);

  // Get cluster-specific queue wait times
  const queueWaitByCluster = analytics.getQueueWaitTimesByCluster(days);

  // Build variables map
  const variables = {
    // Session stats
    totalSessionsThisWeek,
    avgSessionsPerDay: Math.round(totalSessionsThisWeek / Math.max(days, 1)),

    // Queue wait times (in human-readable format)
    avgQueueWaitSeconds: capacity.queueWaitTimes?.avg ?? null,
    avgQueueWaitFormatted: formatSeconds(capacity.queueWaitTimes?.avg),
    p90QueueWaitFormatted: formatSeconds(capacity.queueWaitTimes?.p90),

    // Cluster-specific wait times
    geminiQueueWait: formatSeconds(queueWaitByCluster.gemini?.avg),
    apolloQueueWait: formatSeconds(queueWaitByCluster.apollo?.avg),

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
router.get('/queue/:cluster', asyncHandler(async (req, res) => {
  const { cluster } = req.params;
  const days = parseQueryInt(req.query, 'days', 7, { min: 1, max: 365 });

  const queueWaitByCluster = analytics.getQueueWaitTimesByCluster(days);
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
      avgFormatted: formatSeconds(clusterStats.avg),
      p50Seconds: clusterStats.p50,
      p50Formatted: formatSeconds(clusterStats.p50),
      p90Seconds: clusterStats.p90,
      p90Formatted: formatSeconds(clusterStats.p90),
      p99Seconds: clusterStats.p99,
      p99Formatted: formatSeconds(clusterStats.p99),
    },
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * GET /api/stats/partitions
 * Partition limits for all clusters (public)
 *
 * Returns dynamic partition data for resource validation.
 */
router.get('/partitions', asyncHandler(async (req, res) => {
  const allPartitions = partitions.getAllPartitions();
  const lastUpdated = partitions.getLastUpdated();

  // Transform for API response
  const result = {};
  for (const [cluster, clusterPartitions] of Object.entries(allPartitions)) {
    result[cluster] = {};
    for (const [partitionName, limits] of Object.entries(clusterPartitions)) {
      result[cluster][partitionName] = {
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
router.get('/partitions/:cluster', asyncHandler(async (req, res) => {
  const { cluster } = req.params;
  const clusterPartitions = partitions.getClusterPartitions(cluster);
  const lastUpdated = partitions.getLastUpdated(cluster);

  if (Object.keys(clusterPartitions).length === 0) {
    return res.status(404).json({
      error: `No partition data for cluster: ${cluster}`,
      availableClusters: Object.keys(partitions.getAllPartitions()),
    });
  }

  // Transform for API response
  const result = {};
  for (const [partitionName, limits] of Object.entries(clusterPartitions)) {
    result[partitionName] = {
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

  res.json({
    cluster,
    partitions: result,
    lastUpdated,
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * Format seconds into human-readable string
 * @param {number|null} seconds
 * @returns {string}
 */
function formatSeconds(seconds) {
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

module.exports = router;
module.exports.setStateManager = setStateManager;
