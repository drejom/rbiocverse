/**
 * Auth Routes
 * Handles user authentication, session management, and SSH key operations
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Parse JSON bodies for auth routes
router.use(express.json());
const { log } = require('../lib/logger');
const { config } = require('../config');
const { errorLogger } = require('../services/ErrorLogger');

// Persistent user data file (tracks setupComplete, public keys, etc.)
const USER_DATA_FILE = path.join(__dirname, '..', 'data', 'users.json');

// Test credentials (for development - will be replaced by LDAP)
// Must be set via environment variables - no defaults for security
const TEST_USERNAME = process.env.TEST_USERNAME;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

// Simple JWT-like token handling (no external dependency)
// In production, consider using a proper JWT library

/**
 * Generate a simple token
 * Format: base64(payload).base64(signature)
 */
function generateToken(payload, expiresIn = config.sessionExpiryDays * 24 * 60 * 60) {
  const data = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + expiresIn * 1000,
  };
  const payloadStr = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(payloadStr)
    .digest('base64url');
  return `${payloadStr}.${signature}`;
}

/**
 * Verify and decode a token
 */
function verifyToken(token) {
  if (!token) return null;

  const [payloadStr, signature] = token.split('.');
  if (!payloadStr || !signature) return null;

  // Verify signature using constant-time comparison to prevent timing attacks
  const expectedSig = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(payloadStr)
    .digest('base64url');

  // Use timingSafeEqual for cryptographic comparison
  const expectedSigBuffer = Buffer.from(expectedSig, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');

  if (expectedSigBuffer.length !== signatureBuffer.length ||
      !crypto.timingSafeEqual(expectedSigBuffer, signatureBuffer)) {
    return null;
  }

  // Decode and check expiry
  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) {
      return null; // Expired
    }
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * Generate SSH keypair for user (async to avoid blocking event loop)
 * Returns Promise<{ publicKey, privateKeyPem }>
 *
 * The managed key workflow:
 * 1. User logs in, SSH test fails with shared key
 * 2. System generates RSA keypair, stores both public and private keys
 * 3. User copies PUBLIC key to ~/.ssh/authorized_keys on HPC clusters
 * 4. User marks setup complete
 * 5. HpcService uses stored PRIVATE key for SSH connections on behalf of user
 *
 * Private keys are stored in users.json and written to temp files as needed.
 * Users without managed keys fall back to the shared mounted SSH key.
 */
const { promisify } = require('util');
const generateKeyPairAsync = promisify(crypto.generateKeyPair);

async function generateSshKeypair(username) {
  const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
    },
  });

  // Convert PEM public key to OpenSSH format
  // This is a simplified conversion - in production use ssh-keygen or a proper library
  const pemLines = publicKey.split('\n').filter(l => !l.startsWith('----'));
  const derB64 = pemLines.join('');
  const openSshKey = `ssh-rsa ${derB64} rbiocverse-${username}`;

  return {
    publicKey: openSshKey,
    privateKeyPem: privateKey,
  };
}

// Persistent user store (JSON file)
// Structure: { username: { fullName, publicKey, privateKey, setupComplete, createdAt } }
// publicKey: null (no managed key) or "ssh-rsa ..." (managed key exists)
// privateKey: null (no managed key) or PEM-encoded private key (for SSH connections)
let users = new Map();

/**
 * Get user's private key for SSH connections
 * Used by HpcService for per-user SSH authentication
 * @param {string} username - Username to get key for
 * @returns {string|null} PEM-encoded private key or null
 */
function getUserPrivateKey(username) {
  const user = users.get(username);
  return user?.privateKey || null;
}

/**
 * Load users from disk with migration to remove keyMode
 */
function loadUsers() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));

      // Migrate: remove keyMode field if present (no longer used)
      let needsSave = false;
      for (const [username, user] of Object.entries(data)) {
        if ('keyMode' in user) {
          delete user.keyMode;
          needsSave = true;
          log.info('Migrated user: removed keyMode field', { username });
        }
      }

      users = new Map(Object.entries(data));
      log.info('Loaded user data', { count: users.size });

      // Save migration changes
      if (needsSave) {
        saveUsers();
      }
    }
  } catch (err) {
    log.error('Failed to load user data', { error: err.message });
  }
}

/**
 * Save users to disk atomically
 * Uses temp file + rename to prevent corruption on crash/interrupt
 */
