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

// Server key derivation (from JWT_SECRET)
// Uses a fixed salt so the same key is derived each time
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
 * @param encrypted - Encrypted string in v3 format
 * @returns Decrypted plaintext or null on failure
 */
async function decryptWithServerKey(encrypted: string | null): Promise<string | null> {
  if (!encrypted) return null;

  // Only handle v3 format
  const parts = encrypted.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v3') {
    log.error('Invalid v3 encrypted format');
    return null;
  }

  const [, , ivHex, authTagHex, ciphertext] = parts;

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
function parsePrivateKeyPem(privateKeyPem: string): { type: string; keyObject: crypto.KeyObject } | null {
  try {
    // Normalize line endings and trim whitespace
    const normalized = privateKeyPem.trim().replace(/\r\n/g, '\n');

    // Try to create a key object from the PEM
    const keyObject = crypto.createPrivateKey(normalized);
    const keyType = keyObject.asymmetricKeyType;

    if (!keyType) {
      log.error('Could not determine key type');
      return null;
    }

    // Supported key types
    const supportedTypes = ['ed25519', 'rsa', 'ec'];
    if (!supportedTypes.includes(keyType)) {
      log.error('Unsupported key type', { keyType });
      return null;
    }

    return { type: keyType, keyObject };
  } catch (err) {
    log.error('Failed to parse private key', { error: (err as Error).message });
    return null;
  }
}

/**
 * Extract public key in OpenSSH format from a private key
 * @param privateKeyPem - PEM-encoded private key
 * @param username - Username for key comment
 * @returns OpenSSH formatted public key or null if extraction fails
 */
