/**
 * SSH Key Generation and Encryption
 * Ed25519 keypair generation with AES-256-GCM encryption at rest
 */

const crypto = require('crypto');
const { promisify } = require('util');
const { config } = require('../../config');
const { log } = require('../logger');

const generateKeyPairAsync = promisify(crypto.generateKeyPair);

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
 * Private keys are encrypted (AES-256-GCM) and stored in users.json.
 * Keys are written to data/ssh-keys/ as needed for SSH commands.
 * Users without managed keys fall back to the shared mounted SSH key.
 */
async function generateSshKeypair(username) {
  // Use Ed25519 - modern, fast, secure, short keys
  const { publicKey, privateKey } = await generateKeyPairAsync('ed25519', {
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // Convert to OpenSSH format
  // Ed25519 public key: extract the 32-byte key from SPKI structure
  const spkiDer = Buffer.from(
    publicKey.replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\n/g, ''),
    'base64'
  );
  // SPKI for Ed25519: 12 bytes ASN.1 header + 32 bytes raw public key
  const ED25519_KEY_SIZE = 32;
  const ed25519PubKey = spkiDer.slice(-ED25519_KEY_SIZE);

  // OpenSSH format: "ssh-ed25519" + key blob (length-prefixed "ssh-ed25519" + length-prefixed key)
  const keyType = Buffer.from('ssh-ed25519');
  const keyBlob = Buffer.concat([
    Buffer.from([0, 0, 0, keyType.length]), keyType,
    Buffer.from([0, 0, 0, ed25519PubKey.length]), ed25519PubKey,
  ]);
  const openSshKey = `ssh-ed25519 ${keyBlob.toString('base64')} rbiocverse-${username}`;

  return {
    publicKey: openSshKey,
    privateKeyPem: privateKey,
  };
}

/**
 * Derive encryption key from JWT_SECRET using HKDF-like derivation
 * Returns a 32-byte key suitable for AES-256-GCM
 */
function getEncryptionKey() {
  // Use HMAC-SHA256 to derive a key from JWT_SECRET
  // This provides key separation between JWT signing and encryption
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update('private-key-encryption-v1')
    .digest();
}

/**
 * Encrypt a private key using AES-256-GCM
 * @param {string} plaintext - PEM-encoded private key
 * @returns {string} Encrypted string in format "enc:v1:<iv>:<authTag>:<ciphertext>"
 */
function encryptPrivateKey(plaintext) {
  if (!plaintext) return null;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a private key encrypted with AES-256-GCM
 * @param {string} encrypted - Encrypted string or plaintext PEM (for migration)
 * @returns {string} PEM-encoded private key
 */
function decryptPrivateKey(encrypted) {
  if (!encrypted) return null;

  // Check if already plaintext (for backwards compatibility during migration)
  if (encrypted.startsWith('-----BEGIN')) {
    return encrypted;
  }

  // Parse encrypted format: "enc:v1:<iv>:<authTag>:<ciphertext>"
  const parts = encrypted.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    log.error('Invalid encrypted key format');
    return null;
  }

  const [, , ivHex, authTagHex, ciphertext] = parts;

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    log.error('Failed to decrypt private key', { error: err.message });
    return null;
  }
}

module.exports = {
  generateSshKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
};
