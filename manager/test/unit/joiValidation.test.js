/**
 * Tests for Joi validation schemas (lib/validation.js)
 */

const { expect } = require('chai');
const sinon = require('sinon');
const { schemas, validate, isJoiAvailable } = require('../../lib/validation');

// Skip tests if Joi is not installed
const describeIfJoi = isJoiAvailable() ? describe : describe.skip;

describeIfJoi('Joi Validation Schemas', () => {
  describe('schemas.updateUser', () => {
    it('should accept valid fullName', () => {
      const result = schemas.updateUser.validate({ fullName: 'John Doe' });
      expect(result.error).to.be.undefined;
      expect(result.value.fullName).to.equal('John Doe');
    });

    it('should accept empty fullName', () => {
      const result = schemas.updateUser.validate({ fullName: '' });
      expect(result.error).to.be.undefined;
    });

    it('should accept null fullName', () => {
      const result = schemas.updateUser.validate({ fullName: null });
      expect(result.error).to.be.undefined;
    });

    it('should accept empty object', () => {
      const result = schemas.updateUser.validate({});
      expect(result.error).to.be.undefined;
    });

    it('should reject fullName over 100 chars', () => {
      const result = schemas.updateUser.validate({ fullName: 'a'.repeat(101) });
      expect(result.error).to.not.be.undefined;
    });

    it('should strip unknown fields', () => {
      const result = schemas.updateUser.validate(
        { fullName: 'Test', unknownField: 'bad' },
        { stripUnknown: true }
      );
      expect(result.value.unknownField).to.be.undefined;
    });
  });

  describe('schemas.bulkUserAction', () => {
    it('should accept valid delete action', () => {
      const result = schemas.bulkUserAction.validate({
        action: 'delete',
        usernames: ['user1', 'user2'],
      });
      expect(result.error).to.be.undefined;
    });

    it('should accept valid delete-keys action', () => {
      const result = schemas.bulkUserAction.validate({
        action: 'delete-keys',
        usernames: ['user1'],
      });
      expect(result.error).to.be.undefined;
    });

    it('should reject invalid action', () => {
      const result = schemas.bulkUserAction.validate({
        action: 'invalid',
        usernames: ['user1'],
      });
      expect(result.error).to.not.be.undefined;
    });

    it('should reject empty usernames array', () => {
      const result = schemas.bulkUserAction.validate({
        action: 'delete',
        usernames: [],
      });
      expect(result.error).to.not.be.undefined;
    });

    it('should reject missing action', () => {
      const result = schemas.bulkUserAction.validate({
        usernames: ['user1'],
      });
      expect(result.error).to.not.be.undefined;
    });

    it('should reject missing usernames', () => {
      const result = schemas.bulkUserAction.validate({
        action: 'delete',
      });
      expect(result.error).to.not.be.undefined;
    });
  });

  describe('schemas.usernameParam', () => {
    it('should accept valid username', () => {
      const result = schemas.usernameParam.validate({ username: 'john_doe' });
      expect(result.error).to.be.undefined;
    });

    it('should accept username with dots and hyphens', () => {
      const result = schemas.usernameParam.validate({ username: 'john.doe-123' });
      expect(result.error).to.be.undefined;
    });

    it('should reject username with special characters', () => {
      const result = schemas.usernameParam.validate({ username: 'john;rm -rf' });
      expect(result.error).to.not.be.undefined;
    });

    it('should reject username over 50 chars', () => {
      const result = schemas.usernameParam.validate({ username: 'a'.repeat(51) });
      expect(result.error).to.not.be.undefined;
    });
  });

  describe('schemas.searchQuery', () => {
    it('should accept valid query', () => {
      const result = schemas.searchQuery.validate({ q: 'search term' });
      expect(result.error).to.be.undefined;
    });

    it('should reject query under 2 chars', () => {
      const result = schemas.searchQuery.validate({ q: 'a' });
      expect(result.error).to.not.be.undefined;
    });

    it('should reject query over 100 chars', () => {
      const result = schemas.searchQuery.validate({ q: 'a'.repeat(101) });
      expect(result.error).to.not.be.undefined;
    });
  });

  describe('schemas.pagination', () => {
    it('should use defaults when no values provided', () => {
      const result = schemas.pagination.validate({});
      expect(result.value.limit).to.equal(100);
      expect(result.value.offset).to.equal(0);
      expect(result.value.days).to.equal(30);
    });

    it('should accept valid values', () => {
      const result = schemas.pagination.validate({
        limit: 50,
        offset: 10,
        days: 7,
      });
      expect(result.error).to.be.undefined;
      expect(result.value.limit).to.equal(50);
    });

    it('should reject limit over 1000', () => {
      const result = schemas.pagination.validate({ limit: 1001 });
      expect(result.error).to.not.be.undefined;
    });

    it('should reject negative offset', () => {
      const result = schemas.pagination.validate({ offset: -1 });
      expect(result.error).to.not.be.undefined;
    });
  });
});

describeIfJoi('validate middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = { body: {}, query: {}, params: {} };
    res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
    };
    next = sinon.stub();
  });

  it('should call next() for valid body', () => {
    req.body = { fullName: 'Test User' };
    const middleware = validate(schemas.updateUser, 'body');

    middleware(req, res, next);

    expect(next.called).to.be.true;
    expect(res.status.called).to.be.false;
  });

  it('should return 400 for invalid body', () => {
    req.body = { fullName: 'a'.repeat(101) };
    const middleware = validate(schemas.updateUser, 'body');

    middleware(req, res, next);

    expect(res.status.calledWith(400)).to.be.true;
    expect(res.json.called).to.be.true;
    expect(next.called).to.be.false;
  });

  it('should validate query params', () => {
    req.query = { q: 'ab' };
    const middleware = validate(schemas.searchQuery, 'query');

    middleware(req, res, next);

    expect(next.called).to.be.true;
  });

  it('should validate route params', () => {
    req.params = { username: 'valid_user' };
    const middleware = validate(schemas.usernameParam, 'params');

    middleware(req, res, next);

    expect(next.called).to.be.true;
  });

  it('should strip unknown fields from validated data', () => {
    req.body = { fullName: 'Test', extraField: 'removed' };
    const middleware = validate(schemas.updateUser, 'body');

    middleware(req, res, next);

    expect(req.body.extraField).to.be.undefined;
    expect(req.body.fullName).to.equal('Test');
  });

  it('should include error details in response', () => {
    req.body = { action: 'invalid', usernames: [] };
    const middleware = validate(schemas.bulkUserAction, 'body');

    middleware(req, res, next);

    const response = res.json.getCall(0).args[0];
    expect(response.error).to.equal('Validation failed');
    expect(response.details).to.be.an('array');
    expect(response.details.length).to.be.greaterThan(0);
  });
});
