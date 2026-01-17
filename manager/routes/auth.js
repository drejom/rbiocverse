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
const TEST_USERNAME = process.env.TEST_USERNAME || 'domeally';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'biddy41$';

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

  // Verify signature
  const expectedSig = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(payloadStr)
    .digest('base64url');

  if (signature !== expectedSig) return null;

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
 * Generate SSH keypair for user
 * Returns { publicKey, privateKey }
 * Note: In production, private keys should be securely stored server-side
 */
function generateSshKeypair(username) {
  const { generateKeyPairSync } = crypto;

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
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
// Structure: { username: { fullName, publicKey, setupComplete, createdAt } }
let users = new Map();

/**
 * Load users from disk
 */
function loadUsers() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
      users = new Map(Object.entries(data));
      log.info('Loaded user data', { count: users.size });
    }
  } catch (err) {
    log.error('Failed to load user data', { error: err.message });
  }
}

/**
 * Save users to disk
 */
function saveUsers() {
  try {
    const dir = path.dirname(USER_DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = Object.fromEntries(users);
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log.error('Failed to save user data', { error: err.message });
  }
}

// Load users on startup
loadUsers();

/**
 * Hash password with salt
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
    .toString('hex');
  return { hash, salt };
}

/**
 * Verify password
 */
function verifyPassword(password, hash, salt) {
  const result = hashPassword(password, salt);
  return result.hash === hash;
}

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
 * POST /api/auth/login
 * Authenticate user and return token
 */
router.post('/login', async (req, res) => {
  const { username, password, rememberMe = true } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    // Development: Verify against test credentials (env vars)
    // TODO: Replace with LDAP/AD authentication
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

    if (!user) {
      // First login - create user record
      const { publicKey } = generateSshKeypair(username);

      user = {
        username,
        fullName: 'Denis O\'Meally', // Placeholder - will come from LDAP
        publicKey,
        setupComplete: false,
        createdAt: new Date().toISOString(),
      };

      users.set(username, user);
      saveUsers();
      log.info('New user created', { username });
    }

    // Generate token
    const expiresIn = rememberMe ? config.sessionExpiryDays * 24 * 60 * 60 : 24 * 60 * 60;
    const token = generateToken({ username, fullName: user.fullName }, expiresIn);

    log.info('User logged in', { username });

    res.json({
      token,
      user: {
        username: user.username,
        fullName: user.fullName,
        publicKey: user.publicKey,
        setupComplete: user.setupComplete,
      },
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
router.post('/complete-setup', requireAuth, (req, res) => {
  let user = users.get(req.user.username);

  // Handle users created before persistence was added
  if (!user) {
    const { publicKey } = generateSshKeypair(req.user.username);
    user = {
      username: req.user.username,
      fullName: req.user.fullName || req.user.username,
      publicKey,
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
 * Test SSH connection to cluster
 */
router.post('/test-connection/:cluster', async (req, res) => {
  const { cluster } = req.params;

  if (!['gemini', 'apollo'].includes(cluster)) {
    return res.status(400).json({ error: 'Invalid cluster' });
  }

  try {
    // Import HpcService to test SSH connection
    const HpcService = require('../services/hpc');
    const hpcService = new HpcService(cluster);

    // Try a simple SSH command
    await hpcService.sshExec('echo "Connection successful"');

    res.json({ success: true, cluster });
  } catch (err) {
    log.warn('Connection test failed', { cluster, error: err.message });
    res.json({
      success: false,
      cluster,
      error: err.message || 'Connection failed',
    });
  }
});

/**
 * GET /api/auth/public-key
 * Get user's public key
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
