/**
 * Analytics Query Functions
 * Provides aggregated data for admin reports and visualizations
 */

import { getDb } from '../db';

// Result interfaces for analytics queries
export interface ReleaseUsageRow {
  version: string;
  sessions: number;
  uniqueUsers: number;
}

export interface IdePopularityRow {
  ide: string;
  sessions: number;
  uniqueUsers: number;
  avgDurationMinutes: number | null;
}

export interface PowerUserRow {
  user: string;
  sessions: number;
  avgCpus: number;
  avgDuration: number;
  maxCpus: number;
  maxDuration: number;
  gpuSessions: number;
}

export interface InactiveUserRow {
  user: string;
  lastSession: string;
  totalSessions: number;
  daysSinceLastSession: number;
}

export interface AccountUsageRow {
  account: string;
  sessions: number;
  uniqueUsers: number;
  totalMinutes: number | null;
  computeHours: number | null;
  avgCpus: number | null;
  gpuSessions: number;
}

export interface DailySessionRow {
  date: string;
  sessions: number;
  uniqueUsers: number;
}

export interface ReleaseAdoptionRow {
  date: string;
  newUsers: number;
  cumulativeUsers: number;
}

export interface GrowthTrendRow {
  month: string;
  sessions: number;
  uniqueUsers: number;
  totalMinutes: number | null;
  computeHours: number | null;
}

export interface RawSessionRow {
  user: string;
  hpc: string;
  ide: string;
  account: string | null;
  cpus: number | null;
  memory: string | null;
  walltime: string | null;
  gpu: string | null;
  releaseVersion: string | null;
  submittedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  waitSeconds: number | null;
  durationMinutes: number | null;
  endReason: string | null;
  errorMessage: string | null;
  usedDevServer: number;
  jobId: string | null;
  node: string | null;
}

export interface SummaryRow {
  user: string;
  account: string | null;
  ide: string;
  hpc: string;
  sessions: number;
  totalMinutes: number | null;
  computeHours: number | null;
  avgCpus: number | null;
  avgWaitSeconds: number | null;
  gpuSessions: number;
  shinySessions: number;
  liveServerSessions: number;
}

/**
 * Get ISO date string for N days ago
 */
function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

/**
 * Get ISO date string for N months ago
 */
function monthsAgo(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString();
}

/**
 * Get release version usage statistics
 */
function getReleaseUsage(days: number = 30): ReleaseUsageRow[] {
  const db = getDb();
  const cutoff = daysAgo(days);

  return db.prepare(`
    SELECT
      release_version as version,
      COUNT(*) as sessions,
      COUNT(DISTINCT user) as uniqueUsers
    FROM session_history
    WHERE started_at >= ? AND release_version IS NOT NULL
    GROUP BY release_version
    ORDER BY sessions DESC
  `).all(cutoff) as ReleaseUsageRow[];
}

/**
 * Get resource request patterns
 */
function getResourcePatterns(days: number = 30): Record<string, unknown> {
  const db = getDb();
  const cutoff = daysAgo(days);

  const stats = db.prepare(`
    SELECT
      AVG(cpus) as avgCpus,
      MIN(cpus) as minCpus,
      MAX(cpus) as maxCpus,
      AVG(duration_minutes) as avgDurationMinutes,
      COUNT(*) as totalSessions,
      COUNT(DISTINCT user) as uniqueUsers
    FROM session_history
    WHERE started_at >= ?
  `).get(cutoff) as Record<string, unknown>;

  // CPU distribution
  const cpuDistribution = db.prepare(`
    SELECT cpus, COUNT(*) as count
    FROM session_history
    WHERE started_at >= ? AND cpus IS NOT NULL
    GROUP BY cpus
    ORDER BY cpus
  `).all(cutoff);

  // GPU usage
  const gpuUsage = db.prepare(`
    SELECT
      gpu,
      COUNT(*) as count
    FROM session_history
    WHERE started_at >= ? AND gpu IS NOT NULL
    GROUP BY gpu
    ORDER BY count DESC
  `).all(cutoff);

  // Memory patterns (extract numeric value from memory string like "40G")
  const memoryPatterns = db.prepare(`
    SELECT memory, COUNT(*) as count
    FROM session_history
    WHERE started_at >= ? AND memory IS NOT NULL
    GROUP BY memory
    ORDER BY count DESC
    LIMIT 10
  `).all(cutoff);

  return {
    ...stats,
    cpuDistribution,
    gpuUsage,
    memoryPatterns,
  };
}

