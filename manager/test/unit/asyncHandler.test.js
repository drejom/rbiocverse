/**
 * Tests for asyncHandler (lib/asyncHandler.js)
 */

const { expect } = require('chai');
const sinon = require('sinon');
const asyncHandler = require('../../lib/asyncHandler');

describe('asyncHandler', () => {
  let req, res, next;

  beforeEach(() => {
    req = {};
    res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis(),
    };
    next = sinon.stub();
  });

  it('should call the wrapped function', async () => {
    const fn = sinon.stub().resolves();
    const wrapped = asyncHandler(fn);

    await wrapped(req, res, next);

    expect(fn.calledWith(req, res, next)).to.be.true;
  });

  it('should pass through successful responses', async () => {
    const fn = async (req, res) => {
      res.json({ success: true });
    };
    const wrapped = asyncHandler(fn);

    await wrapped(req, res, next);

    expect(res.json.calledWith({ success: true })).to.be.true;
    expect(next.called).to.be.false;
  });

  it('should catch errors and pass to next()', async () => {
    const error = new Error('Test error');
    const fn = async () => {
      throw error;
    };
    const wrapped = asyncHandler(fn);

    await wrapped(req, res, next);

    expect(next.calledWith(error)).to.be.true;
  });

  it('should handle rejected promises', async () => {
    const error = new Error('Rejected');
    const fn = () => Promise.reject(error);
    const wrapped = asyncHandler(fn);

    await wrapped(req, res, next);

    expect(next.calledWith(error)).to.be.true;
  });

  it('should handle synchronous functions that return values', async () => {
    const fn = (req, res) => {
      res.json({ sync: true });
      return 'done';
    };
    const wrapped = asyncHandler(fn);

    await wrapped(req, res, next);

    expect(res.json.calledWith({ sync: true })).to.be.true;
    expect(next.called).to.be.false;
  });

  it('should handle synchronous functions that throw', async () => {
    const error = new Error('Sync error');
    const fn = () => {
      throw error;
    };
    const wrapped = asyncHandler(fn);

    await wrapped(req, res, next);

    expect(next.calledWith(error)).to.be.true;
  });
});
