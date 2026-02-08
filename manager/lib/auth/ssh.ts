/**
 * SSH Key Generation and Encryption
 * Ed25519 keypair generation with AES-256-GCM encryption at rest
 *
 * Two encryption modes are supported:
 * - v2 (password-derived): User's password → scrypt → AES key
 *   Used for regular user keys. Decryption requires the user's password.
 * - v3 (server-derived): JWT_SECRET → scrypt → AES key
 *   Used for imported keys and admin keys. Decryption uses server's JWT secret.
 *
 * The decryptPrivateKey function auto-detects the format and handles both.
 */

import crypto from 'crypto';
import { promisify } from 'util';
import sshpk from 'sshpk';
import { log } from '../logger';

const generateKeyPairAsync = promisify(crypto.generateKeyPair);
const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options?: crypto.ScryptOptions
) => Promise<Buffer>;

// Server key derivation (from JWT_SECRET)
// Uses a fixed salt so the same key is derived each time
// v3 format: enc:v3:<iv>:<authTag>:<ciphertext> (no password needed)
// Used for imported keys and admin keys that need to be decrypted without user password
const SERVER_KEY_SALT = 'rbiocverse-ssh-key-v3';
let cachedServerKey: Buffer | null = null;

interface SshKeypair {
  publicKey: string;
  privateKeyPem: string;
}

/**
 * Generate SSH keypair for user (async to avoid blocking event loop)
 * Returns Promise<{ publicKey, privateKeyPem }>
 *
 * The managed key workflow:
 * 1. User logs in, SSH test fails with shared key
 * 2. System generates Ed25519 keypair, stores both public and private keys
 * 3. User copies PUBLIC key to ~/.ssh/authorized_keys on HPC clusters
 * 4. User marks setup complete
 * 5. HpcService uses stored PRIVATE key for SSH connections on behalf of user
 *
 * Private keys are encrypted (AES-256-GCM) with server-derived keys (v3 format).
 * This allows keys to be decrypted without user password, preventing key loss
 * when user's password changes (e.g., LDAP reset).
 */