/**
 * Get IDE popularity statistics
 */
function getIdePopularity(days: number = 30): IdePopularityRow[] {
  const db = getDb();
  const cutoff = daysAgo(days);

  return db.prepare(`
    SELECT
      ide,
      COUNT(*) as sessions,
      COUNT(DISTINCT user) as uniqueUsers,
      AVG(duration_minutes) as avgDurationMinutes
    FROM session_history
    WHERE started_at >= ?
    GROUP BY ide
    ORDER BY sessions DESC
  `).all(cutoff) as IdePopularityRow[];
}

/**
 * Get feature usage (Dev Server - includes Live Server, Shiny, etc.)
 */
function getFeatureUsage(days: number = 30): Record<string, unknown> {
  const db = getDb();
  const cutoff = daysAgo(days);

  // Only VS Code sessions can use dev servers
  const vscodeTotal = (db.prepare(`
    SELECT COUNT(*) as count
    FROM session_history
    WHERE started_at >= ? AND ide = 'vscode'
  `).get(cutoff) as { count: number }).count;

  const devServerCount = (db.prepare(`
    SELECT COUNT(*) as count
    FROM session_history
    WHERE started_at >= ? AND ide = 'vscode' AND used_dev_server = 1
  `).get(cutoff) as { count: number }).count;

  return {
    vscodeTotal,
    devServer: {
      count: devServerCount,
      percent: vscodeTotal > 0 ? Math.round((devServerCount / vscodeTotal) * 100) : 0,
    },
  };
}

/**
 * Get per-user usage summary
 */
function getUserUsageSummary(username: string, days: number = 90): Record<string, unknown> {
  const db = getDb();
  const cutoff = daysAgo(days);

  const summary = db.prepare(`
    SELECT
      COUNT(*) as totalSessions,
      AVG(cpus) as avgCpus,
      AVG(duration_minutes) as avgDurationMinutes,
      SUM(duration_minutes) as totalMinutes,
      MIN(started_at) as firstSession,
      MAX(started_at) as lastSession
    FROM session_history
    WHERE user = ? AND started_at >= ?
  `).get(username, cutoff) as Record<string, unknown>;

  const ideBreakdown = db.prepare(`
    SELECT ide, COUNT(*) as count
    FROM session_history
    WHERE user = ? AND started_at >= ?
    GROUP BY ide
    ORDER BY count DESC
  `).all(username, cutoff);

  const clusterBreakdown = db.prepare(`
    SELECT hpc, COUNT(*) as count
    FROM session_history
    WHERE user = ? AND started_at >= ?
    GROUP BY hpc
    ORDER BY count DESC
  `).all(username, cutoff);

  return {
    ...summary,
    ideBreakdown,
    clusterBreakdown,
  };
}

interface PowerUserThresholds {
  minAvgCpus?: number;
  minAvgDuration?: number;
  minSessions?: number;
}

/**
 * Get power users (candidates for HPC training)
 * Users with high resource usage patterns
 */
function getPowerUsers(days: number = 30, thresholds: PowerUserThresholds = {}): PowerUserRow[] {
  const db = getDb();
  const cutoff = daysAgo(days);

  const { minAvgCpus = 8, minAvgDuration = 480, minSessions = 3 } = thresholds;

  return db.prepare(`
    SELECT
      user,
      COUNT(*) as sessions,
      AVG(cpus) as avgCpus,
      AVG(duration_minutes) as avgDuration,
      MAX(cpus) as maxCpus,
      MAX(duration_minutes) as maxDuration,
      SUM(CASE WHEN gpu IS NOT NULL THEN 1 ELSE 0 END) as gpuSessions
    FROM session_history
    WHERE started_at >= ?
    GROUP BY user
    HAVING (AVG(cpus) > ? OR AVG(duration_minutes) > ?) AND COUNT(*) >= ?
    ORDER BY avgCpus DESC, avgDuration DESC
  `).all(cutoff, minAvgCpus, minAvgDuration, minSessions) as PowerUserRow[];
}

