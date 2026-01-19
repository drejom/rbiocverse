/**
 * Admin Routes
 * Provides admin panel content and user management APIs
 *
 * All routes require admin authentication.
 * Content is served from /content/admin/ similar to help.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { log } = require('../lib/logger');
const { requireAuth } = require('./auth');
const { requireAdmin } = require('../lib/auth/admin');
const { getAllUsers, getUser, setUser, saveUsers } = require('../lib/auth/user-store');
const { clearSessionKey } = require('../lib/auth/session-keys');
const analytics = require('../lib/db/analytics');
const dbHealth = require('../lib/db/health');
const dbSessions = require('../lib/db/sessions');

// Parse JSON bodies for admin routes
router.use(express.json());

// All admin routes require authentication and admin privileges
router.use(requireAuth);
router.use(requireAdmin);

const ADMIN_CONTENT_DIR = path.join(__dirname, '../content/admin');
const CONTENT_DIR = path.join(__dirname, '../content');

// StateManager will be injected via setStateManager()
let stateManager = null;

// Icons loaded from shared icons.json
let icons = {};

/**
 * Load icons from shared icons.json
 * Called once at startup
 */
async function loadIcons() {
  try {
    const iconsPath = path.join(CONTENT_DIR, 'icons.json');
    const content = await fs.readFile(iconsPath, 'utf8');
    icons = JSON.parse(content);
    log.info('Loaded admin icons', { count: Object.keys(icons).length });
  } catch (err) {
    log.warn('Failed to load admin icons:', err.message);
    icons = {};
  }
}

// Load icons on module load
loadIcons();

/**
 * Process icon expressions in content
 * Supports: {{icon:rocket}} or {{icon:rocket:24}}
 *
 * @param {string} content - Markdown content with icon expressions
 * @returns {string} Processed content
 */
function processIcons(content) {
  if (!content) return content;

  return content.replace(/\{\{(.+?)\}\}/g, (match, expr) => {
    const trimmed = expr.trim();

    // Check for icon syntax: {{icon:name}} or {{icon:name:size}}
    const iconMatch = trimmed.match(/^icon:([\w-]+)(?::(\d+))?$/);
    if (iconMatch) {
      const [, iconName, sizeStr] = iconMatch;
      const size = sizeStr || '20';
      const svg = icons[iconName];
      if (svg) {
        return svg.replace(/SIZE/g, size);
      }
      return `[icon:${iconName}]`; // Fallback for unknown icons
    }

    return match; // Return unchanged if not an icon expression
  });
}

/**
 * Set the state manager for accessing cluster health data
 * @param {StateManager} sm - State manager instance
 */
function setStateManager(sm) {
  stateManager = sm;
}

/**
 * Load the admin content index
 * @returns {Promise<Object>} Parsed index.json
 */
async function loadAdminIndex() {
  const indexPath = path.join(ADMIN_CONTENT_DIR, 'index.json');
  const content = await fs.readFile(indexPath, 'utf8');
  return JSON.parse(content);
}

/**
 * Load a markdown admin section
 * @param {string} sectionId - Section ID
 * @returns {Promise<string>} Markdown content
 */
async function loadAdminSection(sectionId) {
  const sanitized = sectionId.replace(/[^a-z0-9-]/gi, '');
  const filePath = path.join(ADMIN_CONTENT_DIR, `${sanitized}.md`);
  return fs.readFile(filePath, 'utf8');
}

/**
 * Search admin content
 * @param {string} query - Search query
 * @returns {Promise<Array>} Search results
 */
async function searchAdminContent(query) {
  const index = await loadAdminIndex();
  const results = [];
  const queryLower = query.toLowerCase();

  for (const section of index.sections) {
    try {
      const content = await loadAdminSection(section.id);
      const contentLower = content.toLowerCase();
      let searchIndex = 0;

      while (searchIndex !== -1) {
        searchIndex = contentLower.indexOf(queryLower, searchIndex);
        if (searchIndex !== -1) {
          const start = Math.max(0, searchIndex - 50);
          const end = Math.min(content.length, searchIndex + query.length + 100);
          let snippet = content.slice(start, end);

          if (start > 0) snippet = '...' + snippet;
          if (end < content.length) snippet = snippet + '...';

          results.push({
            sectionId: section.id,
            sectionTitle: section.title,
            snippet: snippet.trim(),
          });

          searchIndex += query.length;
          if (results.filter(r => r.sectionId === section.id).length >= 3) {
            break;
          }
        }
      }
    } catch (err) {
      log.warn(`Failed to search admin section ${section.id}:`, err.message);
    }
  }

  return results;
}

