const { expect } = require('chai');
const crypto = require('crypto');

// SSH module functions - loaded in before() hook
let generateSshKeypair;
let encryptPrivateKey;
let decryptPrivateKey;
let encryptWithServerKey;
let decryptWithServerKey;
let parsePrivateKeyPem;
let extractPublicKeyFromPrivate;
let normalizePrivateKeyPem;

// Store original JWT_SECRET to restore after tests
let originalJwtSecret;

describe('SSH Key Functions', () => {
  before(() => {
    // Save original JWT_SECRET and set test value
    originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars-long';

    // Clear ssh module from require cache so it re-reads JWT_SECRET
    const modulePath = require.resolve('../../lib/auth/ssh');
    delete require.cache[modulePath];

    // Load the module with test JWT_SECRET
    ({
      generateSshKeypair,
      encryptPrivateKey,
      decryptPrivateKey,
      encryptWithServerKey,
      decryptWithServerKey,
      parsePrivateKeyPem,
      extractPublicKeyFromPrivate,
      normalizePrivateKeyPem,
    } = require('../../lib/auth/ssh'));
  });

  after(() => {
    // Restore original JWT_SECRET
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }

    // Clear ssh module from cache to avoid leaking state to other tests
    const modulePath = require.resolve('../../lib/auth/ssh');
    delete require.cache[modulePath];
  });
  describe('generateSshKeypair', () => {
    it('should generate Ed25519 keypair', async () => {
      const { publicKey, privateKeyPem } = await generateSshKeypair('testuser');

      expect(publicKey).to.be.a('string');
      expect(privateKeyPem).to.be.a('string');
      expect(publicKey).to.match(/^ssh-ed25519 /);
      expect(publicKey).to.include('rbiocverse-testuser');
      expect(privateKeyPem).to.include('-----BEGIN PRIVATE KEY-----');
    });

    it('should generate unique keypairs', async () => {
      const pair1 = await generateSshKeypair('user1');
      const pair2 = await generateSshKeypair('user2');

      expect(pair1.publicKey).to.not.equal(pair2.publicKey);
      expect(pair1.privateKeyPem).to.not.equal(pair2.privateKeyPem);
    });
  });

  describe('Password-derived encryption (v2)', () => {
    it('should encrypt and decrypt private key', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');
      const password = 'testpassword123';

      const encrypted = await encryptPrivateKey(privateKeyPem, password);
      expect(encrypted).to.match(/^enc:v2:/);

      const decrypted = await decryptPrivateKey(encrypted, password);
      expect(decrypted).to.equal(privateKeyPem);
    });

    it('should fail decryption with wrong password', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');
      const encrypted = await encryptPrivateKey(privateKeyPem, 'correctpassword');

      const decrypted = await decryptPrivateKey(encrypted, 'wrongpassword');
      expect(decrypted).to.be.null;
    });

    it('should return null for null inputs', async () => {
      expect(await encryptPrivateKey(null, 'password')).to.be.null;
      expect(await encryptPrivateKey('key', null)).to.be.null;
      expect(await decryptPrivateKey(null, 'password')).to.be.null;
    });

    it('should handle plaintext PEM for backwards compatibility', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');
      const decrypted = await decryptPrivateKey(privateKeyPem, null);
      expect(decrypted).to.equal(privateKeyPem);
    });
  });

  describe('Server-key encryption (v3)', () => {
    it('should encrypt and decrypt with server key', async () => {
      const plaintext = 'secret data to encrypt';

      const encrypted = await encryptWithServerKey(plaintext);
      expect(encrypted).to.match(/^enc:v3:/);

      const decrypted = await decryptWithServerKey(encrypted);
      expect(decrypted).to.equal(plaintext);
    });

    it('should encrypt private key with server key', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');

      const encrypted = await encryptWithServerKey(privateKeyPem);
      expect(encrypted).to.match(/^enc:v3:/);

      const decrypted = await decryptWithServerKey(encrypted);
      expect(decrypted).to.equal(privateKeyPem);
    });

    it('should return null for null input', async () => {
      expect(await encryptWithServerKey(null)).to.be.null;
      expect(await decryptWithServerKey(null)).to.be.null;
    });

    it('should fail on invalid v3 format', async () => {
      const decrypted = await decryptWithServerKey('enc:v3:invalid');
      expect(decrypted).to.be.null;
    });

    it('should produce different ciphertext for same plaintext (random IV)', async () => {
      const plaintext = 'same text';
      const encrypted1 = await encryptWithServerKey(plaintext);
      const encrypted2 = await encryptWithServerKey(plaintext);

      expect(encrypted1).to.not.equal(encrypted2);
    });
  });

  describe('decryptPrivateKey (unified)', () => {
    it('should decrypt v2 format with password', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');
      const encrypted = await encryptPrivateKey(privateKeyPem, 'password');

      const decrypted = await decryptPrivateKey(encrypted, 'password');
      expect(decrypted).to.equal(privateKeyPem);
    });

    it('should decrypt v3 format without password', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');
      const encrypted = await encryptWithServerKey(privateKeyPem);

      const decrypted = await decryptPrivateKey(encrypted, null);
      expect(decrypted).to.equal(privateKeyPem);
    });

    it('should reject unknown format', async () => {
      const decrypted = await decryptPrivateKey('enc:v99:invalid', null);
      expect(decrypted).to.be.null;
    });
  });

  describe('parsePrivateKeyPem', () => {
    it('should parse Ed25519 key', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');
      const parsed = parsePrivateKeyPem(privateKeyPem);

      expect(parsed).to.not.be.null;
      expect(parsed.type).to.equal('ed25519');
      expect(parsed.key).to.exist;
      expect(parsed.key.type).to.equal('ed25519');
    });

    it('should parse RSA key', () => {
      // Generate RSA key for testing
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });

      const parsed = parsePrivateKeyPem(privateKey);
      expect(parsed).to.not.be.null;
      expect(parsed.type).to.equal('rsa');
    });

    it('should parse ECDSA key', () => {
      const { privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });

      const parsed = parsePrivateKeyPem(privateKey);
      expect(parsed).to.not.be.null;
      // sshpk reports ECDSA as 'ecdsa'
      expect(parsed.type).to.equal('ecdsa');
    });

    it('should return null for invalid PEM', () => {
      expect(parsePrivateKeyPem('not a valid key')).to.be.null;
      expect(parsePrivateKeyPem('')).to.be.null;
    });

    it('should handle whitespace and line endings', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');
      const withWhitespace = '\n  ' + privateKeyPem + '  \n';
      const parsed = parsePrivateKeyPem(withWhitespace);

      expect(parsed).to.not.be.null;
      expect(parsed.type).to.equal('ed25519');
    });
  });

  describe('extractPublicKeyFromPrivate', () => {
    it('should extract Ed25519 public key in OpenSSH format', async () => {
      const { privateKeyPem, publicKey } = await generateSshKeypair('testuser');
      const extracted = extractPublicKeyFromPrivate(privateKeyPem, 'testuser');

      expect(extracted).to.not.be.null;
      expect(extracted).to.match(/^ssh-ed25519 /);
      expect(extracted).to.include('rbiocverse-testuser');
      // The key data should match
      expect(extracted.split(' ')[1]).to.equal(publicKey.split(' ')[1]);
    });

    it('should extract RSA public key in OpenSSH format', () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });

      const extracted = extractPublicKeyFromPrivate(privateKey, 'rsauser');
      expect(extracted).to.not.be.null;
      expect(extracted).to.match(/^ssh-rsa /);
      expect(extracted).to.include('rbiocverse-rsauser');
    });

    it('should extract ECDSA public key in OpenSSH format', () => {
      const { privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });

      const extracted = extractPublicKeyFromPrivate(privateKey, 'ecuser');
      expect(extracted).to.not.be.null;
      expect(extracted).to.match(/^ecdsa-sha2-nistp256 /);
      expect(extracted).to.include('rbiocverse-ecuser');
    });

    it('should return null for invalid key', () => {
      expect(extractPublicKeyFromPrivate('invalid', 'user')).to.be.null;
    });
  });

  describe('normalizePrivateKeyPem', () => {
    it('should normalize Ed25519 key to PKCS8 format', async () => {
      const { privateKeyPem } = await generateSshKeypair('testuser');
      const normalized = normalizePrivateKeyPem(privateKeyPem);

      expect(normalized).to.not.be.null;
      expect(normalized).to.include('-----BEGIN PRIVATE KEY-----');
    });

    it('should return null for invalid key', () => {
      expect(normalizePrivateKeyPem('invalid')).to.be.null;
    });
  });
});
