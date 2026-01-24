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

import { log } from './logger';

interface QueueStats {
  [cluster: string]: { hasQueueChain: boolean };
}

// Per-cluster promise chains - strict serialization
const queues = new Map<string, Promise<void>>();

/**
 * Execute a function within the cluster's SSH queue
 * Ensures only one SSH call runs at a time per cluster
 *
 * @param cluster - Cluster name ('gemini' or 'apollo')
 * @param fn - Async function to execute
 * @returns Result of the function
 */
async function withClusterQueue<T>(cluster: string, fn: () => Promise<T>): Promise<T> {
  const current = queues.get(cluster) || Promise.resolve();

  const next = current.then(async () => {
    log.debugFor('ssh', 'SSH queue executing', { cluster });
    return fn();
  });

  // Store a promise that always resolves, so failures don't block subsequent operations
  // The original promise (next) is returned to caller so they receive any rejection
  queues.set(cluster, next.catch((err: Error) => {
    log.warn('SSH queue operation failed; continuing queue.', { cluster, error: err.message });
  }) as Promise<void>);

  return next;
}

/**
 * Get queue stats for debugging/monitoring
 * @returns Map of cluster -> { hasQueueChain: boolean }
 */
function getQueueStats(): QueueStats {
  const stats: QueueStats = {};
  for (const cluster of queues.keys()) {
    // This indicates a promise chain exists for this cluster.
    // It may have pending operations or may be idle - precise tracking
    // would require counting pending operations explicitly.
    stats[cluster] = { hasQueueChain: true };
  }
  return stats;
}

/**
 * Clear all queues (for testing)
 */
function clearQueues(): void {
  queues.clear();
}

export { withClusterQueue, getQueueStats, clearQueues };