/**
 * Get inactive users (cleanup candidates)
 * Users with no activity in specified period
 */
function getInactiveUsers(inactiveDays: number = 90): InactiveUserRow[] {
  const db = getDb();
  const cutoff = daysAgo(inactiveDays);

  // Get users who have session history but none recent
  return db.prepare(`
    SELECT
      user,
      MAX(started_at) as lastSession,
      COUNT(*) as totalSessions,
      julianday('now') - julianday(MAX(started_at)) as daysSinceLastSession
    FROM session_history
    GROUP BY user
    HAVING MAX(started_at) < ?
    ORDER BY lastSession ASC
  `).all(cutoff) as InactiveUserRow[];
}

/**
 * Get new user success rate
 */
function getNewUserSuccessRate(days: number = 30): Record<string, unknown> {
  const db = getDb();
  const cutoff = daysAgo(days);

  // Single query: get new users with their first session's end_reason
  // Uses window function to identify first session per user
  const newUsers = db.prepare(`
    WITH first_sessions AS (
      SELECT
        user,
        started_at,
        end_reason,
        ROW_NUMBER() OVER (PARTITION BY user ORDER BY started_at ASC) as rn
      FROM session_history
    ),
    user_stats AS (
      SELECT
        user,
        MIN(started_at) as firstSession,
        COUNT(*) as totalSessions,
        SUM(CASE WHEN end_reason = 'completed' THEN 1 ELSE 0 END) as completedSessions
      FROM session_history
      GROUP BY user
      HAVING MIN(started_at) >= ?
    )
    SELECT
      us.user,
      us.firstSession,
      us.totalSessions,
      us.completedSessions,
      fs.end_reason as firstSessionEndReason
    FROM user_stats us
    LEFT JOIN first_sessions fs ON us.user = fs.user AND fs.rn = 1
  `).all(cutoff) as Array<{ user: string; firstSession: string; totalSessions: number; completedSessions: number; firstSessionEndReason: string }>;

  const withSuccessfulFirst = newUsers.filter(u => u.firstSessionEndReason === 'completed');

  return {
    totalNewUsers: newUsers.length,
    successfulFirstSession: withSuccessfulFirst.length,
    successRate: newUsers.length > 0
      ? Math.round((withSuccessfulFirst.length / newUsers.length) * 100)
      : 0,
    newUsers: newUsers.map(u => ({
      user: u.user,
      firstSession: u.firstSession,
      totalSessions: u.totalSessions,
      completedSessions: u.completedSessions,
    })),
  };
}

/**
 * Get capacity planning metrics
 */
function getCapacityMetrics(days: number = 30): Record<string, unknown> {
  const db = getDb();
  const cutoff = daysAgo(days);

  // Peak concurrent sessions (approximate via overlapping time windows)
  // This is simplified - would need more complex query for true overlap
  const dailyPeaks = db.prepare(`
    SELECT
      date(started_at) as date,
      COUNT(*) as sessions,
      MAX(CASE
        WHEN duration_minutes IS NOT NULL THEN duration_minutes
        ELSE 0
      END) as maxDuration
    FROM session_history
    WHERE started_at >= ?
    GROUP BY date(started_at)
    ORDER BY sessions DESC
    LIMIT 1
  `).get(cutoff);

  // Queue wait time percentiles
  const waitTimes = db.prepare(`
    SELECT wait_seconds
    FROM session_history
    WHERE started_at >= ? AND wait_seconds IS NOT NULL
    ORDER BY wait_seconds
  `).all(cutoff) as Array<{ wait_seconds: number }>;

  const p50 = percentile(waitTimes.map(w => w.wait_seconds), 50);
  const p90 = percentile(waitTimes.map(w => w.wait_seconds), 90);
  const p99 = percentile(waitTimes.map(w => w.wait_seconds), 99);

  // Growth rate (compare last 30 days to previous 30 days)
  const recentSessions = db.prepare(`
    SELECT COUNT(*) as count, COUNT(DISTINCT user) as users
    FROM session_history
    WHERE started_at >= ?
  `).get(cutoff) as { count: number; users: number };

  const olderCutoff = daysAgo(days * 2);
  const previousSessions = db.prepare(`
    SELECT COUNT(*) as count, COUNT(DISTINCT user) as users
    FROM session_history
    WHERE started_at >= ? AND started_at < ?
  `).get(olderCutoff, cutoff) as { count: number; users: number };

  const sessionGrowth = previousSessions.count > 0
    ? Math.round(((recentSessions.count - previousSessions.count) / previousSessions.count) * 100)
    : null;

  const userGrowth = previousSessions.users > 0
    ? Math.round(((recentSessions.users - previousSessions.users) / previousSessions.users) * 100)
    : null;

  return {
    peakDay: dailyPeaks,
    queueWaitTimes: {
      p50,
      p90,
      p99,
      avg: waitTimes.length > 0
        ? Math.round(waitTimes.reduce((a, b) => a + b.wait_seconds, 0) / waitTimes.length)
        : null,
    },
    growth: {
      sessionGrowthPercent: sessionGrowth,
      userGrowthPercent: userGrowth,
      recentPeriod: { sessions: recentSessions.count, users: recentSessions.users },
      previousPeriod: { sessions: previousSessions.count, users: previousSessions.users },
    },
  };
}

