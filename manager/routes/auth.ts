/**
 * Auth Routes
 * Handles user authentication, session management, and SSH key operations
 *
 * Security model:
 * - Private keys encrypted with AES-256-GCM using scrypt-derived keys
 * - Two encryption formats:
 *   - v2 (password-derived): Regular user keys, requires user password to decrypt
 *   - v3 (server-derived): Imported keys and admin keys, uses JWT_SECRET
 * - Keys only decrypted during active sessions (held in memory)
 * - On logout/expiry, decrypted keys are cleared
 * - Admin keys use v3 format so they can be used for HPC fallback without password
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const router = express.Router();

// Parse JSON bodies for auth routes
router.use(express.json());

import { log } from '../lib/logger';
import { config } from '../config';
import { errorLogger } from '../services/ErrorLogger';

// Import auth modules
import { generateToken, verifyToken, TokenPayload } from '../lib/auth/token';
import {
  generateSshKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
  encryptWithServerKey,
  parsePrivateKeyPem,
  extractPublicKeyFromPrivate,
  normalizePrivateKeyPem,
} from '../lib/auth/ssh';
import * as dbUsers from '../lib/db/users';
import { initializeDb } from '../lib/db';
import { checkAndMigrate } from '../lib/db/migrate';
import { setSessionKey, getSessionKey, clearSessionKey } from '../lib/auth/session-keys';
import { isAdmin, getPrimaryAdmin } from '../lib/auth/admin';

// Helper to safely get string from req.params (Express types it as string | string[] but it's always string for route params)
const param = (req: Request, name: string): string => req.params[name] as string;

// Extend Express Request to include user property
// TokenPayload has { iat, exp, [key]: unknown }, token includes username/fullName at runtime
// Note: username is always present when token is valid (set during login)
// fullName may be undefined for older tokens or system accounts
interface AuthenticatedRequest extends Request {
  user?: TokenPayload & {
    username: string;
    fullName?: string;
  };
}

interface User {
  username: string;
  fullName: string;
  publicKey: string | null;
  privateKey: string | null;
  setupComplete: boolean;
  createdAt: string;
}

interface SshTestResult {
  gemini: boolean;
  apollo: boolean;
  bothSucceeded: boolean;
  geminiError?: string;
  apolloError?: string;
}

// Database-backed user operations (replaced user-store.js)
const getUser = (username: string): User | null => dbUsers.getUser(username) as User | null;
const setUser = (username: string, user: User): void => dbUsers.setUser(username, user);

// Test credentials (for development - will be replaced by LDAP)
// Must be set via environment variables - no defaults for security
const TEST_USERNAME = process.env.TEST_USERNAME;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

/**
 * Verify password against test credentials
 * TODO(#65): Replace with LDAP password verification
 * @param username
 * @param password
 * @returns boolean
 */
function verifyPassword(username: string, password: string): boolean {
  if (!TEST_USERNAME || !TEST_PASSWORD) return false;

  const expectedUserBuffer = Buffer.from(TEST_USERNAME);
  const providedUserBuffer = Buffer.from(username);
  const expectedPassBuffer = Buffer.from(TEST_PASSWORD);
  const providedPassBuffer = Buffer.from(password);

  const usernameValid = expectedUserBuffer.length === providedUserBuffer.length &&
    crypto.timingSafeEqual(expectedUserBuffer, providedUserBuffer);
  const passwordValid = expectedPassBuffer.length === providedPassBuffer.length &&
    crypto.timingSafeEqual(expectedPassBuffer, providedPassBuffer);

  return usernameValid && passwordValid;
}

/**
 * Get user's private key for SSH connections
 * Returns key from in-memory session store (only available during active session)
 * @param username - Username to get key for
 * @returns PEM-encoded private key or null if no active session
 */
function getUserPrivateKey(username: string): string | null {
  return getSessionKey(username);
}

// Cached admin key (loaded once from DB and decrypted)
let cachedAdminKey: { username: string; key: string } | null = null;

/**
 * Get the primary admin's private key for HPC operations
 * Used when a user doesn't have their own key configured
 * The admin key is encrypted with server key (v3 format)
 * @returns PEM-encoded private key or null if no admin key configured
 */