// =============================================================================
// Content Routes
// =============================================================================

/**
 * GET /api/admin
 * Returns the admin content index
 */
router.get('/', async (req, res) => {
  try {
    const index = await loadAdminIndex();
    res.json(index);
  } catch (err) {
    log.error('Failed to load admin index:', err);
    res.status(500).json({ error: 'Failed to load admin index' });
  }
});

/**
 * GET /api/admin/search
 * Search admin content
 */
router.get('/search', async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  try {
    const results = await searchAdminContent(q);
    res.json({ query: q, results });
  } catch (err) {
    log.error('Admin search failed:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/admin/index
 * Returns the admin content index (same as /)
 */
router.get('/index', async (req, res) => {
  try {
    const index = await loadAdminIndex();
    res.json(index);
  } catch (err) {
    log.error('Failed to load admin index:', err);
    res.status(500).json({ error: 'Failed to load admin index' });
  }
});

/**
 * GET /api/admin/content/:section
 * Returns markdown content for an admin section
 */
router.get('/content/:section', async (req, res) => {
  const { section } = req.params;

  try {
    const index = await loadAdminIndex();
    const sectionInfo = index.sections.find(s => s.id === section);

    if (!sectionInfo) {
      return res.status(404).json({ error: `Admin section '${section}' not found` });
    }

    let content = await loadAdminSection(section);
    // Process icon expressions in content
    content = processIcons(content);

    res.json({
      id: sectionInfo.id,
      title: sectionInfo.title,
      icon: sectionInfo.icon,
      content,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: `Admin section '${section}' not found` });
    }
    log.error(`Failed to load admin section ${section}:`, err);
    res.status(500).json({ error: 'Failed to load admin section' });
  }
});

// =============================================================================
// User Management Routes
// =============================================================================

/**
 * GET /api/admin/users
 * List all users
 */
router.get('/users', (req, res) => {
  const users = getAllUsers();
  const userList = [];

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
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  res.json({ users: userList, total: userList.length });
});

/**
 * GET /api/admin/users/:username
 * Get a single user's details
 */
router.get('/users/:username', (req, res) => {
  const { username } = req.params;
  const user = getUser(username);

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
});

/**
 * PUT /api/admin/users/:username
 * Update user fields (fullName, etc.)
 */
router.put('/users/:username', (req, res) => {
  const { username } = req.params;
  const { fullName } = req.body;

  const user = getUser(username);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Only allow updating specific fields
  if (fullName !== undefined) {
    user.fullName = fullName;
  }

  setUser(username, user);
  saveUsers();

  log.info('Admin updated user', { admin: req.user.username, targetUser: username });

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
});

/**
 * DELETE /api/admin/users/:username
 * Delete a user entirely
 */
router.delete('/users/:username', (req, res) => {
  const { username } = req.params;

  // Prevent admin from deleting themselves
  if (username === req.user.username) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const users = getAllUsers();
  if (!users.has(username)) {
    return res.status(404).json({ error: 'User not found' });
  }

  users.delete(username);
  saveUsers();

  // Clear any active session key
  clearSessionKey(username);

  log.info('Admin deleted user', { admin: req.user.username, deletedUser: username });

  res.json({ success: true });
});

/**
 * DELETE /api/admin/users/:username/key
 * Delete a user's SSH key (forces re-setup)
 */
router.delete('/users/:username/key', (req, res) => {
  const { username } = req.params;

  const user = getUser(username);
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

  setUser(username, user);
  saveUsers();

  // Clear session key
  clearSessionKey(username);

  log.info('Admin deleted user key', { admin: req.user.username, targetUser: username });

  res.json({ success: true });
});

/**
 * POST /api/admin/users/bulk
 * Bulk operations on users
 * Body: { action: 'delete-keys' | 'delete', usernames: string[] }
 */
router.post('/users/bulk', (req, res) => {
  const { action, usernames } = req.body;

  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res.status(400).json({ error: 'usernames array required' });
  }

  // Filter out admin's own username from bulk deletes
  const filteredUsernames = usernames.filter(u => u !== req.user.username);

  const results = { success: [], failed: [] };
  const users = getAllUsers();

  for (const username of filteredUsernames) {
    const user = getUser(username);
    if (!user) {
      results.failed.push({ username, error: 'Not found' });
      continue;
    }

    try {
      if (action === 'delete-keys') {
        user.publicKey = null;
        user.privateKey = null;
        user.setupComplete = false;
        setUser(username, user);
        clearSessionKey(username);
        results.success.push(username);
      } else if (action === 'delete') {
        users.delete(username);
        clearSessionKey(username);
        results.success.push(username);
      } else {
        results.failed.push({ username, error: 'Unknown action' });
      }
    } catch (err) {
      results.failed.push({ username, error: err.message });
    }
  }

  saveUsers();

  log.info('Admin bulk operation', {
    admin: req.user.username,
    action,
    successCount: results.success.length,
    failedCount: results.failed.length,
  });

  res.json(results);
});

// =============================================================================
// Reports Routes
// =============================================================================

/**
 * GET /api/admin/reports/usage
 * Get usage statistics
 */
router.get('/reports/usage', (req, res) => {
  const users = getAllUsers();

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
  let sessionStats = null;
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
});

/**
 * GET /api/admin/reports/clusters
 * Get cluster health summary
 */
router.get('/reports/clusters', (req, res) => {
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
});

// =============================================================================
// Analytics Routes
// =============================================================================

/**
 * GET /api/admin/analytics/releases
 * Bioconductor version popularity
 */
router.get('/analytics/releases', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getReleaseUsage(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics releases failed:', err);
    res.status(500).json({ error: 'Failed to fetch release analytics' });
  }
});

