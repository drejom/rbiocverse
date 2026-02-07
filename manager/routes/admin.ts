/**
 * Admin Routes
 * Provides admin panel content and user management APIs
 *
 * All routes require admin authentication.
 * Content is served from /content/admin/ similar to help.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { log } from '../lib/logger';
import { requireAuth } from './auth';
import { requireAdmin } from '../lib/auth/admin';
import * as dbUsers from '../lib/db/users';
import { clearSessionKey } from '../lib/auth/session-keys';
import * as analytics from '../lib/db/analytics';
import * as dbHealth from '../lib/db/health';
import * as dbSessions from '../lib/db/sessions';
import * as partitions from '../lib/partitions';
import asyncHandler from '../lib/asyncHandler';
import ContentManager from '../lib/content';
import { schemas, validate, parseQueryInt, parseQueryParams, queryString } from '../lib/validation';

// Helper to safely get string from req.params (always string in Express, but TS types are broad)
const param = (req: Request, name: string): string => req.params[name] as string;

const router = express.Router();

// Parse JSON bodies for admin routes
router.use(express.json());

// All admin routes require authentication and admin privileges
router.use(requireAuth);
router.use(requireAdmin);

// Content manager for admin panel content (uses shared ContentManager)
const ADMIN_CONTENT_DIR = path.join(__dirname, '../content/admin');
const CONTENT_DIR = path.join(__dirname, '../content');
const contentManager = new ContentManager(ADMIN_CONTENT_DIR);
contentManager.setIconsPath(path.join(CONTENT_DIR, 'icons.json'));

// Extend Express Request to include user property
interface AuthenticatedRequest extends Request {
  user?: {
    username: string;
    fullName?: string;
  };
}

// StateManager type (simplified for this module)
interface StateManager {
  state: {
    sessions: Record<string, { status?: string } | null>;
  };
  getClusterHealth(): Record<string, unknown>;
  getClusterHistory(): Record<string, unknown>;
}

// StateManager will be injected via setStateManager()
let stateManager: StateManager | null = null;

/**
 * Set the state manager for accessing cluster health data
 * @param sm - State manager instance
 */
function setStateManager(sm: StateManager): void {
  stateManager = sm;
}

// =============================================================================
// Content Routes (using shared ContentManager)
// =============================================================================

/**
 * GET /api/admin
 * Returns the admin content index
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const index = await contentManager.loadIndex();
  res.json(index);
}));

/**
 * GET /api/admin/search
 * Search admin content
 */
router.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const q = queryString(req.query.q);

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  const results = await contentManager.search(q);
  res.json({ query: q, results });
}));

/**
 * GET /api/admin/index
 * Returns the admin content index (same as /)
 */
router.get('/index', asyncHandler(async (req: Request, res: Response) => {
  const index = await contentManager.loadIndex();
  res.json(index);
}));

/**
 * GET /api/admin/content/:section
 * Returns markdown content for an admin section
 */
router.get('/content/:section', asyncHandler(async (req: Request, res: Response) => {
  const section = param(req, 'section');
  const sectionInfo = await contentManager.getSectionInfo(section);

  if (!sectionInfo) {
    return res.status(404).json({ error: `Admin section '${section}' not found` });
  }

  let content = await contentManager.loadSection(section);
  content = await contentManager.processIcons(content);

  res.json({
    id: sectionInfo.id,
    title: sectionInfo.title,
    icon: sectionInfo.icon,
    content,
  });
}));

// =============================================================================
// User Management Routes (using db/users directly)
// =============================================================================

interface User {
  username: string;
  fullName: string;
  publicKey: string | null;
  privateKey: string | null;
  setupComplete: boolean;
  createdAt: string;
}

/**
 * GET /api/admin/users
 * List all users
 */
router.get('/users', asyncHandler(async (req: Request, res: Response) => {
  const users = dbUsers.getAllUsers() as Map<string, User>;
  const userList: Array<{
    username: string;
    fullName: string;
    hasPublicKey: boolean;
    setupComplete: boolean;
    createdAt: string;
  }> = [];

  for (const [username, user] of users) {
    userList.push({
      username,
      fullName: user.fullName,
      hasPublicKey: !!user.publicKey,
      setupComplete: user.setupComplete,
      createdAt: user.createdAt,
    });
  }

  // Sort by creation date, newest first
  userList.sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  res.json({ users: userList, total: userList.length });
}));