async function getAdminPrivateKey(): Promise<string | null> {
  // Return cached key if available
  if (cachedAdminKey) {
    return cachedAdminKey.key;
  }

  const adminUsername = getPrimaryAdmin();
  if (!adminUsername) {
    log.debug('No primary admin configured');
    return null;
  }

  const adminUser = getUser(adminUsername);
  if (!adminUser || !adminUser.privateKey) {
    log.debug('Primary admin has no enrolled key', { adminUsername });
    return null;
  }

  // Decrypt the admin's key (v3 format uses server key, no password needed)
  const decryptedKey = await decryptPrivateKey(adminUser.privateKey, null);
  if (!decryptedKey) {
    log.error('Failed to decrypt admin key', { adminUsername });
    return null;
  }

  // Cache the decrypted key
  cachedAdminKey = { username: adminUsername, key: decryptedKey };
  log.info('Admin key loaded for HPC operations', { adminUsername });

  return decryptedKey;
}

/**
 * Clear the cached admin key
 * Called when admin re-imports or regenerates their key
 */
function clearAdminKeyCache(): void {
  cachedAdminKey = null;
}

// Initialize database on startup
initializeDb();
checkAndMigrate();

/**
 * Middleware to require authentication
 * Also handles sliding session refresh - if token is >50% expired, issue a new one
 */
function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void | Response {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Cast is safe because we always include username in token during login
  req.user = payload as TokenPayload & { username: string; fullName?: string };

  // Sliding session: refresh token if >50% of lifetime has elapsed
  // This means active users never have to re-login
  // Note: Our tokens use milliseconds (not seconds like standard JWT), see lib/auth/token.ts
  if (payload.iat && payload.exp) {
    const lifetime = payload.exp - payload.iat;
    const elapsed = Date.now() - payload.iat; // Both in milliseconds
    const halfwayPoint = lifetime / 2;

    if (elapsed > halfwayPoint) {
      // Issue new token with fresh expiry
      const expiresIn = config.sessionExpiryDays * 24 * 60 * 60;
      const newToken = generateToken(
        { username: req.user.username, fullName: req.user.fullName },
        expiresIn
      );
      res.setHeader('X-Refreshed-Token', newToken);
      log.debug('Token refreshed for sliding session', { username: req.user.username });
    }
  }

  next();
}

/**
 * Test SSH connection to a cluster (internal helper)
 * Returns { success: boolean, error?: string }
 *
 * Note: HpcService is required inline to avoid circular dependency
 * (hpc.js may import auth middleware). This is a common Node.js pattern.
 *
 * @param cluster - Cluster name ('gemini' or 'apollo')
 * @param username - Optional username for per-user SSH key testing
 */
async function testSshConnection(cluster: string, username: string | null = null): Promise<{ success: boolean; error?: string }> {
  try {
    const HpcService = require('../services/hpc');
    const hpcService = new HpcService(cluster, username);
    await hpcService.sshExec('echo "Connection successful"');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message || 'Connection failed' };
  }
}

/**
 * Test SSH to both clusters
 * Returns { gemini: boolean, apollo: boolean, bothSucceeded: boolean }
 *
 * @param username - Optional username for per-user SSH key testing
 */
async function testBothClusters(username: string | null = null): Promise<SshTestResult> {
  const [geminiResult, apolloResult] = await Promise.all([
    testSshConnection('gemini', username),
    testSshConnection('apollo', username),
  ]);

  return {
    gemini: geminiResult.success,
    apollo: apolloResult.success,
    bothSucceeded: geminiResult.success && apolloResult.success,
    geminiError: geminiResult.error,
    apolloError: apolloResult.error,
  };
}

/**
 * POST /api/auth/login
 * Authenticate user and return token
 * Decrypts private key into session store for SSH access
 */
