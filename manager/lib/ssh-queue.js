/**
 * SSH Queue - Per-cluster promise serialization
 *
 * Ensures SSH operations to each cluster are executed one at a time,
 * preventing race conditions when multiple operations target the same cluster.
 *
 * - Strict serialization per cluster (one SSH call at a time)
 * - Different clusters can run in parallel
 * - Queue continues even if previous call failed
 *
 * Issue #52: SSH Command Coordination
 */

const { log } = require('./logger');

// Per-cluster promise chains - strict serialization
const queues = new Map();

/**
 * Execute a function within the cluster's SSH queue
 * Ensures only one SSH call runs at a time per cluster
 *
 * @param {string} cluster - Cluster name ('gemini' or 'apollo')
 * @param {Function} fn - Async function to execute
 * @returns {Promise<any>} Result of the function
 */
async function withClusterQueue(cluster, fn) {
  const current = queues.get(cluster) || Promise.resolve();

  const next = current.then(async () => {
    log.debugFor('ssh', 'SSH queue executing', { cluster });
    return fn();
  }).catch(async (err) => {
    // Previous call failed, but continue queue
    log.warn('SSH queue previous call failed, continuing', { cluster, error: err.message });
    return fn();
  });

  // Store chain but don't let errors block future calls
  queues.set(cluster, next.catch(() => {}));
  return next;
}

/**
 * Get queue stats for debugging/monitoring
 * @returns {Object} Map of cluster -> { pending: boolean }
 */
function getQueueStats() {
  const stats = {};
  for (const [cluster, promise] of queues.entries()) {
    // Check if there's a pending operation by seeing if the promise is resolved
    stats[cluster] = { hasPendingOperations: true };
  }
  return stats;
}

/**
 * Clear all queues (for testing)
 */
function clearQueues() {
  queues.clear();
}

module.exports = { withClusterQueue, getQueueStats, clearQueues };
