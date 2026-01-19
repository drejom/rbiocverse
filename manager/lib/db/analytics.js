/**
 * Analytics Query Functions
 * Provides aggregated data for admin reports and visualizations
 */

const { getDb } = require('../db');

/**
 * Get ISO date string for N days ago
 * @param {number} days - Number of days to go back
 * @returns {string} ISO date string
 */
function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

/**
 * Get ISO date string for N months ago
 * @param {number} months - Number of months to go back
 * @returns {string} ISO date string
 */
function monthsAgo(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString();
}

/**
 * Get release version usage statistics
 * @param {number} [days=30] - Number of days to analyze
 * @returns {Array<Object>}
 */
function getReleaseUsage(days = 30) {
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
  `).all(cutoff);
}

/**
 * Get resource request patterns
 * @param {number} [days=30] - Number of days to analyze
 * @returns {Object}
 */
function getResourcePatterns(days = 30) {
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
  `).get(cutoff);

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
 * @param {number} [days=30] - Number of days to analyze
 * @returns {Array<Object>}
 */
function getIdePopularity(days = 30) {
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
  `).all(cutoff);
}

/**
 * Get feature usage (Shiny, Live Server)
 * @param {number} [days=30] - Number of days to analyze
 * @returns {Object}
 */
function getFeatureUsage(days = 30) {
  const db = getDb();
  const cutoff = daysAgo(days);

  // Only VS Code sessions can use Shiny and Live Server
  const vscodeTotal = db.prepare(`
    SELECT COUNT(*) as count
    FROM session_history
    WHERE started_at >= ? AND ide = 'vscode'
  `).get(cutoff).count;

  const shinyCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM session_history
    WHERE started_at >= ? AND ide = 'vscode' AND used_shiny = 1
  `).get(cutoff).count;

  const liveServerCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM session_history
    WHERE started_at >= ? AND ide = 'vscode' AND used_live_server = 1
  `).get(cutoff).count;

  return {
    vscodeTotal,
    shiny: {
      count: shinyCount,
      percent: vscodeTotal > 0 ? Math.round((shinyCount / vscodeTotal) * 100) : 0,
    },
    liveServer: {
      count: liveServerCount,
      percent: vscodeTotal > 0 ? Math.round((liveServerCount / vscodeTotal) * 100) : 0,
    },
  };
}

/**
 * Get per-user usage summary
 * @param {string} username
 * @param {number} [days=90] - Number of days to analyze
 * @returns {Object}
 */
function getUserUsageSummary(username, days = 90) {
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
  `).get(username, cutoff);

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

/**
 * Get power users (candidates for HPC training)
 * Users with high resource usage patterns
 * @param {number} [days=30] - Number of days to analyze
 * @param {Object} [thresholds]
 * @returns {Array<Object>}
 */
function getPowerUsers(days = 30, thresholds = {}) {
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
  `).all(cutoff, minAvgCpus, minAvgDuration, minSessions);
}

/**
 * Get inactive users (cleanup candidates)
 * Users with no activity in specified period
 * @param {number} [inactiveDays=90] - Days of inactivity threshold
 * @returns {Array<Object>}
 */
function getInactiveUsers(inactiveDays = 90) {
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
  `).all(cutoff);
}

/**
 * Get new user success rate
 * @param {number} [days=30] - Number of days to analyze
 * @returns {Object}
 */
