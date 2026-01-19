/**
 * Session Database Operations
 * Handles both active sessions and session history for analytics
 */

const { getDb } = require('../db');
const { log } = require('../logger');

// ============================================
// Active Sessions
// ============================================

/**
 * Build session key from components
 * @param {string} user
 * @param {string} hpc
 * @param {string} ide
 * @returns {string}
 */
function buildSessionKey(user, hpc, ide) {
  return `${user}-${hpc}-${ide}`;
}

/**
 * Parse session key into components
 * @param {string} sessionKey
 * @returns {{user: string, hpc: string, ide: string}|null}
 */
function parseSessionKey(sessionKey) {
  const parts = sessionKey.split('-');
  if (parts.length >= 3) {
    const ide = parts.pop();
    const hpc = parts.pop();
    const user = parts.join('-');
    return { user, hpc, ide };
  }
  return null;
}

/**
 * Convert database row to session object
 * @param {Object} row
 * @returns {Object}
 */
function rowToSession(row) {
  if (!row) return null;
  return {
    user: row.user,
    status: row.status,
    ide: row.ide,
    jobId: row.job_id,
    node: row.node,
    cpus: row.cpus,
    memory: row.memory,
    walltime: row.walltime,
    gpu: row.gpu,
    releaseVersion: row.release_version,
    account: row.account,
    token: row.token,
    submittedAt: row.submitted_at,
    startedAt: row.started_at,
    error: row.error,
    timeLeftSeconds: row.time_left_seconds,
    lastActivity: row.last_activity,
    usedShiny: !!row.used_shiny,
    usedLiveServer: !!row.used_live_server,
    tunnelProcess: null, // Not stored in DB
  };
}

/**
 * Get active session by key
 * @param {string} sessionKey
 * @returns {Object|null}
 */
function getActiveSession(sessionKey) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM active_sessions WHERE session_key = ?').get(sessionKey);
  return rowToSession(row);
}

/**
 * Get active session by user, hpc, ide
 * @param {string} user
 * @param {string} hpc
 * @param {string} ide
 * @returns {Object|null}
 */
function getSession(user, hpc, ide) {
  return getActiveSession(buildSessionKey(user, hpc, ide));
}

/**
 * Create or update an active session
 * @param {string} sessionKey
 * @param {Object} session
 */
function saveActiveSession(sessionKey, session) {
  const db = getDb();
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) {
    throw new Error(`Invalid session key: ${sessionKey}`);
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO active_sessions (
      session_key, user, hpc, ide, status, job_id, node,
      cpus, memory, walltime, gpu, release_version, account,
      token, submitted_at, started_at, error, time_left_seconds,
      last_activity, used_shiny, used_live_server
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionKey,
    session.user || parsed.user,
    parsed.hpc,
    parsed.ide,
    session.status || null,
    session.jobId || null,
    session.node || null,
    session.cpus || null,
    session.memory || null,
    session.walltime || null,
    session.gpu || null,
    session.releaseVersion || null,
    session.account || null,
    session.token || null,
    session.submittedAt || null,
    session.startedAt || null,
    session.error || null,
    session.timeLeftSeconds || null,
    session.lastActivity || null,
    session.usedShiny ? 1 : 0,
    session.usedLiveServer ? 1 : 0
  );
}

/**
 * Delete active session and optionally archive to history
 * @param {string} sessionKey
 * @param {Object} [options]
 * @param {string} [options.endReason] - completed, cancelled, timeout, error
 * @param {string} [options.errorMessage] - Error message if applicable
 * @param {boolean} [options.archive=true] - Whether to archive to history
 * @returns {boolean} True if session was deleted
 */
function deleteActiveSession(sessionKey, options = {}) {
  const db = getDb();
  const { endReason = 'completed', errorMessage = null, archive = true } = options;

  // Get session before deletion for archiving
  const session = getActiveSession(sessionKey);
  if (!session) return false;

  const transaction = db.transaction(() => {
    // Archive to history if requested and session was beyond idle state
    if (archive && session.status && session.status !== 'idle') {
      archiveSession(session, sessionKey, endReason, errorMessage);
    }

    // Delete from active sessions
    db.prepare('DELETE FROM active_sessions WHERE session_key = ?').run(sessionKey);
  });

  transaction();
  return true;
}

/**
 * Get all active sessions
 * @returns {Object} Map of sessionKey -> session
 */
function getAllActiveSessions() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM active_sessions').all();
  const sessions = {};

  for (const row of rows) {
    sessions[row.session_key] = rowToSession(row);
  }

  return sessions;
}

/**
 * Get active sessions for a user
 * @param {string} user
 * @returns {Object} Map of sessionKey -> session
 */
function getActiveSessionsForUser(user) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM active_sessions WHERE user = ?').all(user);
  const sessions = {};

  for (const row of rows) {
    sessions[row.session_key] = rowToSession(row);
  }

  return sessions;
}

/**
 * Update session fields
 * @param {string} sessionKey
 * @param {Object} updates
 */
function updateActiveSession(sessionKey, updates) {
  const session = getActiveSession(sessionKey);
  if (!session) {
    throw new Error(`No session exists: ${sessionKey}`);
  }

  Object.assign(session, updates);
  saveActiveSession(sessionKey, session);
}

/**
 * Mark session as using Shiny
 * @param {string} sessionKey
 */
function markShinyUsed(sessionKey) {
  const db = getDb();
  db.prepare('UPDATE active_sessions SET used_shiny = 1 WHERE session_key = ?').run(sessionKey);
}