/**
 * GET /api/admin/users/:username
 * Get a single user's details
 */
router.get('/users/:username',
  validate(schemas.usernameParam, 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    const username = param(req, 'username');
    const user = dbUsers.getUser(username) as User | null;

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      username,
      fullName: user.fullName,
      hasPublicKey: !!user.publicKey,
      publicKey: user.publicKey,
      setupComplete: user.setupComplete,
      createdAt: user.createdAt,
    });
  })
);

/**
 * PUT /api/admin/users/:username
 * Update user fields (fullName, etc.)
 */
router.put('/users/:username',
  validate(schemas.usernameParam, 'params'),
  validate(schemas.updateUser, 'body'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const username = param(req, 'username');
    const { fullName } = req.body;

    const user = dbUsers.getUser(username) as User | null;
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Only allow updating specific fields
    if (fullName !== undefined) {
      user.fullName = fullName;
    }

    dbUsers.setUser(username, user);

    log.info('Admin updated user', { admin: req.user!.username, targetUser: username });

    res.json({
      success: true,
      user: {
        username,
        fullName: user.fullName,
        hasPublicKey: !!user.publicKey,
        setupComplete: user.setupComplete,
        createdAt: user.createdAt,
      },
    });
  })
);

/**
 * DELETE /api/admin/users/:username
 * Delete a user entirely
 */
router.delete('/users/:username',
  validate(schemas.usernameParam, 'params'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const username = param(req, 'username');

    // Prevent admin from deleting themselves
    if (username === req.user!.username) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const user = dbUsers.getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    dbUsers.deleteUser(username);

    // Clear any active session key
    clearSessionKey(username);

    log.info('Admin deleted user', { admin: req.user!.username, deletedUser: username });

    res.json({ success: true });
  })
);

/**
 * DELETE /api/admin/users/:username/key
 * Delete a user's SSH key (forces re-setup)
 */
router.delete('/users/:username/key',
  validate(schemas.usernameParam, 'params'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const username = param(req, 'username');

    const user = dbUsers.getUser(username) as User | null;
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.publicKey) {
      return res.json({
        success: true,
        message: 'User has no managed key',
      });
    }

    // Remove the managed key
    user.publicKey = null;
    user.privateKey = null;
    user.setupComplete = false;

    dbUsers.setUser(username, user);

    // Clear session key
    clearSessionKey(username);

    log.info('Admin deleted user key', { admin: req.user!.username, targetUser: username });

    res.json({ success: true });
  })
);

/**
 * POST /api/admin/users/bulk
 * Bulk operations on users
 * Body: { action: 'delete-keys' | 'delete', usernames: string[] }
 */
router.post('/users/bulk',
  validate(schemas.bulkUserAction, 'body'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { action, usernames } = req.body as { action: string; usernames: string[] };

    // Filter out admin's own username from bulk deletes
    const filteredUsernames = usernames.filter(u => u !== req.user!.username);

    const results: { success: string[]; failed: Array<{ username: string; error: string }> } = { success: [], failed: [] };

    for (const username of filteredUsernames) {
      const user = dbUsers.getUser(username) as User | null;
      if (!user) {
        results.failed.push({ username, error: 'Not found' });
        continue;
      }

      try {
        if (action === 'delete-keys') {
          user.publicKey = null;
          user.privateKey = null;
          user.setupComplete = false;
          dbUsers.setUser(username, user);
          clearSessionKey(username);
          results.success.push(username);
        } else if (action === 'delete') {
          dbUsers.deleteUser(username);
          clearSessionKey(username);
          results.success.push(username);
        } else {
          results.failed.push({ username, error: 'Unknown action' });
        }
      } catch (err) {
        results.failed.push({ username, error: (err as Error).message });
      }
    }

    log.info('Admin bulk operation', {
      admin: req.user!.username,
      action,
      successCount: results.success.length,
      failedCount: results.failed.length,
    });

    res.json(results);
  })
);

