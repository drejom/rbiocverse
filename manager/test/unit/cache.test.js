const { expect } = require('chai');
const { createClusterCache, DEFAULT_CACHE_TTL } = require('../../lib/cache');

describe('ClusterCache', () => {
  describe('createClusterCache', () => {
    it('should create a cache with default TTL', () => {
      const cache = createClusterCache();
      expect(cache.getTTL()).to.equal(DEFAULT_CACHE_TTL);
    });

    it('should create a cache with custom TTL', () => {
      const cache = createClusterCache(60000);
      expect(cache.getTTL()).to.equal(60000);
    });

    it('should have gemini and apollo clusters', () => {
      const cache = createClusterCache();
      expect(cache.getClusters()).to.deep.equal(['gemini', 'apollo']);
    });
  });

  describe('get', () => {
    it('should return invalid for empty cache', () => {
      const cache = createClusterCache();
      const result = cache.get('gemini');
      expect(result.valid).to.be.false;
      expect(result.data).to.be.null;
    });

    it('should return invalid for unknown cluster', () => {
      const cache = createClusterCache();
      const result = cache.get('unknown');
      expect(result.valid).to.be.false;
      expect(result.data).to.be.null;
      expect(result.age).to.equal(Infinity);
    });

    it('should return valid data when cache is fresh', () => {
      const cache = createClusterCache(60000); // 1 minute TTL
      const testData = { status: 'running', jobId: '12345' };
      cache.set('gemini', testData);

      const result = cache.get('gemini');
      expect(result.valid).to.be.true;
      expect(result.data).to.deep.equal(testData);
      expect(result.age).to.be.lessThan(1000); // Should be very recent
    });

    it('should return invalid when cache is stale', (done) => {
      const cache = createClusterCache(50); // 50ms TTL
      const testData = { status: 'running' };
      cache.set('gemini', testData);

      // Wait for cache to expire
      setTimeout(() => {
        const result = cache.get('gemini');
        expect(result.valid).to.be.false;
        expect(result.data).to.deep.equal(testData); // Data still accessible
        expect(result.age).to.be.greaterThan(50);
        done();
      }, 60);
    });
  });

  describe('set', () => {
    it('should set data for gemini cluster', () => {
      const cache = createClusterCache();
      const testData = { vscode: { status: 'running' } };
      cache.set('gemini', testData);

      const result = cache.get('gemini');
      expect(result.data).to.deep.equal(testData);
    });

    it('should set data for apollo cluster', () => {
      const cache = createClusterCache();
      const testData = { rstudio: { status: 'pending' } };
      cache.set('apollo', testData);

      const result = cache.get('apollo');
      expect(result.data).to.deep.equal(testData);
    });

    it('should not throw for unknown cluster', () => {
      const cache = createClusterCache();
      expect(() => cache.set('unknown', { data: 'test' })).to.not.throw();
    });

    it('should update cache timestamp on set', (done) => {
      const cache = createClusterCache(1000);
      cache.set('gemini', { old: true });

      setTimeout(() => {
        const oldAge = cache.get('gemini').age;
        cache.set('gemini', { new: true });
        const newAge = cache.get('gemini').age;

        expect(newAge).to.be.lessThan(oldAge);
        done();
      }, 50);
    });
  });

  describe('invalidate', () => {
    it('should invalidate specific cluster cache', () => {
      const cache = createClusterCache();
      cache.set('gemini', { status: 'running' });
      cache.set('apollo', { status: 'pending' });

      cache.invalidate('gemini');

      expect(cache.get('gemini').valid).to.be.false;
      expect(cache.get('apollo').valid).to.be.true;
    });

    it('should invalidate all clusters when no argument', () => {
      const cache = createClusterCache();
      cache.set('gemini', { status: 'running' });
      cache.set('apollo', { status: 'pending' });

      cache.invalidate();

      expect(cache.get('gemini').valid).to.be.false;
      expect(cache.get('apollo').valid).to.be.false;
    });

    it('should invalidate all clusters when null passed', () => {
      const cache = createClusterCache();
      cache.set('gemini', { status: 'running' });
      cache.set('apollo', { status: 'pending' });

      cache.invalidate(null);

      expect(cache.get('gemini').valid).to.be.false;
      expect(cache.get('apollo').valid).to.be.false;
    });

    it('should not throw for unknown cluster', () => {
      const cache = createClusterCache();
      expect(() => cache.invalidate('unknown')).to.not.throw();
    });

    it('should preserve data after invalidation (for stale reads)', () => {
      const cache = createClusterCache();
      const testData = { status: 'running' };
      cache.set('gemini', testData);
      cache.invalidate('gemini');

      const result = cache.get('gemini');
      expect(result.valid).to.be.false;
      expect(result.data).to.deep.equal(testData);
    });
  });

  describe('hasCluster', () => {
    it('should return true for gemini', () => {
      const cache = createClusterCache();
      expect(cache.hasCluster('gemini')).to.be.true;
    });

    it('should return true for apollo', () => {
      const cache = createClusterCache();
      expect(cache.hasCluster('apollo')).to.be.true;
    });

    it('should return false for unknown cluster', () => {
      const cache = createClusterCache();
      expect(cache.hasCluster('unknown')).to.be.false;
    });
  });

  describe('per-cluster independence', () => {
    it('should cache clusters independently', () => {
      const cache = createClusterCache();
      const geminiData = { cluster: 'gemini', jobs: ['job1'] };
      const apolloData = { cluster: 'apollo', jobs: ['job2'] };

      cache.set('gemini', geminiData);
      cache.set('apollo', apolloData);

      expect(cache.get('gemini').data).to.deep.equal(geminiData);
      expect(cache.get('apollo').data).to.deep.equal(apolloData);
    });

    it('should allow updating one cluster without affecting the other', () => {
      const cache = createClusterCache();
      cache.set('gemini', { version: 1 });
      cache.set('apollo', { version: 1 });

      cache.set('gemini', { version: 2 });

      expect(cache.get('gemini').data.version).to.equal(2);
      expect(cache.get('apollo').data.version).to.equal(1);
    });

    it('should allow invalidating one cluster without affecting the other', () => {
      const cache = createClusterCache();
      cache.set('gemini', { status: 'running' });
      cache.set('apollo', { status: 'running' });

      cache.invalidate('gemini');

      expect(cache.get('gemini').valid).to.be.false;
      expect(cache.get('apollo').valid).to.be.true;
    });
  });

  describe('forceRefresh behavior', () => {
    it('should return fresh data after set regardless of previous state', () => {
      const cache = createClusterCache();
      cache.set('gemini', { status: 'old' });
      cache.invalidate('gemini');

      // Simulate forceRefresh by setting new data
      cache.set('gemini', { status: 'new' });

      const result = cache.get('gemini');
      expect(result.valid).to.be.true;
      expect(result.data.status).to.equal('new');
      expect(result.age).to.be.lessThan(100);
    });
  });

  describe('cache age calculation', () => {
    it('should report age of 0 for freshly set data', () => {
      const cache = createClusterCache();
      cache.set('gemini', { test: true });

      const result = cache.get('gemini');
      expect(result.age).to.be.lessThan(50);
    });

    it('should report correct age for stale data', (done) => {
      const cache = createClusterCache();
      cache.set('gemini', { test: true });

      setTimeout(() => {
        const result = cache.get('gemini');
        expect(result.age).to.be.greaterThanOrEqual(90);
        expect(result.age).to.be.lessThan(150);
        done();
      }, 100);
    });
  });
});