/**
 * Mark session as using Live Server
 * @param {string} sessionKey
 */
function markLiveServerUsed(sessionKey) {
  const db = getDb();
  db.prepare('UPDATE active_sessions SET used_live_server = 1 WHERE session_key = ?').run(sessionKey);
}

// ============================================
// Session History (Analytics)
// ============================================

/**
 * Archive a session to history
 * @param {Object} session - Session data
 * @param {string} sessionKey - Session key for parsing user/hpc/ide
 * @param {string} endReason - completed, cancelled, timeout, error
 * @param {string} [errorMessage] - Error message if applicable
 */
function archiveSession(session, sessionKey, endReason, errorMessage = null) {
  const db = getDb();
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) return;

  const endedAt = new Date().toISOString();

  // Calculate wait time (time between submitted and started)
  let waitSeconds = null;
  if (session.submittedAt && session.startedAt) {
    const submitted = new Date(session.submittedAt).getTime();
    const started = new Date(session.startedAt).getTime();
    if (!isNaN(submitted) && !isNaN(started)) {
      waitSeconds = Math.round((started - submitted) / 1000);
    }
  }

  // Calculate duration (time between started and ended)
  let durationMinutes = null;
  if (session.startedAt) {
    const started = new Date(session.startedAt).getTime();
    const ended = new Date(endedAt).getTime();
    if (!isNaN(started) && !isNaN(ended)) {
      durationMinutes = Math.round((ended - started) / 60000);
    }
  }

  const stmt = db.prepare(`
    INSERT INTO session_history (
      user, hpc, ide, account, cpus, memory, walltime, gpu,
      release_version, submitted_at, started_at, ended_at,
      wait_seconds, duration_minutes, end_reason, error_message,
      used_shiny, used_live_server, job_id, node
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    session.user || parsed.user,
    parsed.hpc,
    parsed.ide,
    session.account || null,
    session.cpus || null,
    session.memory || null,
    session.walltime || null,
    session.gpu || null,
    session.releaseVersion || null,
    session.submittedAt || null,
    session.startedAt || null,
    endedAt,
    waitSeconds,
    durationMinutes,
    endReason,
    errorMessage,
    session.usedShiny ? 1 : 0,
    session.usedLiveServer ? 1 : 0,
    session.jobId || null,
    session.node || null
  );

  log.info('Session archived to history', {
    sessionKey,
    endReason,
    durationMinutes,
    waitSeconds,
  });
}

/**
 * Get session history with optional filters
 * @param {Object} [options]
 * @param {number} [options.days=30] - Number of days to look back
 * @param {string} [options.user] - Filter by user
 * @param {string} [options.hpc] - Filter by cluster
 * @param {string} [options.ide] - Filter by IDE
 * @param {number} [options.limit] - Max records to return
 * @param {number} [options.offset] - Offset for pagination
 * @returns {Array<Object>}
 */
function getSessionHistory(options = {}) {
  const db = getDb();
  const { days = 30, user, hpc, ide, limit, offset } = options;

  let sql = 'SELECT * FROM session_history WHERE 1=1';
  const params = [];

  if (days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    sql += ' AND started_at >= ?';
    params.push(cutoff.toISOString());
  }

  if (user) {
    sql += ' AND user = ?';
    params.push(user);
  }

  if (hpc) {
    sql += ' AND hpc = ?';
    params.push(hpc);
  }

  if (ide) {
    sql += ' AND ide = ?';
    params.push(ide);
  }

  sql += ' ORDER BY started_at DESC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
    if (offset) {
      sql += ' OFFSET ?';
      params.push(offset);
    }
  }

  return db.prepare(sql).all(...params);
}

/**
 * Get session history count
 * @param {Object} [options]
 * @param {number} [options.days] - Number of days to look back
 * @param {string} [options.user] - Filter by user
 * @returns {number}
 */
function getSessionHistoryCount(options = {}) {
  const db = getDb();
  const { days, user } = options;

  let sql = 'SELECT COUNT(*) as count FROM session_history WHERE 1=1';
  const params = [];

  if (days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    sql += ' AND started_at >= ?';
    params.push(cutoff.toISOString());
  }

  if (user) {
    sql += ' AND user = ?';
    params.push(user);
  }

  const row = db.prepare(sql).get(...params);
  return row.count;
}

/**
 * Migrate active sessions from state object
 * @param {Object} sessions - Sessions object from state.json
 * @returns {number} Number of sessions migrated
 */
function migrateActiveSessions(sessions) {
  const db = getDb();
  let count = 0;

  const transaction = db.transaction(() => {
    for (const [sessionKey, session] of Object.entries(sessions)) {
      if (!session) continue;

      const parsed = parseSessionKey(sessionKey);
      if (!parsed) continue;

      saveActiveSession(sessionKey, {
        ...session,
        user: session.user || parsed.user,
      });
      count++;
    }
  });

  transaction();
  log.info('Migrated active sessions to database', { count });
  return count;
}

module.exports = {
  // Session key helpers
  buildSessionKey,
  parseSessionKey,

  // Active sessions
  getActiveSession,
  getSession,
  saveActiveSession,
  deleteActiveSession,
  getAllActiveSessions,
  getActiveSessionsForUser,
  updateActiveSession,
  markShinyUsed,
  markLiveServerUsed,

  // Session history
  archiveSession,
  getSessionHistory,
  getSessionHistoryCount,

  // Migration
  migrateActiveSessions,
};
