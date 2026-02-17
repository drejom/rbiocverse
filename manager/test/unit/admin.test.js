const { expect } = require('chai');

describe('Admin Authorization', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    // Clear require cache to reload admin module with new env vars
    delete require.cache[require.resolve('../../lib/auth/admin')];
  });

  describe('ADMIN_USERS parsing', () => {
    it('should parse comma-separated admin users', () => {
      process.env.ADMIN_USERS = 'alice,bob,charlie';
      delete process.env.ADMIN_USER;

      const { ADMIN_USERS, getAdminUsers } = require('../../lib/auth/admin');

      expect(ADMIN_USERS).to.deep.equal(['alice', 'bob', 'charlie']);
      expect(getAdminUsers()).to.deep.equal(['alice', 'bob', 'charlie']);
    });

    it('should trim whitespace from usernames', () => {
      process.env.ADMIN_USERS = ' alice , bob , charlie ';
      delete process.env.ADMIN_USER;

      const { ADMIN_USERS } = require('../../lib/auth/admin');

      expect(ADMIN_USERS).to.deep.equal(['alice', 'bob', 'charlie']);
    });

    it('should filter empty entries', () => {
      process.env.ADMIN_USERS = 'alice,,bob,,,charlie';
      delete process.env.ADMIN_USER;

      const { ADMIN_USERS } = require('../../lib/auth/admin');

      expect(ADMIN_USERS).to.deep.equal(['alice', 'bob', 'charlie']);
    });

    it('should fall back to ADMIN_USER if ADMIN_USERS not set', () => {
      delete process.env.ADMIN_USERS;
      process.env.ADMIN_USER = 'singleadmin';

      const { ADMIN_USERS } = require('../../lib/auth/admin');

      expect(ADMIN_USERS).to.deep.equal(['singleadmin']);
    });

    it('should prefer ADMIN_USERS over ADMIN_USER', () => {
      process.env.ADMIN_USERS = 'alice,bob';
      process.env.ADMIN_USER = 'singleadmin';

      const { ADMIN_USERS } = require('../../lib/auth/admin');

      expect(ADMIN_USERS).to.deep.equal(['alice', 'bob']);
    });

    it('should return empty array if neither env var set', () => {
      delete process.env.ADMIN_USERS;
      delete process.env.ADMIN_USER;

      const { ADMIN_USERS } = require('../../lib/auth/admin');

      expect(ADMIN_USERS).to.deep.equal([]);
    });
  });

  describe('isAdmin', () => {
    it('should return true for admin users', () => {
      process.env.ADMIN_USERS = 'alice,bob';

      const { isAdmin } = require('../../lib/auth/admin');

      expect(isAdmin('alice')).to.be.true;
      expect(isAdmin('bob')).to.be.true;
    });

    it('should return false for non-admin users', () => {
      process.env.ADMIN_USERS = 'alice,bob';

      const { isAdmin } = require('../../lib/auth/admin');

      expect(isAdmin('charlie')).to.be.false;
      expect(isAdmin('eve')).to.be.false;
    });

    it('should return false for null/undefined', () => {
      process.env.ADMIN_USERS = 'alice,bob';

      const { isAdmin } = require('../../lib/auth/admin');

      expect(isAdmin(null)).to.be.false;
      expect(isAdmin(undefined)).to.be.false;
      expect(isAdmin('')).to.be.false;
    });

    it('should return false when no admins configured', () => {
      delete process.env.ADMIN_USERS;
      delete process.env.ADMIN_USER;

      const { isAdmin } = require('../../lib/auth/admin');

      expect(isAdmin('anyone')).to.be.false;
    });
  });

  describe('getPrimaryAdmin', () => {
    it('should return first admin in list', () => {
      process.env.ADMIN_USERS = 'alice,bob,charlie';

      const { getPrimaryAdmin } = require('../../lib/auth/admin');

      expect(getPrimaryAdmin()).to.equal('alice');
    });

    it('should return single admin when only one configured', () => {
      process.env.ADMIN_USERS = 'singleadmin';

      const { getPrimaryAdmin } = require('../../lib/auth/admin');

      expect(getPrimaryAdmin()).to.equal('singleadmin');
    });

    it('should return null when no admins configured', () => {
      delete process.env.ADMIN_USERS;
      delete process.env.ADMIN_USER;

      const { getPrimaryAdmin } = require('../../lib/auth/admin');

      expect(getPrimaryAdmin()).to.be.null;
    });
  });

  describe('ADMIN_USER backwards compatibility', () => {
    it('should export ADMIN_USER as primary admin', () => {
      process.env.ADMIN_USERS = 'alice,bob';

      const { ADMIN_USER } = require('../../lib/auth/admin');

      expect(ADMIN_USER).to.equal('alice');
    });

    it('should export null when no admins configured', () => {
      delete process.env.ADMIN_USERS;
      delete process.env.ADMIN_USER;

      const { ADMIN_USER } = require('../../lib/auth/admin');

      expect(ADMIN_USER).to.be.null;
    });
  });

  describe('getAdminUsers', () => {
    it('should return a copy of admin users array', () => {
      process.env.ADMIN_USERS = 'alice,bob';

      const { getAdminUsers, ADMIN_USERS } = require('../../lib/auth/admin');
      const users = getAdminUsers();

      // Should be equal but not the same reference
      expect(users).to.deep.equal(ADMIN_USERS);
      expect(users).to.not.equal(ADMIN_USERS);

      // Modifying return value should not affect original
      users.push('charlie');
      expect(ADMIN_USERS).to.have.lengthOf(2);
    });
  });
});