/**
 * GET /api/admin/analytics/resources
 * Resource request patterns (CPU, memory, time)
 */
router.get('/analytics/resources', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getResourcePatterns(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics resources failed:', err);
    res.status(500).json({ error: 'Failed to fetch resource analytics' });
  }
});

/**
 * GET /api/admin/analytics/ides
 * IDE popularity
 */
router.get('/analytics/ides', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getIdePopularity(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics IDEs failed:', err);
    res.status(500).json({ error: 'Failed to fetch IDE analytics' });
  }
});

/**
 * GET /api/admin/analytics/features
 * Shiny/Live Server usage rates
 */
router.get('/analytics/features', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getFeatureUsage(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics features failed:', err);
    res.status(500).json({ error: 'Failed to fetch feature analytics' });
  }
});

/**
 * GET /api/admin/analytics/users/:username
 * Per-user usage summary
 */
router.get('/analytics/users/:username', (req, res) => {
  try {
    const { username } = req.params;
    const days = parseInt(req.query.days || '90', 10);
    const data = analytics.getUserUsageSummary(username, days);
    res.json({ data, username, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics user failed:', err);
    res.status(500).json({ error: 'Failed to fetch user analytics' });
  }
});

/**
 * GET /api/admin/analytics/power-users
 * Users with large/long job patterns (training candidates)
 */
router.get('/analytics/power-users', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getPowerUsers(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics power-users failed:', err);
    res.status(500).json({ error: 'Failed to fetch power user analytics' });
  }
});

/**
 * GET /api/admin/analytics/inactive
 * Users with no activity in 90+ days (cleanup candidates)
 */
router.get('/analytics/inactive', (req, res) => {
  try {
    const days = parseInt(req.query.days || '90', 10);
    const data = analytics.getInactiveUsers(days);
    res.json({ data, inactiveDays: days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics inactive failed:', err);
    res.status(500).json({ error: 'Failed to fetch inactive user analytics' });
  }
});

/**
 * GET /api/admin/analytics/new-users
 * New user success rate
 */
router.get('/analytics/new-users', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getNewUserSuccessRate(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics new-users failed:', err);
    res.status(500).json({ error: 'Failed to fetch new user analytics' });
  }
});

/**
 * GET /api/admin/analytics/capacity
 * Peak concurrent sessions, resource saturation, growth rate
 */
router.get('/analytics/capacity', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getCapacityMetrics(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics capacity failed:', err);
    res.status(500).json({ error: 'Failed to fetch capacity analytics' });
  }
});

/**
 * GET /api/admin/analytics/queue
 * Queue wait time stats
 */
router.get('/analytics/queue', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getQueueWaitTimesByCluster(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics queue failed:', err);
    res.status(500).json({ error: 'Failed to fetch queue analytics' });
  }
});