/**
 * Get usage by Slurm account/PI
 */
function getUsageByAccount(days: number = 30): AccountUsageRow[] {
  const db = getDb();
  const cutoff = daysAgo(days);

  return db.prepare(`
    SELECT
      COALESCE(account, 'unknown') as account,
      COUNT(*) as sessions,
      COUNT(DISTINCT user) as uniqueUsers,
      SUM(duration_minutes) as totalMinutes,
      ROUND(SUM(duration_minutes * COALESCE(cpus, 1)) / 60.0, 1) as computeHours,
      AVG(cpus) as avgCpus,
      SUM(CASE WHEN gpu IS NOT NULL THEN 1 ELSE 0 END) as gpuSessions
    FROM session_history
    WHERE started_at >= ?
    GROUP BY account
    ORDER BY computeHours DESC
  `).all(cutoff) as AccountUsageRow[];
}

/**
 * Get daily session counts for heatmap
 */
function getDailySessionCounts(days: number = 365): DailySessionRow[] {
  const db = getDb();
  const cutoff = daysAgo(days);

  return db.prepare(`
    SELECT
      date(started_at) as date,
      COUNT(*) as sessions,
      COUNT(DISTINCT user) as uniqueUsers
    FROM session_history
    WHERE started_at >= ?
    GROUP BY date(started_at)
    ORDER BY date ASC
  `).all(cutoff) as DailySessionRow[];
}

/**
 * Get release adoption curve
 */
function getReleaseAdoption(version: string): ReleaseAdoptionRow[] {
  const db = getDb();

  // Get cumulative unique users over time for this version
  return db.prepare(`
    WITH first_use AS (
      SELECT user, MIN(started_at) as first_use_date
      FROM session_history
      WHERE release_version = ?
      GROUP BY user
    )
    SELECT
      date(first_use_date) as date,
      COUNT(*) as newUsers,
      SUM(COUNT(*)) OVER (ORDER BY date(first_use_date)) as cumulativeUsers
    FROM first_use
    GROUP BY date(first_use_date)
    ORDER BY date ASC
  `).all(version) as ReleaseAdoptionRow[];
}

/**
 * Get month-over-month growth trends
 */
function getGrowthTrends(months: number = 12): GrowthTrendRow[] {
  const db = getDb();
  const cutoff = monthsAgo(months);

  return db.prepare(`
    SELECT
      strftime('%Y-%m', started_at) as month,
      COUNT(*) as sessions,
      COUNT(DISTINCT user) as uniqueUsers,
      SUM(duration_minutes) as totalMinutes,
      ROUND(SUM(duration_minutes * COALESCE(cpus, 1)) / 60.0, 1) as computeHours
    FROM session_history
    WHERE started_at >= ?
    GROUP BY strftime('%Y-%m', started_at)
    ORDER BY month ASC
  `).all(cutoff) as GrowthTrendRow[];
}