function getNewUserSuccessRate(days = 30) {
  const db = getDb();
  const cutoff = daysAgo(days);

  // Users who had their first session in the period
  const newUsers = db.prepare(`
    SELECT user, MIN(started_at) as firstSession, COUNT(*) as totalSessions,
           SUM(CASE WHEN end_reason = 'completed' THEN 1 ELSE 0 END) as completedSessions
    FROM session_history
    GROUP BY user
    HAVING MIN(started_at) >= ?
  `).all(cutoff);

  const withSuccessfulFirst = newUsers.filter(u => {
    // Check if their first session completed successfully
    const first = db.prepare(`
      SELECT end_reason FROM session_history
      WHERE user = ?
      ORDER BY started_at ASC
      LIMIT 1
    `).get(u.user);
    return first?.end_reason === 'completed';
  });

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
 * @param {number} [days=30] - Number of days to analyze
 * @returns {Object}
 */
function getCapacityMetrics(days = 30) {
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
  `).all(cutoff);

  const p50 = percentile(waitTimes.map(w => w.wait_seconds), 50);
  const p90 = percentile(waitTimes.map(w => w.wait_seconds), 90);
  const p99 = percentile(waitTimes.map(w => w.wait_seconds), 99);

  // Growth rate (compare last 30 days to previous 30 days)
  const recentSessions = db.prepare(`
    SELECT COUNT(*) as count, COUNT(DISTINCT user) as users
    FROM session_history
    WHERE started_at >= ?
  `).get(cutoff);

  const olderCutoff = daysAgo(days * 2);
  const previousSessions = db.prepare(`
    SELECT COUNT(*) as count, COUNT(DISTINCT user) as users
    FROM session_history
    WHERE started_at >= ? AND started_at < ?
  `).get(olderCutoff, cutoff);

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
 * @param {number} [days=30] - Number of days to analyze
 * @returns {Array<Object>}
 */
function getUsageByAccount(days = 30) {
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
  `).all(cutoff);
}

/**
 * Get daily session counts for heatmap
 * @param {number} [days=365] - Number of days
 * @returns {Array<Object>}
 */
function getDailySessionCounts(days = 365) {
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
  `).all(cutoff);
}

/**
 * Get release adoption curve
 * @param {string} version - Release version to track
 * @returns {Array<Object>}
 */
function getReleaseAdoption(version) {
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
  `).all(version);
}

/**
 * Get month-over-month growth trends
 * @param {number} [months=12] - Number of months to analyze
 * @returns {Array<Object>}
 */
function getGrowthTrends(months = 12) {
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
  `).all(cutoff);
}

/**
 * Get queue wait time statistics by cluster
 * @param {number} [days=30] - Number of days to analyze
 * @returns {Object}
 */
function getQueueWaitTimesByCluster(days = 30) {
  const db = getDb();
  const cutoff = daysAgo(days);

  const clusters = db.prepare(`
    SELECT DISTINCT hpc FROM session_history WHERE started_at >= ?
  `).all(cutoff);

  const result = {};
  for (const { hpc } of clusters) {
    const waitTimes = db.prepare(`
      SELECT wait_seconds
      FROM session_history
      WHERE started_at >= ? AND hpc = ? AND wait_seconds IS NOT NULL
      ORDER BY wait_seconds
    `).all(cutoff, hpc);

    const values = waitTimes.map(w => w.wait_seconds);
    result[hpc] = {
      count: values.length,
      avg: values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
      p99: percentile(values, 99),
    };
  }

  return result;
}

/**
 * Export raw session data as CSV-friendly format
 * @param {number} [days=30] - Number of days to export
 * @returns {Array<Object>}
 */
function exportRawSessions(days = 30) {
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
      used_shiny as usedShiny,
      used_live_server as usedLiveServer,
      job_id as jobId,
      node
    FROM session_history
    WHERE started_at >= ?
    ORDER BY started_at DESC
  `).all(cutoff);
}

/**
 * Export aggregated summary data
 * @param {number} [days=30] - Number of days to summarize
 * @returns {Array<Object>}
 */
function exportSummary(days = 30) {
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
      SUM(used_shiny) as shinySessions,
      SUM(used_live_server) as liveServerSessions
    FROM session_history
    WHERE started_at >= ?
    GROUP BY user, account, ide, hpc
    ORDER BY computeHours DESC
  `).all(cutoff);
}

// Helper function to calculate percentile
function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

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
