/**
 * Auth Routes
 * Handles user authentication, session management, and SSH key operations
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Parse JSON bodies for auth routes
router.use(express.json());
const { log } = require('../lib/logger');
const { config } = require('../config');
const { errorLogger } = require('../services/ErrorLogger');

// Import auth modules
const { generateToken, verifyToken } = require('../lib/auth/token');
const { generateSshKeypair, encryptPrivateKey, decryptPrivateKey } = require('../lib/auth/ssh');
const { loadUsers, saveUsers, getUser, setUser } = require('../lib/auth/user-store');

// Test credentials (for development - will be replaced by LDAP)
// Must be set via environment variables - no defaults for security
const TEST_USERNAME = process.env.TEST_USERNAME;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

/**
 * Get user's private key for SSH connections
 * Used by HpcService for per-user SSH authentication
 * @param {string} username - Username to get key for
 * @returns {string|null} PEM-encoded private key (decrypted) or null
 */
function getUserPrivateKey(username) {
  const user = getUser(username);
  if (!user?.privateKey) return null;
  return decryptPrivateKey(user.privateKey);
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
 *
 * @param {string} cluster - Cluster name ('gemini' or 'apollo')
 * @param {string} [username] - Optional username for per-user SSH key testing
 */
async function testSshConnection(cluster, username = null) {
  try {
    const HpcService = require('../services/hpc');
    const hpcService = new HpcService(cluster, username);
    await hpcService.sshExec('echo "Connection successful"');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || 'Connection failed' };
  }
}

/**
 * Test SSH to both clusters
 * Returns { gemini: boolean, apollo: boolean, bothSucceeded: boolean }
 *
 * @param {string} [username] - Optional username for per-user SSH key testing
 */
async function testBothClusters(username = null) {
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

    // Use timing-safe comparison to prevent timing attacks
    const expectedUserBuffer = Buffer.from(TEST_USERNAME);
    const providedUserBuffer = Buffer.from(username);
    const expectedPassBuffer = Buffer.from(TEST_PASSWORD);
    const providedPassBuffer = Buffer.from(password);

    const usernameValid = expectedUserBuffer.length === providedUserBuffer.length &&
      crypto.timingSafeEqual(expectedUserBuffer, providedUserBuffer);
    const passwordValid = expectedPassBuffer.length === providedPassBuffer.length &&
      crypto.timingSafeEqual(expectedPassBuffer, providedPassBuffer);

    if (!usernameValid || !passwordValid) {
      await errorLogger.logWarning({
        user: username,
        action: 'login',
        error: 'Invalid credentials',
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Get or create user record
    let user = getUser(username);
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
          privateKey: encryptPrivateKey(privateKeyPem),
          setupComplete: false,
          createdAt: new Date().toISOString(),
        };
        log.info('New user - generated managed key', { username });
      }

      setUser(username, user);
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
  const user = getUser(req.user.username);
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
  let user = getUser(req.user.username);

  // Handle users created before persistence was added (legacy migration)
  if (!user) {
    // Test if user's existing SSH keys work before generating new ones
    const sshTestResult = await testBothClusters(req.user.username);

    if (sshTestResult.bothSucceeded) {
      // Existing SSH works - no managed key needed
      user = {
        username: req.user.username,
        fullName: req.user.fullName || req.user.username,
        publicKey: null,
        privateKey: null,
        setupComplete: true,
        createdAt: new Date().toISOString(),
      };
      log.info('Legacy user with working SSH', { username: req.user.username });
    } else {
      // SSH failed - generate managed key
      const { publicKey, privateKeyPem } = await generateSshKeypair(req.user.username);
      user = {
        username: req.user.username,
        fullName: req.user.fullName || req.user.username,
        publicKey,
        privateKey: encryptPrivateKey(privateKeyPem),
        setupComplete: false,
        createdAt: new Date().toISOString(),
      };
      log.info('Legacy user - generated managed key', { username: req.user.username });
    }
    setUser(req.user.username, user);
    saveUsers();
  } else {
    user.setupComplete = true;
    saveUsers();
    log.info('User setup completed', { username: user.username });
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
 * Optionally accepts Authorization header to test with per-user keys
 */
router.post('/test-connection-both', async (req, res) => {
  // Check for optional authentication to use per-user keys
  let username = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload?.username) {
      username = payload.username;
    }
  }

  const result = await testBothClusters(username);
  res.json(result);
});

/**
 * POST /api/auth/generate-key
 * Generate a managed SSH key for the user
 * Can be used even if user already has working SSH (as a backup)
 */
router.post('/generate-key', requireAuth, async (req, res) => {
  let user = getUser(req.user.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Generate new keypair
  const { publicKey, privateKeyPem } = await generateSshKeypair(req.user.username);

  user.publicKey = publicKey;
  user.privateKey = encryptPrivateKey(privateKeyPem);
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
  const user = getUser(req.user.username);
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
  const result = await testBothClusters(req.user.username);

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
  let user = getUser(req.user.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Generate new keypair
  const { publicKey, privateKeyPem } = await generateSshKeypair(req.user.username);

  user.publicKey = publicKey;
  user.privateKey = encryptPrivateKey(privateKeyPem);
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
  const user = getUser(req.user.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({ publicKey: user.publicKey });
});

module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.verifyToken = verifyToken;
module.exports.getUserPrivateKey = getUserPrivateKey;
