/**
 * Session Key Store
 * In-memory storage for decrypted private keys during active sessions.
 *
 * Keys are only held in memory while the user is logged in and are NOT persisted.
 * All session keys are lost on server restart, even if the user's JWT is still valid.
 *
 * After a restart, users with valid JWTs but no session key will need to re-login
 * to decrypt their private key. The /api/auth/session endpoint returns hasActiveKey
 * to help the frontend detect this condition.
 *
 * On logout or session expiry, keys are cleared from memory.
 */

import { log } from '../logger';

interface SessionKeyEntry {
  privateKey: string;
  expiresAt: number;
}

// In-memory store: Map<username, { privateKey, expiresAt }>
const sessionKeys: Map<string, SessionKeyEntry> = new Map();

// Default session duration: 14 days (matches JWT expiry)
const DEFAULT_SESSION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Store a decrypted private key for a user session
 * @param username - User's username
 * @param privateKey - Decrypted PEM-encoded private key
 * @param ttlMs - Time to live in milliseconds
 */
function setSessionKey(username: string, privateKey: string, ttlMs: number = DEFAULT_SESSION_MS): void {
  if (!username || !privateKey) return;

  sessionKeys.set(username, {
    privateKey,
    expiresAt: Date.now() + ttlMs,
  });

  log.info('Session key stored', { username });
}

/**
 * Get a user's decrypted private key from the session store
 * @param username - User's username
 * @returns Decrypted private key or null if not found/expired
 */
function getSessionKey(username: string): string | null {
  const session = sessionKeys.get(username);

  if (!session) {
    return null;
  }

  // Check expiry
  if (session.expiresAt < Date.now()) {
    sessionKeys.delete(username);
    log.info('Session key expired', { username });
    return null;
  }

  return session.privateKey;
}

/**
 * Clear a user's session key (on logout)
 * @param username - User's username
 */
function clearSessionKey(username: string): void {
  if (sessionKeys.has(username)) {
    sessionKeys.delete(username);
    log.info('Session key cleared', { username });
  }
}

/**
 * Clear all expired session keys
 * Called periodically to clean up memory
 */
function clearExpiredKeys(): void {
  const now = Date.now();
  let cleared = 0;

  for (const [username, session] of sessionKeys) {
    if (session.expiresAt < now) {
      sessionKeys.delete(username);
      cleared++;
    }
  }

  if (cleared > 0) {
    log.info('Cleared expired session keys', { count: cleared });
  }
}

/**
 * Check if a user has an active session key
 * @param username - User's username
 */
function hasSessionKey(username: string): boolean {
  return getSessionKey(username) !== null;
}

/**
 * Get count of active session keys (for monitoring)
 */
function getActiveSessionCount(): number {
  clearExpiredKeys();
  return sessionKeys.size;
}

// Clean up expired keys every 5 minutes
// .unref() allows process to exit gracefully if this is the only timer
setInterval(clearExpiredKeys, 5 * 60 * 1000).unref();

export {
  setSessionKey,
  getSessionKey,
  clearSessionKey,
  clearExpiredKeys,
  hasSessionKey,
  getActiveSessionCount,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  setSessionKey,
  getSessionKey,
  clearSessionKey,
  clearExpiredKeys,
  hasSessionKey,
  getActiveSessionCount,
};
