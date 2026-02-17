/**
 * Session Database Operations
 * Handles both active sessions and session history for analytics
 */

import { getDb } from '../db';
import { log } from '../logger';

// ============================================
// Types
// ============================================

export interface Session {
  user: string;
  status: string | null;
  ide: string;
  jobId: string | null;
  node: string | null;
  cpus: number | null;
  memory: string | null;
  walltime: string | null;
  gpu: string | null;
  releaseVersion: string | null;
  account: string | null;
  token: string | null;
  submittedAt: string | null;
  startedAt: string | null;
  error: string | null;
  timeLeftSeconds: number | null;
  lastActivity: string | null;
  usedDevServer: boolean;
  tunnelProcess: unknown | null;
}

interface SessionRow {
  session_key: string;
  user: string;
  hpc: string;
  ide: string;
  status: string | null;
  job_id: string | null;
  node: string | null;
  cpus: number | null;
  memory: string | null;
  walltime: string | null;
  gpu: string | null;
  release_version: string | null;
  account: string | null;
  token: string | null;
  submitted_at: string | null;
  started_at: string | null;
  error: string | null;
  time_left_seconds: number | null;
  last_activity: string | null;
  used_dev_server: number;
}

interface ParsedSessionKey {
  user: string;
  hpc: string;
  ide: string;
}

interface DeleteOptions {
  endReason?: string;
  errorMessage?: string | null;
  archive?: boolean;
}

interface GetHistoryOptions {
  days?: number;
  user?: string;
  hpc?: string;
  ide?: string;
  limit?: number;
  offset?: number;
}

// ============================================
// Active Sessions
// ============================================

/**
 * Build session key from components
 */
function buildSessionKey(user: string, hpc: string, ide: string): string {
  return `${user}-${hpc}-${ide}`;
}

/**
 * Parse session key into components
 */
function parseSessionKey(sessionKey: string): ParsedSessionKey | null {
  const parts = sessionKey.split('-');
  if (parts.length >= 3) {
    const ide = parts.pop()!;
    const hpc = parts.pop()!;
    const user = parts.join('-');
    return { user, hpc, ide };
  }
  return null;
}

/**
 * Convert database row to session object
 */
function rowToSession(row: SessionRow | undefined): Session | null {
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
    usedDevServer: !!row.used_dev_server,
    tunnelProcess: null, // Not stored in DB
  };
}

/**
 * Get active session by key
 */
function getActiveSession(sessionKey: string): Session | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM active_sessions WHERE session_key = ?').get(sessionKey) as SessionRow | undefined;
  return rowToSession(row);
}

/**
 * Get active session by user, hpc, ide
 */
function getSession(user: string, hpc: string, ide: string): Session | null {
  return getActiveSession(buildSessionKey(user, hpc, ide));
}

/**
 * Create or update an active session
 */
function saveActiveSession(sessionKey: string, session: Partial<Session>): void {
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
      last_activity, used_dev_server
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    session.usedDevServer ? 1 : 0
  );
}

/**
 * Delete active session and optionally archive to history
 */
function deleteActiveSession(sessionKey: string, options: DeleteOptions = {}): boolean {
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
 */
function getAllActiveSessions(): Record<string, Session> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM active_sessions').all() as SessionRow[];
  const sessions: Record<string, Session> = {};

  for (const row of rows) {
    const session = rowToSession(row);
    if (session) {
      sessions[row.session_key] = session;
    }
  }

  return sessions;
}

/**
 * Get active sessions for a user
 */
function getActiveSessionsForUser(user: string): Record<string, Session> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM active_sessions WHERE user = ?').all(user) as SessionRow[];
  const sessions: Record<string, Session> = {};

  for (const row of rows) {
    const session = rowToSession(row);
    if (session) {
      sessions[row.session_key] = session;
    }
  }

  return sessions;
}

/**
 * Update session fields
 */
function updateActiveSession(sessionKey: string, updates: Partial<Session>): void {
  const session = getActiveSession(sessionKey);
  if (!session) {
    throw new Error(`No session exists: ${sessionKey}`);
  }

  Object.assign(session, updates);
  saveActiveSession(sessionKey, session);
}

/**
 * Mark session as using a dev server (Live Server, Shiny, etc.)
 */
function markDevServerUsed(sessionKey: string): void {
  const db = getDb();
  db.prepare('UPDATE active_sessions SET used_dev_server = 1 WHERE session_key = ?').run(sessionKey);
}

// ============================================
// Session History (Analytics)
// ============================================

/**
 * Archive a session to history
 */
function archiveSession(
  session: Session,
  sessionKey: string,
  endReason: string,
  errorMessage: string | null = null
): void {
  const db = getDb();
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) return;

  const endedAt = new Date().toISOString();

  // Calculate wait time (time between submitted and started)
  let waitSeconds: number | null = null;
  if (session.submittedAt && session.startedAt) {
    const submitted = new Date(session.submittedAt).getTime();
    const started = new Date(session.startedAt).getTime();
    if (!isNaN(submitted) && !isNaN(started)) {
      waitSeconds = Math.round((started - submitted) / 1000);
    }
  }

  // Calculate duration (time between started and ended)
  let durationMinutes: number | null = null;
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
      used_dev_server, job_id, node
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    session.usedDevServer ? 1 : 0,
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
 */
function getSessionHistory(options: GetHistoryOptions = {}): unknown[] {
  const db = getDb();
  const { days = 30, user, hpc, ide, limit, offset } = options;

  let sql = 'SELECT * FROM session_history WHERE 1=1';
  const params: (string | number)[] = [];

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
 */
function getSessionHistoryCount(options: { days?: number; user?: string } = {}): number {
  const db = getDb();
  const { days, user } = options;

  let sql = 'SELECT COUNT(*) as count FROM session_history WHERE 1=1';
  const params: string[] = [];

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

  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

/**
 * Migrate active sessions from state object
 */
function migrateActiveSessions(sessions: Record<string, Partial<Session>>): number {
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

export {
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
  markDevServerUsed,

  // Session history
  archiveSession,
  getSessionHistory,
  getSessionHistoryCount,

  // Migration
  migrateActiveSessions,
};

// CommonJS compatibility for existing require() calls
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
  markDevServerUsed,

  // Session history
  archiveSession,
  getSessionHistory,
  getSessionHistoryCount,

  // Migration
  migrateActiveSessions,
};