/**
 * GET /api/admin/analytics/heatmap/sessions
 * Daily session counts for GitHub-style heatmap
 */
router.get('/analytics/heatmap/sessions', (req, res) => {
  try {
    const days = parseInt(req.query.days || '365', 10);
    const data = analytics.getDailySessionCounts(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics heatmap/sessions failed:', err);
    res.status(500).json({ error: 'Failed to fetch session heatmap data' });
  }
});

/**
 * GET /api/admin/analytics/heatmap/cluster/:hpc
 * Daily cluster utilization for heatmap
 */
router.get('/analytics/heatmap/cluster/:hpc', (req, res) => {
  try {
    const { hpc } = req.params;
    const days = parseInt(req.query.days || '365', 10);
    const data = dbHealth.getDailyHealthAggregates(hpc, days);
    res.json({ data, hpc, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics heatmap/cluster failed:', err);
    res.status(500).json({ error: 'Failed to fetch cluster heatmap data' });
  }
});

/**
 * GET /api/admin/analytics/adoption/:version
 * Cumulative user adoption curve for a release
 */
router.get('/analytics/adoption/:version', (req, res) => {
  try {
    const { version } = req.params;
    const data = analytics.getReleaseAdoption(version);
    res.json({ data, version, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics adoption failed:', err);
    res.status(500).json({ error: 'Failed to fetch adoption data' });
  }
});

/**
 * GET /api/admin/analytics/growth
 * Month-over-month session/user growth
 */
router.get('/analytics/growth', (req, res) => {
  try {
    const months = parseInt(req.query.months || '12', 10);
    const data = analytics.getGrowthTrends(months);
    res.json({ data, months, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics growth failed:', err);
    res.status(500).json({ error: 'Failed to fetch growth data' });
  }
});

/**
 * GET /api/admin/analytics/by-account
 * Usage breakdown by Slurm account/PI
 */
router.get('/analytics/by-account', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.getUsageByAccount(days);
    res.json({ data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    log.error('Analytics by-account failed:', err);
    res.status(500).json({ error: 'Failed to fetch account usage data' });
  }
});

/**
 * GET /api/admin/analytics/export/raw
 * CSV download: one row per session
 */
router.get('/analytics/export/raw', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.exportRawSessions(days);

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
  } catch (err) {
    log.error('Analytics export/raw failed:', err);
    res.status(500).json({ error: 'Failed to export raw sessions' });
  }
});

/**
 * GET /api/admin/analytics/export/summary
 * CSV download: aggregated by user/account/IDE
 */
router.get('/analytics/export/summary', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const data = analytics.exportSummary(days);

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
  } catch (err) {
    log.error('Analytics export/summary failed:', err);
    res.status(500).json({ error: 'Failed to export summary' });
  }
});

/**
 * GET /api/admin/analytics/sessions
 * Get session history (paginated)
 */
router.get('/analytics/sessions', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const limit = parseInt(req.query.limit || '100', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const { user, hpc, ide } = req.query;

    const data = dbSessions.getSessionHistory({ days, user, hpc, ide, limit, offset });
    const total = dbSessions.getSessionHistoryCount({ days, user });

    res.json({
      data,
      pagination: { limit, offset, total },
      filters: { days, user, hpc, ide },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error('Analytics sessions failed:', err);
    res.status(500).json({ error: 'Failed to fetch session history' });
  }
});

module.exports = router;
module.exports.setStateManager = setStateManager;
