/**
 * SSH utility helpers shared by HpcService and TunnelService
 * - Key file management (write private key to disk, return path)
 * - Known hosts file management (write DB-stored keys to /tmp, return path)
 * - SSH argument builders for strict host key checking
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { log } from './logger';
import { getKnownHosts } from './db/settings';

// Directory for SSH key files (inside data volume, persisted across restarts)
const SSH_KEY_DIR = path.join(__dirname, '..', 'data', 'ssh-keys');

// Temporary file for known_hosts (written from DB on each SSH call)
const KNOWN_HOSTS_TMP_PATH = '/tmp/rbiocverse-known-hosts';

// Per-user SSH key support — lazy loaded to avoid circular dependency
// (routes/auth imports services/hpc indirectly; loading here at module init would cause cycles)
type GetUserPrivateKeyFn = (username: string) => string | null;
type GetAdminPrivateKeyFn = () => Promise<string | null>;

let _getUserPrivateKey: GetUserPrivateKeyFn | null = null;
let _getAdminPrivateKey: GetAdminPrivateKeyFn | null = null;

function loadAuthModule(): void {
  if (!_getUserPrivateKey) {
    const auth = require('../routes/auth');
    _getUserPrivateKey = auth.getUserPrivateKey as GetUserPrivateKeyFn;
    _getAdminPrivateKey = auth.getAdminPrivateKey as GetAdminPrivateKeyFn;
  }
}

/**
 * Get or create a key file for a user
 * Keys are stored in data/ssh-keys/<username>.key
 * Returns the absolute path to the key file.
 */
export function getKeyFilePath(username: string, privateKey: string): string {
  // Ensure directory exists
  if (!fs.existsSync(SSH_KEY_DIR)) {
    fs.mkdirSync(SSH_KEY_DIR, { mode: 0o700, recursive: true });
  }

  const keyPath = path.join(SSH_KEY_DIR, `${username}.key`);

  // Write key if it doesn't exist or has changed
  const keyHash = crypto.createHash('sha256').update(privateKey).digest('hex').substring(0, 8);
  const hashPath = path.join(SSH_KEY_DIR, `${username}.hash`);

  let needsWrite = true;
  if (fs.existsSync(hashPath)) {
    try {
      const existingHash = fs.readFileSync(hashPath, 'utf8').trim();
      needsWrite = (existingHash !== keyHash);
    } catch {
      // Ignore read errors, will rewrite
    }
  }

  if (needsWrite) {
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(hashPath, keyHash, { mode: 0o600 });
    log.debug('Wrote SSH key file', { username, keyPath });
  }

  return keyPath;
}

/**
 * Get SSH options for host key verification.
 * Returns strict checking args if known_hosts are enrolled in the DB,
 * otherwise returns ['-o', 'StrictHostKeyChecking=no'] with a warning.
 */
export function getSshHostKeyArgs(): string[] {
  const knownHostsContent = getKnownHosts();

  if (!knownHostsContent) {
    log.warn(
      'SSH known_hosts not enrolled — running without host key verification. ' +
      'Use Admin panel > Scan Host Keys to enroll host keys.'
    );
    return ['-o', 'StrictHostKeyChecking=no'];
  }

  // Write current known_hosts to temp file
  try {
    fs.writeFileSync(KNOWN_HOSTS_TMP_PATH, knownHostsContent, { mode: 0o600 });
  } catch (err) {
    log.warn('Failed to write known_hosts tmp file, falling back to no-check', {
      error: err instanceof Error ? err.message : String(err),
    });
    return ['-o', 'StrictHostKeyChecking=no'];
  }

  return ['-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${KNOWN_HOSTS_TMP_PATH}`];
}

/**
 * Resolve the SSH key path for a user (or admin fallback).
 * Lazy-loads routes/auth to avoid circular dependency.
 *
 * @returns keyPath — absolute path to the private key file (empty string if no key)
 * @throws if no key is configured at all
 */
export async function resolveKeyFile(
  username: string | null
): Promise<{ keyPath: string; effectiveKeyUser: string }> {
  loadAuthModule();

  // Try per-user key first
  if (username && _getUserPrivateKey) {
    const privateKey = _getUserPrivateKey(username);
    if (privateKey) {
      const keyPath = getKeyFilePath(username, privateKey);
      log.debugFor('ssh', 'using per-user key', { username, keyPath });
      return { keyPath, effectiveKeyUser: username };
    }
  }

  // Fall back to admin key
  if (_getAdminPrivateKey) {
    const adminKey = await _getAdminPrivateKey();
    if (adminKey) {
      const keyPath = getKeyFilePath('_admin', adminKey);
      log.debugFor('ssh', 'using admin key fallback', { effectiveKeyUser: '_admin' });
      return { keyPath, effectiveKeyUser: '_admin' };
    }
  }

  // No key available
  throw new Error('No SSH key configured. Please generate or import an SSH key in Key Management.');
}

// CommonJS compatibility
module.exports = { getKeyFilePath, getSshHostKeyArgs, resolveKeyFile };