function extractPublicKeyFromPrivate(privateKeyPem: string, username: string): string | null {
  const parsed = parsePrivateKeyPem(privateKeyPem);
  if (!parsed) return null;

  const { type, keyObject } = parsed;

  try {
    // Get the public key from the private key
    const publicKeyObject = crypto.createPublicKey(keyObject);

    if (type === 'ed25519') {
      // Export as SPKI DER and convert to OpenSSH format
      const spkiDer = publicKeyObject.export({ type: 'spki', format: 'der' });
      const ED25519_KEY_SIZE = 32;
      const ed25519PubKey = spkiDer.slice(-ED25519_KEY_SIZE);

      const keyType = Buffer.from('ssh-ed25519');
      const keyBlob = Buffer.concat([
        Buffer.from([0, 0, 0, keyType.length]), keyType,
        Buffer.from([0, 0, 0, ed25519PubKey.length]), ed25519PubKey,
      ]);
      return `ssh-ed25519 ${keyBlob.toString('base64')} rbiocverse-${username}`;
    }

    if (type === 'rsa') {
      // For RSA, use the OpenSSH format
      const spkiPem = publicKeyObject.export({ type: 'spki', format: 'pem' }) as string;
      const spkiDer = Buffer.from(
        spkiPem.replace(/-----BEGIN PUBLIC KEY-----/, '')
          .replace(/-----END PUBLIC KEY-----/, '')
          .replace(/\n/g, ''),
        'base64'
      );

      // Parse SPKI to get modulus (n) and exponent (e) for OpenSSH format
      // RSA SPKI structure: SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { n, e } } }
      // This is complex, so we'll use a simpler approach - export as PKCS1 and convert
      const pkcs1Der = publicKeyObject.export({ type: 'pkcs1', format: 'der' });

      // Parse PKCS1 RSA public key: SEQUENCE { INTEGER (n), INTEGER (e) }
      // Skip the SEQUENCE tag and length
      let offset = 0;
      if (pkcs1Der[offset++] !== 0x30) return null; // SEQUENCE

      // Get SEQUENCE length (may be multi-byte)
      let seqLen = pkcs1Der[offset++];
      if (seqLen & 0x80) {
        const lenBytes = seqLen & 0x7f;
        seqLen = 0;
        for (let i = 0; i < lenBytes; i++) {
          seqLen = (seqLen << 8) | pkcs1Der[offset++];
        }
      }

      // Parse INTEGER (n - modulus)
      if (pkcs1Der[offset++] !== 0x02) return null; // INTEGER
      let nLen = pkcs1Der[offset++];
      if (nLen & 0x80) {
        const lenBytes = nLen & 0x7f;
        nLen = 0;
        for (let i = 0; i < lenBytes; i++) {
          nLen = (nLen << 8) | pkcs1Der[offset++];
        }
      }
      const n = pkcs1Der.slice(offset, offset + nLen);
      offset += nLen;

      // Parse INTEGER (e - exponent)
      if (pkcs1Der[offset++] !== 0x02) return null; // INTEGER
      let eLen = pkcs1Der[offset++];
      if (eLen & 0x80) {
        const lenBytes = eLen & 0x7f;
        eLen = 0;
        for (let i = 0; i < lenBytes; i++) {
          eLen = (eLen << 8) | pkcs1Der[offset++];
        }
      }
      const e = pkcs1Der.slice(offset, offset + eLen);

      // Build OpenSSH format: key_type || e || n (each length-prefixed)
      const keyTypeStr = Buffer.from('ssh-rsa');
      const keyBlob = Buffer.concat([
        Buffer.alloc(4), // Length of key type
        keyTypeStr,
        Buffer.alloc(4), // Length of e
        e,
        Buffer.alloc(4), // Length of n
        n,
      ]);

      // Write lengths
      keyBlob.writeUInt32BE(keyTypeStr.length, 0);
      keyBlob.writeUInt32BE(e.length, 4 + keyTypeStr.length);
      keyBlob.writeUInt32BE(n.length, 8 + keyTypeStr.length + e.length);

      return `ssh-rsa ${keyBlob.toString('base64')} rbiocverse-${username}`;
    }

    if (type === 'ec') {
      // For ECDSA, determine the curve and build OpenSSH format
      const details = keyObject.asymmetricKeyDetails;
      const namedCurve = details?.namedCurve;

      if (!namedCurve) return null;

      // Map OpenSSL curve names to OpenSSH names
      const curveMap: Record<string, string> = {
        'prime256v1': 'nistp256',
        'secp384r1': 'nistp384',
        'secp521r1': 'nistp521',
      };

      const sshCurve = curveMap[namedCurve];
      if (!sshCurve) {
        log.error('Unsupported ECDSA curve', { namedCurve });
        return null;
      }

      // Export public key in uncompressed point format
      const spkiDer = publicKeyObject.export({ type: 'spki', format: 'der' });

      // SPKI structure for EC: SEQUENCE { SEQUENCE { OID, OID }, BIT STRING }
      // The BIT STRING contains the uncompressed point (0x04 || x || y)
      // Find the BIT STRING (tag 0x03)
      let offset = 0;
      while (offset < spkiDer.length && spkiDer[offset] !== 0x03) {
        offset++;
      }
      if (offset >= spkiDer.length) return null;

      offset++; // Skip BIT STRING tag
      let bitStringLen = spkiDer[offset++];
      if (bitStringLen & 0x80) {
        const lenBytes = bitStringLen & 0x7f;
        bitStringLen = 0;
        for (let i = 0; i < lenBytes; i++) {
          bitStringLen = (bitStringLen << 8) | spkiDer[offset++];
        }
      }
      offset++; // Skip unused bits byte (always 0 for EC keys)
      const point = spkiDer.slice(offset);

      // Build OpenSSH format: key_type || curve || point
      const keyTypeStr = Buffer.from(`ecdsa-sha2-${sshCurve}`);
      const curveStr = Buffer.from(sshCurve);

      const keyBlob = Buffer.concat([
        Buffer.alloc(4),
        keyTypeStr,
        Buffer.alloc(4),
        curveStr,
        Buffer.alloc(4),
        point,
      ]);

      keyBlob.writeUInt32BE(keyTypeStr.length, 0);
      keyBlob.writeUInt32BE(curveStr.length, 4 + keyTypeStr.length);
      keyBlob.writeUInt32BE(point.length, 8 + keyTypeStr.length + curveStr.length);

      return `ecdsa-sha2-${sshCurve} ${keyBlob.toString('base64')} rbiocverse-${username}`;
    }

    return null;
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
  const parsed = parsePrivateKeyPem(privateKeyPem);
  if (!parsed) return null;

  try {
    // Export as PKCS8 PEM (standard format)
    return parsed.keyObject.export({ type: 'pkcs8', format: 'pem' }) as string;
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
