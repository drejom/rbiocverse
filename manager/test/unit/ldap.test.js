'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

// Load ldapts once — we mutate its exports to stub Client
const ldapts = require('ldapts');
const { InvalidCredentialsError } = ldapts;

describe('LDAP authenticate()', () => {
  let authenticate;
  let savedEnv;

  // Helper: build a mock Client instance
  function makeMockClient({ bindError, searchEntries } = {}) {
    return {
      bind: bindError ? sinon.stub().rejects(bindError) : sinon.stub().resolves(),
      search: sinon.stub().resolves({ searchEntries: searchEntries || [] }),
      unbind: sinon.stub().resolves(),
    };
  }

  beforeEach(() => {
    // Save env vars we touch
    savedEnv = {
      LDAP_URL: process.env.LDAP_URL,
      LDAP_DOMAIN: process.env.LDAP_DOMAIN,
      TEST_USERNAME: process.env.TEST_USERNAME,
      TEST_PASSWORD: process.env.TEST_PASSWORD,
      TEST_FULLNAME: process.env.TEST_FULLNAME,
    };

    // Clear the ldap module cache so env-var reads inside the module are fresh
    delete require.cache[require.resolve('../../lib/auth/ldap')];
    ({ authenticate } = require('../../lib/auth/ldap'));
  });

  afterEach(() => {
    sinon.restore();

    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // ── Dev mode (LDAP_URL unset) ──────────────────────────────────────────────

  describe('dev mode (LDAP_URL unset)', () => {
    beforeEach(() => {
      delete process.env.LDAP_URL;
      process.env.TEST_USERNAME = 'testuser';
      process.env.TEST_PASSWORD = 'testpass';
    });

    it('returns success with TEST_FULLNAME when credentials match', async () => {
      process.env.TEST_FULLNAME = 'Test User';
      const result = await authenticate('testuser', 'testpass');
      expect(result).to.deep.equal({ success: true, fullName: 'Test User' });
    });

    it('returns success with username when TEST_FULLNAME is unset', async () => {
      delete process.env.TEST_FULLNAME;
      const result = await authenticate('testuser', 'testpass');
      expect(result).to.deep.equal({ success: true, fullName: 'testuser' });
    });

    it('returns failure for wrong password', async () => {
      const result = await authenticate('testuser', 'wrongpass');
      expect(result).to.deep.equal({ success: false });
    });

    it('returns failure for wrong username', async () => {
      const result = await authenticate('wronguser', 'testpass');
      expect(result).to.deep.equal({ success: false });
    });

    it('throws when neither LDAP_URL nor TEST_* vars are set', async () => {
      delete process.env.TEST_USERNAME;
      delete process.env.TEST_PASSWORD;
      let thrown = null;
      try {
        await authenticate('user', 'pass');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect(thrown.message).to.include('Authentication not configured');
    });
  });

  // ── LDAP mode — single DC, fully mocked ───────────────────────────────────

  describe('LDAP mode (single DC)', () => {
    beforeEach(() => {
      process.env.LDAP_URL = 'ldap://dc1.example.com';
      process.env.LDAP_DOMAIN = 'example.com';
      delete process.env.TEST_USERNAME;
    });

    it('throws when LDAP_URL is set but LDAP_DOMAIN is missing', async () => {
      delete process.env.LDAP_DOMAIN;
      let thrown = null;
      try {
        await authenticate('alice', 'password');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect(thrown.message).to.include('LDAP_DOMAIN is not configured');
    });

    it('returns success with displayName from search result', async () => {
      const mockClient = makeMockClient({
        searchEntries: [{ displayName: 'Display Name' }],
      });
      sinon.stub(ldapts, 'Client').callsFake(() => mockClient);

      const result = await authenticate('alice', 'password');
      expect(result).to.deep.equal({ success: true, fullName: 'Display Name' });
    });

    it('returns success with cn when displayName is absent', async () => {
      const mockClient = makeMockClient({
        searchEntries: [{ cn: 'CN Value' }],
      });
      sinon.stub(ldapts, 'Client').callsFake(() => mockClient);

      const result = await authenticate('alice', 'password');
      expect(result).to.deep.equal({ success: true, fullName: 'CN Value' });
    });

    it('returns success with username when no name attributes in result', async () => {
      const mockClient = makeMockClient({ searchEntries: [{}] });
      sinon.stub(ldapts, 'Client').callsFake(() => mockClient);

      const result = await authenticate('alice', 'password');
      expect(result).to.deep.equal({ success: true, fullName: 'alice' });
    });

    it('returns success with first element when displayName is an array', async () => {
      const mockClient = makeMockClient({
        searchEntries: [{ displayName: ['Array Name', 'Second'] }],
      });
      sinon.stub(ldapts, 'Client').callsFake(() => mockClient);

      const result = await authenticate('alice', 'password');
      expect(result).to.deep.equal({ success: true, fullName: 'Array Name' });
    });

    it('returns failure on InvalidCredentialsError', async () => {
      const mockClient = makeMockClient({ bindError: new InvalidCredentialsError() });
      sinon.stub(ldapts, 'Client').callsFake(() => mockClient);

      const result = await authenticate('alice', 'wrongpass');
      expect(result).to.deep.equal({ success: false });
    });
  });

  // ── LDAP mode — DC failover ────────────────────────────────────────────────

  describe('LDAP mode — DC failover', () => {
    beforeEach(() => {
      process.env.LDAP_DOMAIN = 'example.com';
      delete process.env.TEST_USERNAME;
    });

    it('falls over to second DC when first is unreachable', async () => {
      process.env.LDAP_URL = 'ldap://dc1.example.com,ldap://dc2.example.com';

      let callCount = 0;
      sinon.stub(ldapts, 'Client').callsFake(() => {
        callCount++;
        if (callCount === 1) {
          // First DC: connection error
          return makeMockClient({ bindError: new Error('ECONNREFUSED') });
        }
        // Second DC: success
        return makeMockClient({ searchEntries: [{ displayName: 'Alice Smith' }] });
      });

      const result = await authenticate('alice', 'password');
      expect(result).to.deep.equal({ success: true, fullName: 'Alice Smith' });
      expect(callCount).to.equal(2);
    });

    it('throws when all DCs are unreachable', async () => {
      process.env.LDAP_URL = 'ldap://dc1.example.com,ldap://dc2.example.com';

      sinon.stub(ldapts, 'Client').callsFake(() =>
        makeMockClient({ bindError: new Error('ECONNREFUSED') })
      );

      let thrown = null;
      try {
        await authenticate('alice', 'password');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect(thrown.message).to.include('All LDAP domain controllers unreachable');
    });

    it('stops at first DC on InvalidCredentialsError (no failover)', async () => {
      process.env.LDAP_URL = 'ldap://dc1.example.com,ldap://dc2.example.com';

      let callCount = 0;
      sinon.stub(ldapts, 'Client').callsFake(() => {
        callCount++;
        return makeMockClient({ bindError: new InvalidCredentialsError() });
      });

      const result = await authenticate('alice', 'wrongpass');
      expect(result).to.deep.equal({ success: false });
      // Only the first DC should have been tried
      expect(callCount).to.equal(1);
    });
  });
});
