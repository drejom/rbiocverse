/**
 * App Settings Database Operations
 * Key/value store backed by the app_state table
 */

import { getDb } from '../db';

/**
 * Get the stored SSH known_hosts content
 * Returns null if not yet enrolled
 */
export function getKnownHosts(): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get('known_hosts') as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Store SSH known_hosts content
 */
export function setKnownHosts(content: string): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run('known_hosts', content);
}

// CommonJS compatibility
module.exports = { getKnownHosts, setKnownHosts };
