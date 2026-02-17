const { expect } = require('chai');
const sinon = require('sinon');
const { withClusterQueue, clearQueues } = require('../../lib/ssh-queue');

describe('SSH Queue', () => {
  afterEach(() => {
    clearQueues();
    sinon.restore();
  });

  describe('withClusterQueue', () => {
    it('should execute function immediately when queue is empty', async () => {
      let executed = false;
      const fn = async () => {
        executed = true;
        return 'result';
      };

      const result = await withClusterQueue('gemini', fn);

      expect(executed).to.be.true;
      expect(result).to.equal('result');
    });

    it('should serialize calls to the same cluster', async () => {
      const order = [];
      const fn1 = () => new Promise(resolve => setTimeout(() => {
        order.push(1);
        resolve('first');
      }, 50));
      const fn2 = () => new Promise(resolve => setTimeout(() => {
        order.push(2);
        resolve('second');
      }, 10));

      const results = await Promise.all([
        withClusterQueue('gemini', fn1),
        withClusterQueue('gemini', fn2),
      ]);

      // fn1 completes before fn2 starts (even though fn2 is faster)
      expect(order).to.deep.equal([1, 2]);
      expect(results).to.deep.equal(['first', 'second']);
    });

    it('should allow parallel calls to different clusters', async () => {
      const starts = [];
      const ends = [];
      const fn = (name) => () => new Promise(resolve => {
        starts.push(name);
        setTimeout(() => {
          ends.push(name);
          resolve(name);
        }, 20);
      });

      const startTime = Date.now();
      const results = await Promise.all([
        withClusterQueue('apollo', fn('apollo')),
        withClusterQueue('gemini', fn('gemini')),
      ]);
      const duration = Date.now() - startTime;

      // Both should start without waiting for each other
      expect(starts).to.include('apollo');
      expect(starts).to.include('gemini');
      expect(results).to.include('apollo');
      expect(results).to.include('gemini');
      // Should complete in ~20ms (parallel), not ~40ms (serial)
      expect(duration).to.be.below(50);
    });

    it('should continue queue after error', async () => {
      const fn1 = () => Promise.reject(new Error('First call failed'));
      const fn2 = () => Promise.resolve('second');

      // First call fails
      try {
        await withClusterQueue('gemini', fn1);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e.message).to.equal('First call failed');
      }

      // Second call should still work
      const result = await withClusterQueue('gemini', fn2);
      expect(result).to.equal('second');
    });

    it('should handle multiple sequential calls', async () => {
      const results = [];
      for (let i = 0; i < 5; i++) {
        const result = await withClusterQueue('gemini', async () => {
          results.push(i);
          return i;
        });
        expect(result).to.equal(i);
      }
      expect(results).to.deep.equal([0, 1, 2, 3, 4]);
    });

    it('should handle sync functions', async () => {
      const fn = () => 'sync result';
      const result = await withClusterQueue('gemini', fn);
      expect(result).to.equal('sync result');
    });

    it('should propagate errors correctly', async () => {
      const fn = () => {
        throw new Error('Sync error');
      };

      try {
        await withClusterQueue('gemini', fn);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e.message).to.equal('Sync error');
      }
    });

    it('should handle async errors correctly', async () => {
      const fn = async () => {
        await new Promise(r => setTimeout(r, 10));
        throw new Error('Async error');
      };

      try {
        await withClusterQueue('gemini', fn);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e.message).to.equal('Async error');
      }
    });

    it('should maintain separate queues for each cluster', async () => {
      const apolloOrder = [];
      const geminiOrder = [];

      await Promise.all([
        withClusterQueue('apollo', async () => {
          apolloOrder.push('a1');
          await new Promise(r => setTimeout(r, 30));
          apolloOrder.push('a1-done');
        }),
        withClusterQueue('gemini', async () => {
          geminiOrder.push('g1');
          await new Promise(r => setTimeout(r, 10));
          geminiOrder.push('g1-done');
        }),
        withClusterQueue('apollo', async () => {
          apolloOrder.push('a2');
        }),
        withClusterQueue('gemini', async () => {
          geminiOrder.push('g2');
        }),
      ]);

      // Apollo: a1 finishes before a2 starts
      expect(apolloOrder).to.deep.equal(['a1', 'a1-done', 'a2']);
      // Gemini: g1 finishes before g2 starts
      expect(geminiOrder).to.deep.equal(['g1', 'g1-done', 'g2']);
    });
  });

  describe('clearQueues', () => {
    it('should clear all queues', async () => {
      // Add something to the queue
      await withClusterQueue('gemini', () => 'test');

      // Clear
      clearQueues();

      // Should be able to add new items without issues
      const result = await withClusterQueue('gemini', () => 'fresh');
      expect(result).to.equal('fresh');
    });
  });
});