// =============================================================================
// Partition Management Routes
// =============================================================================

/**
 * GET /api/admin/partitions
 * Get all partition limits with full details
 */
router.get('/partitions', asyncHandler(async (req: Request, res: Response) => {
  log.debug('GET /api/admin/partitions called');
  const allPartitions = partitions.getAllPartitions();
  const lastUpdated = partitions.getLastUpdated();

  res.json({
    partitions: allPartitions,
    lastUpdated,
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * POST /api/admin/partitions/refresh
 * Trigger refresh of partition data from all clusters
 */
router.post('/partitions/refresh', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  log.info('Admin triggered partition refresh', { admin: req.user!.username });

  const results = await partitions.refreshAllPartitions();
  const allPartitions = partitions.getAllPartitions();
  const lastUpdated = partitions.getLastUpdated();

  // Summarize results
  const summary: Record<string, { success: boolean; partitionCount: number; error: string | null }> = {};
  for (const [cluster, result] of Object.entries(results as Record<string, { success: boolean; partitions?: unknown[]; error?: string }>)) {
    summary[cluster] = {
      success: result.success,
      partitionCount: result.success ? (result.partitions?.length || 0) : 0,
      error: result.error || null,
    };
  }

  res.json({
    results: summary,
    partitions: allPartitions,
    lastUpdated,
    generatedAt: new Date().toISOString(),
  });
}));

// =============================================================================
// Reports Routes
// =============================================================================

/**
 * GET /api/admin/reports/usage
 * Get usage statistics
 */
router.get('/reports/usage', asyncHandler(async (req: Request, res: Response) => {
  const users = dbUsers.getAllUsers() as Map<string, User>;

  // Basic stats
  const stats = {
    totalUsers: users.size,
    usersWithKeys: 0,
    usersSetupComplete: 0,
  };

  for (const [, user] of users) {
    if (user.publicKey) stats.usersWithKeys++;
    if (user.setupComplete) stats.usersSetupComplete++;
  }

  // Session stats from state manager (if available)
  let sessionStats: { activeSessions: number; pendingSessions: number } | null = null;
  if (stateManager) {
    const state = stateManager.state;
    sessionStats = {
      activeSessions: Object.values(state.sessions).filter(s => s?.status === 'running').length,
      pendingSessions: Object.values(state.sessions).filter(s => s?.status === 'pending').length,
    };
  }

  res.json({
    stats,
    sessionStats,
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * GET /api/admin/reports/clusters
 * Get cluster health summary
 */
router.get('/reports/clusters', asyncHandler(async (req: Request, res: Response) => {
  if (!stateManager) {
    return res.status(503).json({ error: 'State manager not available' });
  }

  const clusterHealth = stateManager.getClusterHealth();
  const clusterHistory = stateManager.getClusterHistory();

  res.json({
    health: clusterHealth,
    history: clusterHistory,
    generatedAt: new Date().toISOString(),
  });
}));

// =============================================================================
// Analytics Routes (using asyncHandler for cleaner error handling)
// =============================================================================

/**
 * GET /api/admin/analytics/releases
 * Bioconductor version popularity
 */
router.get('/analytics/releases', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getReleaseUsage(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/resources
 * Resource request patterns (CPU, memory, time)
 */
router.get('/analytics/resources', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getResourcePatterns(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/ides
 * IDE popularity
 */
router.get('/analytics/ides', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getIdePopularity(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/features
 * Shiny/Live Server usage rates
 */
router.get('/analytics/features', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getFeatureUsage(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/users/:username
 * Per-user usage summary
 */
router.get('/analytics/users/:username', asyncHandler(async (req: Request, res: Response) => {
  const username = param(req, 'username');
  const days = parseQueryInt(req.query, 'days', 90, { min: 1, max: 365 });
  const data = analytics.getUserUsageSummary(username, days);
  res.json({ data, username, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/power-users
 * Users with large/long job patterns (training candidates)
 */
router.get('/analytics/power-users', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getPowerUsers(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/inactive
 * Users with no activity in 90+ days (cleanup candidates)
 */
router.get('/analytics/inactive', asyncHandler(async (req: Request, res: Response) => {
  const days = parseQueryInt(req.query, 'days', 90, { min: 1, max: 365 });
  const data = analytics.getInactiveUsers(days);
  res.json({ data, inactiveDays: days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/new-users
 * New user success rate
 */
router.get('/analytics/new-users', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getNewUserSuccessRate(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/capacity
 * Peak concurrent sessions, resource saturation, growth rate
 */
router.get('/analytics/capacity', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getCapacityMetrics(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/queue
 * Queue wait time stats
 */
router.get('/analytics/queue', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getQueueWaitTimesByCluster(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/heatmap/sessions
 * Daily session counts for GitHub-style heatmap
 */
router.get('/analytics/heatmap/sessions', asyncHandler(async (req: Request, res: Response) => {
  const days = parseQueryInt(req.query, 'days', 365, { min: 1, max: 365 });
  const data = analytics.getDailySessionCounts(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/heatmap/cluster/:hpc
 * Daily cluster utilization for heatmap
 */
router.get('/analytics/heatmap/cluster/:hpc', asyncHandler(async (req: Request, res: Response) => {
  const hpc = param(req, 'hpc');
  const days = parseQueryInt(req.query, 'days', 365, { min: 1, max: 365 });
  const data = dbHealth.getDailyHealthAggregates(hpc, days);
  res.json({ data, hpc, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/adoption/:version
 * Cumulative user adoption curve for a release
 */
router.get('/analytics/adoption/:version', asyncHandler(async (req: Request, res: Response) => {
  const version = param(req, 'version');
  const data = analytics.getReleaseAdoption(version);
  res.json({ data, version, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/growth
 * Month-over-month session/user growth
 */
router.get('/analytics/growth', asyncHandler(async (req: Request, res: Response) => {
  const months = parseQueryInt(req.query, 'months', 12, { min: 1, max: 24 });
  const data = analytics.getGrowthTrends(months);
  res.json({ data, months, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/by-account
 * Usage breakdown by Slurm account/PI
 */
router.get('/analytics/by-account', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.getUsageByAccount(days);
  res.json({ data, days, generatedAt: new Date().toISOString() });
}));

/**
 * GET /api/admin/analytics/export/raw
 * CSV download: one row per session
 */
router.get('/analytics/export/raw', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.exportRawSessions(days) as unknown as Array<Record<string, unknown>>;

  // Convert to CSV
  if (data.length === 0) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sessions-raw.csv"');
    return res.send('No data available');
  }

  const headers = Object.keys(data[0]);
  const csvRows = [
    headers.join(','),
    ...data.map(row =>
      headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      }).join(',')
    )
  ];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="sessions-raw-${days}d.csv"`);
  res.send(csvRows.join('\n'));
}));

/**
 * GET /api/admin/analytics/export/summary
 * CSV download: aggregated by user/account/IDE
 */
router.get('/analytics/export/summary', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parseQueryParams(req.query);
  const data = analytics.exportSummary(days) as unknown as Array<Record<string, unknown>>;

  // Convert to CSV
  if (data.length === 0) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sessions-summary.csv"');
    return res.send('No data available');
  }

  const headers = Object.keys(data[0]);
  const csvRows = [
    headers.join(','),
    ...data.map(row =>
      headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      }).join(',')
    )
  ];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="sessions-summary-${days}d.csv"`);
  res.send(csvRows.join('\n'));
}));

/**
 * GET /api/admin/analytics/sessions
 * Get session history (paginated)
 */
router.get('/analytics/sessions', asyncHandler(async (req: Request, res: Response) => {
  const { days, limit, offset } = parseQueryParams(req.query);
  const { user, hpc, ide } = req.query as { user?: string; hpc?: string; ide?: string };

  const data = dbSessions.getSessionHistory({ days, user, hpc, ide, limit, offset });
  const total = dbSessions.getSessionHistoryCount({ days, user });

  res.json({
    data,
    pagination: { limit, offset, total },
    filters: { days, user, hpc, ide },
    generatedAt: new Date().toISOString(),
  });
}));

export default router;
export { setStateManager };

// CommonJS compatibility for existing require() calls
module.exports = router;
module.exports.setStateManager = setStateManager;