function saveUsers() {
  try {
    const dir = path.dirname(USER_DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = Object.fromEntries(users);
    // Write to temp file first, then atomically rename
    const tempFile = `${USER_DATA_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    fs.renameSync(tempFile, USER_DATA_FILE);
  } catch (err) {
    log.error('Failed to save user data', { error: err.message });
  }
}

// Load users on startup
loadUsers();

/**
 * Middleware to require authentication
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = payload;
  next();
}

/**
 * Test SSH connection to a cluster (internal helper)
 * Returns { success: boolean, error?: string }
 *
 * Note: HpcService is required inline to avoid circular dependency
 * (hpc.js may import auth middleware). This is a common Node.js pattern.
 */
async function testSshConnection(cluster) {
  try {
    const HpcService = require('../services/hpc');
    const hpcService = new HpcService(cluster);
    await hpcService.sshExec('echo "Connection successful"');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || 'Connection failed' };
  }
}

/**
 * Test SSH to both clusters
 * Returns { gemini: boolean, apollo: boolean, bothSucceeded: boolean }
 */
async function testBothClusters() {
  const [geminiResult, apolloResult] = await Promise.all([
    testSshConnection('gemini'),
    testSshConnection('apollo'),
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
 * For new users: tests SSH first, only generates keys if SSH fails
 */
router.post('/login', async (req, res) => {
  const { username, password, rememberMe = true } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    // Development: Verify against test credentials (env vars)
    // TODO: Replace with LDAP/AD authentication
    if (!TEST_USERNAME || !TEST_PASSWORD) {
      log.error('TEST_USERNAME and TEST_PASSWORD must be set in environment');
      return res.status(500).json({ error: 'Authentication not configured' });
    }
    if (username !== TEST_USERNAME || password !== TEST_PASSWORD) {
      await errorLogger.logWarning({
        user: username,
        action: 'login',
        error: 'Invalid credentials',
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Get or create user record
    let user = users.get(username);
    let sshTestResult = null;

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
          setupComplete: true,
          createdAt: new Date().toISOString(),
        };
        log.info('New user with working SSH', { username });
      } else {
        // SSH failed - generate managed key
        const { publicKey, privateKeyPem } = await generateSshKeypair(username);
        user = {
          username,
          fullName: username, // Will be replaced by LDAP lookup
          publicKey,
          privateKey: privateKeyPem,
          setupComplete: false,
          createdAt: new Date().toISOString(),
        };
        log.info('New user - generated managed key', { username });
      }

      users.set(username, user);
      saveUsers();
    }

    // Generate token
    const expiresIn = rememberMe ? config.sessionExpiryDays * 24 * 60 * 60 : 24 * 60 * 60;
    const token = generateToken({ username, fullName: user.fullName }, expiresIn);

    log.info('User logged in', { username, hasPublicKey: !!user.publicKey });

    res.json({
      token,
      user: {
        username: user.username,
        fullName: user.fullName,
        publicKey: user.publicKey,
        setupComplete: user.setupComplete,
      },
      sshTestResult, // Include for new users so frontend knows SSH status
    });
  } catch (err) {
    await errorLogger.logError({
      user: username,
      action: 'login',
      error: err,
    });
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/logout
 * Invalidate session (for audit logging)
 */
router.post('/logout', requireAuth, (req, res) => {
  log.info('User logged out', { username: req.user.username });
  res.json({ success: true });
});

/**
 * GET /api/auth/session
 * Check session validity and return user info
 */
router.get('/session', requireAuth, (req, res) => {
  const user = users.get(req.user.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({
    user: {
      username: user.username,
      fullName: user.fullName,
      publicKey: user.publicKey,
      setupComplete: user.setupComplete,
    },
  });
});

/**
 * POST /api/auth/complete-setup
 * Mark user setup as complete
 */
router.post('/complete-setup', requireAuth, async (req, res) => {
  let user = users.get(req.user.username);

  // Handle users created before persistence was added
  if (!user) {
    const { publicKey, privateKeyPem } = await generateSshKeypair(req.user.username);
    user = {
      username: req.user.username,
      fullName: req.user.fullName || req.user.username,
      publicKey,
      privateKey: privateKeyPem,
      setupComplete: false,
      createdAt: new Date().toISOString(),
    };
    users.set(req.user.username, user);
  }

  user.setupComplete = true;
  saveUsers();
  log.info('User setup completed', { username: user.username });

  res.json({
    user: {
      username: user.username,
      fullName: user.fullName,
      publicKey: user.publicKey,
      setupComplete: user.setupComplete,
    },
  });
});

/**
 * POST /api/auth/test-connection/:cluster
 * Test SSH connection to a single cluster
 */
router.post('/test-connection/:cluster', async (req, res) => {
  const { cluster } = req.params;

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
 */
router.post('/test-connection-both', async (req, res) => {
  const result = await testBothClusters();
  res.json(result);
});

/**
 * POST /api/auth/generate-key
 * Generate a managed SSH key for the user
 * Can be used even if user already has working SSH (as a backup)
 */
router.post('/generate-key', requireAuth, async (req, res) => {
  let user = users.get(req.user.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Generate new keypair
  const { publicKey, privateKeyPem } = await generateSshKeypair(req.user.username);

  user.publicKey = publicKey;
  user.privateKey = privateKeyPem;
  user.setupComplete = false; // Need to install the new key
  saveUsers();

  log.info('Generated managed key for user', { username: user.username });

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
router.post('/remove-key', requireAuth, async (req, res) => {
  const user = users.get(req.user.username);
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

  // Test SSH to ensure user has working alternative
  const result = await testBothClusters();

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
  saveUsers();

  log.info('Removed managed key for user', { username: user.username });

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
 */
router.post('/regenerate-key', requireAuth, async (req, res) => {
  let user = users.get(req.user.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Generate new keypair
  const { publicKey, privateKeyPem } = await generateSshKeypair(req.user.username);

  user.publicKey = publicKey;
  user.privateKey = privateKeyPem;
  user.setupComplete = false; // Need to install new key
  saveUsers();

  log.info('Regenerated managed key for user', { username: user.username });

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
router.get('/public-key', requireAuth, (req, res) => {
  const user = users.get(req.user.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({ publicKey: user.publicKey });
});

module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.verifyToken = verifyToken;
module.exports.getUserPrivateKey = getUserPrivateKey;
