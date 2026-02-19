const { expect } = require('chai');
const {
  HpcError,
  ValidationError,
  SshError,
  JobError,
  TunnelError,
  LockError,
  NotFoundError,
  errorDetails,
  errorMessage,
} = require('../../lib/errors');

describe('Custom Error Classes', () => {
  describe('HpcError (base class)', () => {
    it('should create error with default values', () => {
      const err = new HpcError('Something went wrong');
      expect(err.message).to.equal('Something went wrong');
      expect(err.code).to.equal(500);
      expect(err.name).to.equal('HpcError');
      expect(err.details).to.deep.equal({});
    });

    it('should create error with custom code and details', () => {
      const err = new HpcError('Custom error', 503, { cluster: 'gemini' });
      expect(err.code).to.equal(503);
      expect(err.details).to.deep.equal({ cluster: 'gemini' });
    });

    it('should serialize to JSON correctly', () => {
      const err = new HpcError('Test error', 500, { foo: 'bar' });
      const json = err.toJSON();
      expect(json.error).to.equal('Test error');
      expect(json.code).to.equal(500);
      expect(json.type).to.equal('HpcError');
      expect(json.details).to.deep.equal({ foo: 'bar' });
      expect(json.timestamp).to.be.a('string');
    });

    it('should be instanceof Error', () => {
      const err = new HpcError('Test');
      expect(err).to.be.instanceof(Error);
      expect(err).to.be.instanceof(HpcError);
    });
  });

  describe('ValidationError', () => {
    it('should have code 400', () => {
      const err = new ValidationError('Invalid input');
      expect(err.code).to.equal(400);
      expect(err.name).to.equal('ValidationError');
    });

    it('should include field details', () => {
      const err = new ValidationError('Invalid CPU value', { field: 'cpus', value: '-1' });
      expect(err.details.field).to.equal('cpus');
      expect(err.details.value).to.equal('-1');
    });

    it('should be instanceof HpcError', () => {
      const err = new ValidationError('Test');
      expect(err).to.be.instanceof(HpcError);
    });
  });

  describe('SshError', () => {
    it('should have code 502', () => {
      const err = new SshError('Connection failed');
      expect(err.code).to.equal(502);
      expect(err.name).to.equal('SshError');
    });

    it('should include host details', () => {
      const err = new SshError('Connection timeout', { host: 'gemini-login2.coh.org' });
      expect(err.details.host).to.equal('gemini-login2.coh.org');
    });
  });

  describe('JobError', () => {
    it('should have code 500', () => {
      const err = new JobError('Job submission failed');
      expect(err.code).to.equal(500);
      expect(err.name).to.equal('JobError');
    });

    it('should include job details', () => {
      const err = new JobError('Job disappeared', { jobId: '12345', cluster: 'gemini' });
      expect(err.details.jobId).to.equal('12345');
      expect(err.details.cluster).to.equal('gemini');
    });
  });

  describe('TunnelError', () => {
    it('should have code 502', () => {
      const err = new TunnelError('Tunnel failed to establish');
      expect(err.code).to.equal(502);
      expect(err.name).to.equal('TunnelError');
    });

    it('should include tunnel details', () => {
      const err = new TunnelError('Port unavailable', { port: 8000, node: 'g-h-1-9-01' });
      expect(err.details.port).to.equal(8000);
      expect(err.details.node).to.equal('g-h-1-9-01');
    });
  });

  describe('LockError', () => {
    it('should have code 429', () => {
      const err = new LockError('Operation in progress');
      expect(err.code).to.equal(429);
      expect(err.name).to.equal('LockError');
    });

    it('should include lock details', () => {
      const err = new LockError('Launch already in progress', { operation: 'launch:gemini' });
      expect(err.details.operation).to.equal('launch:gemini');
    });
  });

  describe('NotFoundError', () => {
    it('should have code 404', () => {
      const err = new NotFoundError('Session not found');
      expect(err.code).to.equal(404);
      expect(err.name).to.equal('NotFoundError');
    });

    it('should include resource details', () => {
      const err = new NotFoundError('No session for cluster', { cluster: 'apollo' });
      expect(err.details.cluster).to.equal('apollo');
    });
  });
});

describe('errorDetails', () => {
  it('should return { error, stack } for Error instances', () => {
    const err = new Error('something broke');
    const result = errorDetails(err);
    expect(result).to.have.property('error', 'something broke');
    expect(result).to.have.property('stack').that.is.a('string');
    expect(result).to.not.have.property('detail');
  });

  it('should return { detail } for string throws', () => {
    const result = errorDetails('oops');
    expect(result).to.deep.equal({ detail: 'oops' });
  });

  it('should return { detail } for object throws', () => {
    const result = errorDetails({ code: 42 });
    expect(result).to.have.property('detail', '[object Object]');
  });

  it('should return { detail } for null', () => {
    const result = errorDetails(null);
    expect(result).to.deep.equal({ detail: 'null' });
  });

  it('should return { detail } for undefined', () => {
    const result = errorDetails(undefined);
    expect(result).to.deep.equal({ detail: 'undefined' });
  });
});

describe('errorMessage', () => {
  it('should return err.message for Error instances', () => {
    const err = new Error('something broke');
    expect(errorMessage(err)).to.equal('something broke');
  });

  it('should return String(err) for string throws', () => {
    expect(errorMessage('oops')).to.equal('oops');
  });

  it('should return String(err) for number throws', () => {
    expect(errorMessage(42)).to.equal('42');
  });

  it('should return "null" for null', () => {
    expect(errorMessage(null)).to.equal('null');
  });

  it('should return "undefined" for undefined', () => {
    expect(errorMessage(undefined)).to.equal('undefined');
  });

  it('should return empty string for Error with empty message', () => {
    expect(errorMessage(new Error(''))).to.equal('');
  });
});