/**
 * Get queue wait time statistics by cluster
 */
function getQueueWaitTimesByCluster(days: number = 30): Record<string, unknown> {
  const db = getDb();
  const cutoff = daysAgo(days);

  // Single query with GROUP BY to get all cluster stats at once
  const clusterStats = db.prepare(`
    SELECT
      hpc,
      COUNT(*) as count,
      AVG(wait_seconds) as avg_wait,
      GROUP_CONCAT(wait_seconds) as wait_values
    FROM session_history
    WHERE started_at >= ? AND wait_seconds IS NOT NULL
    GROUP BY hpc
  `).all(cutoff) as Array<{ hpc: string; count: number; avg_wait: number | null; wait_values: string | null }>;

  const result: Record<string, unknown> = {};
  for (const row of clusterStats) {
    // Parse concatenated values for percentile calculation
    const values = row.wait_values
      ? row.wait_values.split(',').map(Number).sort((a, b) => a - b)
      : [];

    result[row.hpc] = {
      count: row.count,
      avg: row.avg_wait !== null ? Math.round(row.avg_wait) : null,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
      p99: percentile(values, 99),
    };
  }

  return result;
}

/**
 * Export raw session data as CSV-friendly format
 */
function exportRawSessions(days: number = 30): RawSessionRow[] {
  const db = getDb();
  const cutoff = daysAgo(days);

  return db.prepare(`
    SELECT
      user, hpc, ide, account, cpus, memory, walltime, gpu,
      release_version as releaseVersion,
      submitted_at as submittedAt,
      started_at as startedAt,
      ended_at as endedAt,
      wait_seconds as waitSeconds,
      duration_minutes as durationMinutes,
      end_reason as endReason,
      error_message as errorMessage,
      used_dev_server as usedDevServer,
      job_id as jobId,
      node
    FROM session_history
    WHERE started_at >= ?
    ORDER BY started_at DESC
  `).all(cutoff) as RawSessionRow[];
}

/**
 * Export aggregated summary data
 */
function exportSummary(days: number = 30): SummaryRow[] {
  const db = getDb();
  const cutoff = daysAgo(days);

  return db.prepare(`
    SELECT
      user,
      account,
      ide,
      hpc,
      COUNT(*) as sessions,
      SUM(duration_minutes) as totalMinutes,
      ROUND(SUM(duration_minutes * COALESCE(cpus, 1)) / 60.0, 1) as computeHours,
      AVG(cpus) as avgCpus,
      AVG(wait_seconds) as avgWaitSeconds,
      SUM(CASE WHEN gpu IS NOT NULL THEN 1 ELSE 0 END) as gpuSessions,
      SUM(used_dev_server) as devServerSessions
    FROM session_history
    WHERE started_at >= ?
    GROUP BY user, account, ide, hpc
    ORDER BY computeHours DESC
  `).all(cutoff) as SummaryRow[];
}

// Helper function to calculate percentile
function percentile(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export {
  // Usage patterns
  getReleaseUsage,
  getResourcePatterns,
  getIdePopularity,
  getFeatureUsage,

  // User insights
  getUserUsageSummary,
  getPowerUsers,
  getInactiveUsers,
  getNewUserSuccessRate,

  // Capacity planning
  getCapacityMetrics,
  getQueueWaitTimesByCluster,

  // Reporting
  getUsageByAccount,
  getDailySessionCounts,
  getReleaseAdoption,
  getGrowthTrends,

  // Export
  exportRawSessions,
  exportSummary,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  // Usage patterns
  getReleaseUsage,
  getResourcePatterns,
  getIdePopularity,
  getFeatureUsage,

  // User insights
  getUserUsageSummary,
  getPowerUsers,
  getInactiveUsers,
  getNewUserSuccessRate,

  // Capacity planning
  getCapacityMetrics,
  getQueueWaitTimesByCluster,

  // Reporting
  getUsageByAccount,
  getDailySessionCounts,
  getReleaseAdoption,
  getGrowthTrends,

  // Export
  exportRawSessions,
  exportSummary,
};