async function generateSshKeypair(username: string): Promise<SshKeypair> {
  // Use Ed25519 - modern, fast, secure, short keys
  const { privateKey } = await generateKeyPairAsync('ed25519', {
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // Use sshpk to convert to OpenSSH format with our comment
  const key = sshpk.parsePrivateKey(privateKey, 'pem');
  const pubKey = key.toPublic();
  pubKey.comment = `rbiocverse-${username}`;
  const openSshKey = pubKey.toString('ssh');

  return {
    publicKey: openSshKey,
    privateKeyPem: privateKey,
  };
}

/**
 * Derive encryption key from password using scrypt
 * @param password - User's password
 * @param salt - 32-byte random salt
 * @returns 32-byte key suitable for AES-256-GCM
 */
async function deriveKeyFromPassword(password: string, salt: Buffer): Promise<Buffer> {
  // scrypt parameters: N=16384, r=8, p=1
  // Provides good security while keeping login <100ms
  return scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

/**
 * Derive server encryption key from JWT_SECRET
 * Key is cached after first derivation for performance
 * @returns 32-byte key suitable for AES-256-GCM
 */
async function deriveServerKey(): Promise<Buffer> {
  if (cachedServerKey) {
    return cachedServerKey;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET required for server-side key encryption');
  }

  // Use scrypt with same parameters as password derivation
  cachedServerKey = await scryptAsync(jwtSecret, SERVER_KEY_SALT, 32, { N: 16384, r: 8, p: 1 });
  return cachedServerKey;
}

/**
 * Encrypt plaintext with server-derived key (v3 format)
 * @param plaintext - Data to encrypt
 * @returns Encrypted string in format "enc:v3:<iv>:<authTag>:<ciphertext>"
 */
async function encryptWithServerKey(plaintext: string | null): Promise<string | null> {
  if (!plaintext) return null;

  const key = await deriveServerKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // v3 format: no salt needed (derived from JWT_SECRET with fixed salt)
  return `enc:v3:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt ciphertext encrypted with server-derived key (v3 format)
 * Caller must validate format before calling (decryptPrivateKey does this)
 * @param encrypted - Encrypted string in v3 format "enc:v3:<iv>:<authTag>:<ciphertext>"
 * @returns Decrypted plaintext or null on failure
 */
async function decryptWithServerKey(encrypted: string | null): Promise<string | null> {
  if (!encrypted) return null;

  const [, , ivHex, authTagHex, ciphertext] = encrypted.split(':');

  try {
    const key = await deriveServerKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    log.error('Failed to decrypt with server key (v3)', { error: (err as Error).message });
    return null;
  }
}

/**
 * Encrypt a private key using password-derived AES-256-GCM
 * @param plaintext - PEM-encoded private key
 * @param password - User's password for key derivation
 * @returns Encrypted string in format "enc:v2:<salt>:<iv>:<authTag>:<ciphertext>"
 */
async function encryptPrivateKey(plaintext: string | null, password: string | null): Promise<string | null> {
  if (!plaintext || !password) return null;

  const salt = crypto.randomBytes(32);
  const key = await deriveKeyFromPassword(password, salt);
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // v2 format includes salt for password-derived encryption
  return `enc:v2:${salt.toString('hex')}:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a private key encrypted with password-derived or server-derived AES-256-GCM
 * @param encrypted - Encrypted string (v2/v3 format or plaintext PEM for migration)
 * @param password - User's password for key derivation (only needed for v2 format)
 * @returns PEM-encoded private key or null on failure
 */
async function decryptPrivateKey(encrypted: string | null, password: string | null): Promise<string | null> {
  if (!encrypted) return null;

  // Check if already plaintext (for backwards compatibility during migration)
  if (encrypted.startsWith('-----BEGIN')) {
    return encrypted;
  }

  const parts = encrypted.split(':');

  // v3 format: "enc:v3:<iv>:<authTag>:<ciphertext>" (server-derived key)
  if (parts.length === 5 && parts[0] === 'enc' && parts[1] === 'v3') {
    return decryptWithServerKey(encrypted);
  }

  // v2 format: "enc:v2:<salt>:<iv>:<authTag>:<ciphertext>" (password-derived)
  if (parts.length === 6 && parts[0] === 'enc' && parts[1] === 'v2') {
    if (!password) {
      log.error('Password required to decrypt v2 encrypted key');
      return null;
    }

    const [, , saltHex, ivHex, authTagHex, ciphertext] = parts;

    try {
      const salt = Buffer.from(saltHex, 'hex');
      const key = await deriveKeyFromPassword(password, salt);
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err) {
      log.error('Failed to decrypt private key (v2)', { error: (err as Error).message });
      return null;
    }
  }

  log.error('Invalid encrypted key format');
  return null;
}

/**
 * Parse and validate an imported private key PEM
 * Supports Ed25519, RSA, and ECDSA keys
 * @param privateKeyPem - PEM-encoded private key
 * @returns Object with key type and parsed key, or null if invalid
 */
function parsePrivateKeyPem(privateKeyPem: string): { type: string; key: sshpk.PrivateKey } | null {
  try {
    // Normalize line endings and trim whitespace
    const normalized = privateKeyPem.trim().replace(/\r\n/g, '\n');

    // Try to parse with sshpk (handles OpenSSH, PEM, PKCS8 formats)
    const key = sshpk.parsePrivateKey(normalized, 'auto');
    const keyType = key.type;

    // Supported key types
    const supportedTypes = ['ed25519', 'rsa', 'ecdsa'];
    if (!supportedTypes.includes(keyType)) {
      log.error('Unsupported key type', { keyType });
      return null;
    }

    return { type: keyType, key };
  } catch (err) {
    log.error('Failed to parse private key', { error: (err as Error).message });
    return null;
  }
}

/**
 * Extract public key in OpenSSH format from a private key
 * Uses sshpk library for robust key format handling
 * @param privateKeyPem - PEM-encoded private key
 * @param username - Username for key comment
 * @returns OpenSSH formatted public key or null if extraction fails
 */
function extractPublicKeyFromPrivate(privateKeyPem: string, username: string): string | null {
  try {
    const parsed = parsePrivateKeyPem(privateKeyPem);
    if (!parsed) return null;

    // Get public key and set our comment (replaces any existing comment)
    const pubKey = parsed.key.toPublic();
    pubKey.comment = `rbiocverse-${username}`;
    return pubKey.toString('ssh');
  } catch (err) {
    log.error('Failed to extract public key', { error: (err as Error).message });
    return null;
  }
}

/**
 * Normalize a private key PEM to PKCS8 format
 * Accepts OpenSSH, PKCS1, or PKCS8 formats
 * @param privateKeyPem - PEM-encoded private key (any format)
 * @returns PKCS8 PEM format or null if invalid
 */
function normalizePrivateKeyPem(privateKeyPem: string): string | null {
  try {
    const parsed = parsePrivateKeyPem(privateKeyPem);
    if (!parsed) return null;

    // Export as PKCS8 PEM (standard format)
    return parsed.key.toString('pkcs8');
  } catch (err) {
    log.error('Failed to normalize private key', { error: (err as Error).message });
    return null;
  }
}

export {
  generateSshKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveKeyFromPassword,
  encryptWithServerKey,
  decryptWithServerKey,
  parsePrivateKeyPem,
  extractPublicKeyFromPrivate,
  normalizePrivateKeyPem,
  SshKeypair,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  generateSshKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveKeyFromPassword,
  encryptWithServerKey,
  decryptWithServerKey,
  parsePrivateKeyPem,
  extractPublicKeyFromPrivate,
  normalizePrivateKeyPem,
};
