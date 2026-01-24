/**
 * SSH Key Generation and Encryption
 * Ed25519 keypair generation with password-derived AES-256-GCM encryption at rest
 */

import crypto from 'crypto';
import { promisify } from 'util';
import { log } from '../logger';

const generateKeyPairAsync = promisify(crypto.generateKeyPair);
const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options?: crypto.ScryptOptions
) => Promise<Buffer>;

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
 * Private keys are encrypted (AES-256-GCM) with password-derived keys.
 * Only the user's password can decrypt their private key.
 */
async function generateSshKeypair(username: string): Promise<SshKeypair> {
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
 * Decrypt a private key encrypted with password-derived AES-256-GCM
 * @param encrypted - Encrypted string (v2 format or plaintext PEM for migration)
 * @param password - User's password for key derivation
 * @returns PEM-encoded private key or null on failure
 */
async function decryptPrivateKey(encrypted: string | null, password: string | null): Promise<string | null> {
  if (!encrypted) return null;

  // Check if already plaintext (for backwards compatibility during migration)
  if (encrypted.startsWith('-----BEGIN')) {
    return encrypted;
  }

  const parts = encrypted.split(':');

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

export {
  generateSshKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveKeyFromPassword,
  SshKeypair,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  generateSshKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveKeyFromPassword,
};