router.post('/login', async (req: Request, res: Response) => {
  const { username, password, rememberMe = true } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    // Development: Verify against test credentials (env vars)
    // TODO(#65): Replace with LDAP/AD authentication
    if (!TEST_USERNAME || !TEST_PASSWORD) {
      log.error('TEST_USERNAME and TEST_PASSWORD must be set in environment');
      return res.status(500).json({ error: 'Authentication not configured' });
    }

    if (!verifyPassword(username, password)) {
      await errorLogger.logWarning({
        user: username,
        action: 'login',
        error: 'Invalid credentials',
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Get or create user record
    let user = getUser(username);
    let sshTestResult: SshTestResult | null = null;
    const sessionTtl = rememberMe ? config.sessionExpiryDays * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    if (!user) {
      // First login - test SSH to see if existing keys work
      log.info('New user login - testing SSH', { username });
      sshTestResult = await testBothClusters();

      if (sshTestResult.bothSucceeded) {
        // SSH works - no need to generate keys
        user = {
          username,
          fullName: username, // Will be replaced by LDAP lookup
          publicKey: null, // No managed key needed
          privateKey: null,
          setupComplete: true,
          createdAt: new Date().toISOString(),
        };
        log.info('New user with working SSH', { username });
      } else {
        // SSH failed - generate managed key with password-derived encryption
        const { publicKey, privateKeyPem } = await generateSshKeypair(username);
        user = {
          username,
          fullName: username, // Will be replaced by LDAP lookup
          publicKey,
          privateKey: await encryptPrivateKey(privateKeyPem, password),
          setupComplete: false,
          createdAt: new Date().toISOString(),
        };
        // Store decrypted key in session
        setSessionKey(username, privateKeyPem, sessionTtl);
        log.info('New user - generated managed key', { username });
      }

      setUser(username, user);
      // setUser saves immediately to SQLite
    } else {
      // Existing user - decrypt private key if they have one
      if (user.privateKey) {
        const privateKeyPem = await decryptPrivateKey(user.privateKey, password);
        if (privateKeyPem) {
          setSessionKey(username, privateKeyPem, sessionTtl);
          log.info('Decrypted private key into session', { username });
        } else {
          // Decryption failed - password may have changed, need to regenerate
          log.warn('Failed to decrypt private key, user needs to regenerate', { username });
        }
      }
    }

    // Generate token
    const expiresIn = rememberMe ? config.sessionExpiryDays * 24 * 60 * 60 : 24 * 60 * 60;
    const token = generateToken({ username, fullName: user.fullName }, expiresIn);

    log.audit('User login', { username, hasPublicKey: !!user.publicKey });

    res.json({
      token,
      user: {
        username: user.username,
        fullName: user.fullName,
        publicKey: user.publicKey,
        setupComplete: user.setupComplete,
        isAdmin: isAdmin(user.username),
      },
      sshTestResult, // Include for new users so frontend knows SSH status
    });
  } catch (err) {
    await errorLogger.logError({
      user: username,
      action: 'login',
      error: err instanceof Error ? err : String(err),
    });
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/logout
 * Clear session key and invalidate session
 */
router.post('/logout', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  // Clear decrypted key from memory
  clearSessionKey(req.user!.username);
  log.audit('User logout', { username: req.user!.username });
  res.json({ success: true });
});

/**
 * GET /api/auth/session
 * Check session validity and return user info
 */
router.get('/session', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const user = getUser(req.user!.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check if session key is still available
  const hasActiveKey = getSessionKey(req.user!.username) !== null;

  res.json({
    user: {
      username: user.username,
      fullName: user.fullName,
      publicKey: user.publicKey,
      setupComplete: user.setupComplete,
      hasActiveKey, // Frontend can prompt re-login if false
      isAdmin: isAdmin(user.username),
    },
  });
});

/**
 * POST /api/auth/complete-setup
 * Mark user setup as complete
 */
router.post('/complete-setup', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  let user = getUser(req.user!.username);

  // Handle users created before persistence was added (legacy migration)
  if (!user) {
    // Test if user's existing SSH keys work before generating new ones
    const sshTestResult = await testBothClusters(req.user!.username);

    if (sshTestResult.bothSucceeded) {
      // Existing SSH works - no managed key needed
      user = {
        username: req.user!.username,
        fullName: req.user!.fullName || req.user!.username,
        publicKey: null,
        privateKey: null,
        setupComplete: true,
        createdAt: new Date().toISOString(),
      };
      log.info('Legacy user with working SSH', { username: req.user!.username });
    } else {
      // Can't generate key here without password - mark as incomplete
      user = {
        username: req.user!.username,
        fullName: req.user!.fullName || req.user!.username,
        publicKey: null,
        privateKey: null,
        setupComplete: false,
        createdAt: new Date().toISOString(),
      };
      log.info('Legacy user needs to regenerate key', { username: req.user!.username });
    }
    setUser(req.user!.username, user);
    // setUser saves immediately to SQLite
  } else {
    user.setupComplete = true;
    // setUser saves immediately to SQLite
    log.info('User setup completed', { username: user.username });
  }

  // user is guaranteed to be assigned in both branches above
  res.json({
    user: {
      username: user!.username,
      fullName: user!.fullName,
      publicKey: user!.publicKey,
      setupComplete: user!.setupComplete,
    },
  });
});

/**
 * POST /api/auth/test-connection/:cluster
 * Test SSH connection to a single cluster
 */
router.post('/test-connection/:cluster', async (req: Request, res: Response) => {
  const cluster = param(req, 'cluster');

  if (!['gemini', 'apollo'].includes(cluster)) {
    return res.status(400).json({ error: 'Invalid cluster' });
  }

  const result = await testSshConnection(cluster);
  if (result.success) {
    res.json({ success: true, cluster });
  } else {
    log.warn('Connection test failed', { cluster, error: result.error });
    res.json({
      success: false,
      cluster,
      error: result.error,
    });
  }
});

/**
 * POST /api/auth/test-connection-both
 * Test SSH connection to both clusters
 * Optionally accepts Authorization header to test with per-user keys
 */
router.post('/test-connection-both', async (req: Request, res: Response) => {
  // Check for optional authentication to use per-user keys
  let username: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload?.username && typeof payload.username === 'string') {
      username = payload.username;
    }
  }

  const result = await testBothClusters(username);
  res.json(result);
});

/**
 * POST /api/auth/generate-key
 * Generate a managed SSH key for the user
 * Requires password in request body for encryption
 */
router.post('/generate-key', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required to encrypt key' });
  }

  // Verify password before using it for encryption
  if (!verifyPassword(req.user!.username, password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const user = getUser(req.user!.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Generate new keypair
  const { publicKey, privateKeyPem } = await generateSshKeypair(req.user!.username);

  user.publicKey = publicKey;
  user.privateKey = await encryptPrivateKey(privateKeyPem, password);
  user.setupComplete = false; // Need to install the new key
  setUser(req.user!.username, user);

  // Store in session for immediate use
  const sessionTtl = config.sessionExpiryDays * 24 * 60 * 60 * 1000;
  setSessionKey(req.user!.username, privateKeyPem, sessionTtl);

  log.audit('SSH key generated', { username: user.username });

  res.json({
    success: true,
    user: {
      username: user.username,
      fullName: user.fullName,
      publicKey: user.publicKey,
      setupComplete: user.setupComplete,
    },
  });
});

/**
 * POST /api/auth/remove-key
 * Remove the managed SSH key (user will rely on their own SSH setup)
 * Only allowed if SSH test passes (user has working alternative)
 */
router.post('/remove-key', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const user = getUser(req.user!.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  if (!user.publicKey) {
    return res.json({
      success: true,
      message: 'No managed key to remove',
      user: {
        username: user.username,
        fullName: user.fullName,
        publicKey: user.publicKey,
        setupComplete: user.setupComplete,
      },
    });
  }

  // Test SSH to ensure user has working alternative (use their managed key)
  const result = await testBothClusters(req.user!.username);

  if (!result.bothSucceeded) {
    return res.json({
      success: false,
      error: 'Cannot remove managed key: SSH test failed. Ensure you have working SSH keys before removing the managed key.',
      sshTestResult: result,
    });
  }

  // SSH works - safe to remove managed key
  user.publicKey = null;
  user.privateKey = null;
  setUser(req.user!.username, user);

  // Clear from session
  clearSessionKey(req.user!.username);

  log.audit('SSH key removed', { username: user.username });

  res.json({
    success: true,
    user: {
      username: user.username,
      fullName: user.fullName,
      publicKey: user.publicKey,
      setupComplete: user.setupComplete,
    },
  });
});

/**
 * POST /api/auth/regenerate-key
 * Regenerate the managed SSH key
 * Requires password in request body for encryption
 */
router.post('/regenerate-key', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required to encrypt key' });
  }

  // Verify password before using it for encryption
  if (!verifyPassword(req.user!.username, password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const user = getUser(req.user!.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Generate new keypair
  const { publicKey, privateKeyPem } = await generateSshKeypair(req.user!.username);

  user.publicKey = publicKey;
  // Admin keys use server encryption (v3) so they can be used for HPC fallback
  // Regular user keys use password encryption (v2)
  if (isAdmin(user.username)) {
    user.privateKey = await encryptWithServerKey(privateKeyPem);
  } else {
    user.privateKey = await encryptPrivateKey(privateKeyPem, password);
  }
  user.setupComplete = false; // Need to install new key
  setUser(req.user!.username, user);

  // Store in session for immediate use
  const sessionTtl = config.sessionExpiryDays * 24 * 60 * 60 * 1000;
  setSessionKey(req.user!.username, privateKeyPem, sessionTtl);

  // If the updated user is an admin, clear the cached admin key to force a reload
  if (isAdmin(user.username)) {
    clearAdminKeyCache();
    log.info('Admin key cache cleared due to key regeneration', { username: user.username });
  }

  log.audit('SSH key regenerated', { username: user.username });

  res.json({
    success: true,
    user: {
      username: user.username,
      fullName: user.fullName,
      publicKey: user.publicKey,
      setupComplete: user.setupComplete,
    },
  });
});

/**
 * GET /api/auth/public-key
 * Get user's managed public key (if any)
 */
router.get('/public-key', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const user = getUser(req.user!.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({ publicKey: user.publicKey });
});

/**
 * POST /api/auth/import-key
 * Import an existing SSH private key
 * Encrypts with server key (JWT_SECRET derived) instead of password
 * Requires SSH test to pass before accepting the key
 */
router.post('/import-key', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { privateKeyPem } = req.body;

  if (!privateKeyPem) {
    return res.status(400).json({ error: 'Private key PEM required' });
  }

  // Validate the key format
  const parsed = parsePrivateKeyPem(privateKeyPem);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid private key format. Supported: Ed25519, RSA, ECDSA' });
  }

  // Extract public key from private key
  const publicKey = extractPublicKeyFromPrivate(privateKeyPem, req.user!.username);
  if (!publicKey) {
    return res.status(400).json({ error: 'Failed to extract public key from private key' });
  }

  // Normalize the private key to PKCS8 format
  const normalizedPem = normalizePrivateKeyPem(privateKeyPem);
  if (!normalizedPem) {
    return res.status(400).json({ error: 'Failed to normalize private key' });
  }

  // Temporarily store in session to test SSH
  const sessionTtl = config.sessionExpiryDays * 24 * 60 * 60 * 1000;
  setSessionKey(req.user!.username, normalizedPem, sessionTtl);

  // Test SSH connection with the imported key
  const sshTestResult = await testBothClusters(req.user!.username);

  if (!sshTestResult.bothSucceeded) {
    // Clear the temporary key
    clearSessionKey(req.user!.username);
    return res.status(400).json({
      error: 'SSH test failed. Ensure this key is authorized on both HPC clusters.',
      sshTestResult,
    });
  }

  // Get or create user record
  let user = getUser(req.user!.username);
  if (!user) {
    user = {
      username: req.user!.username,
      fullName: req.user!.fullName || req.user!.username,
      publicKey: null,
      privateKey: null,
      setupComplete: false,
      createdAt: new Date().toISOString(),
    };
  }

  // Encrypt with server key (v3 format)
  let encryptedKey: string | null;
  try {
    encryptedKey = await encryptWithServerKey(normalizedPem);
  } catch (err) {
    // Clear the temporary session key on encryption failure
    clearSessionKey(req.user!.username);
    log.error('Failed to encrypt imported key', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to encrypt key for storage' });
  }

  user.publicKey = publicKey;
  user.privateKey = encryptedKey;
  user.setupComplete = true; // Key is already installed on HPC (passed SSH test)
  setUser(req.user!.username, user);

  // If the updated user is an admin, clear the cached admin key to force a reload
  if (isAdmin(user.username)) {
    clearAdminKeyCache();
    log.info('Admin key cache cleared due to key import', { username: user.username });
  }

  log.audit('SSH key imported', { username: user.username, keyType: parsed.type });

  res.json({
    success: true,
    keyType: parsed.type,
    user: {
      username: user.username,
      fullName: user.fullName,
      publicKey: user.publicKey,
      setupComplete: user.setupComplete,
      isAdmin: isAdmin(user.username),
    },
  });
});

export default router;
export { requireAuth, verifyToken, getUserPrivateKey, getAdminPrivateKey, clearAdminKeyCache };

// CommonJS compatibility for existing require() calls
module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.verifyToken = verifyToken;
module.exports.getUserPrivateKey = getUserPrivateKey;
module.exports.getAdminPrivateKey = getAdminPrivateKey;
module.exports.clearAdminKeyCache = clearAdminKeyCache;
