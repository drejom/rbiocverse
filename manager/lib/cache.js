/**
 * Cluster Status Cache
 * Per-cluster caching to reduce SSH calls to HPC clusters
 */

const { log } = require('./logger');

// Default TTL: 30 minutes (invalidated on user actions)
const DEFAULT_CACHE_TTL = 1800000;

// Supported HPC clusters - add new clusters here
const DEFAULT_CLUSTERS = ['gemini', 'apollo'];

/**
 * Create a new cache manager for cluster status
 * @param {number} ttl - Cache TTL in milliseconds
 * @param {string[]} clusters - List of cluster names to cache
 * @returns {Object} Cache manager with get, set, invalidate methods
 */
function createClusterCache(ttl = DEFAULT_CACHE_TTL, clusters = DEFAULT_CLUSTERS) {
  // Initialize cache dynamically from cluster list
  const cache = Object.fromEntries(
    clusters.map(c => [c, { data: null, timestamp: 0 }])
  );

  return {
    /**
     * Get cached data for a cluster if valid
     * @param {string} cluster - Cluster name ('gemini' or 'apollo')
     * @returns {{ data: Object|null, age: number, valid: boolean }}
     */
    get(cluster) {
      if (!cache[cluster]) {
        return { data: null, age: Infinity, valid: false };
      }
      const now = Date.now();
      const age = now - cache[cluster].timestamp;
      const valid = cache[cluster].data !== null && age < ttl;
      return { data: cache[cluster].data, age, valid };
    },

    /**
     * Set cached data for a cluster
     * @param {string} cluster - Cluster name ('gemini' or 'apollo')
     * @param {Object} data - Data to cache
     */
    set(cluster, data) {
      if (!cache[cluster]) {
        log.warn(`Attempted to set cache for unknown cluster: ${cluster}`);
        return;
      }
      cache[cluster] = {
        data,
        timestamp: Date.now(),
      };
    },

    /**
     * Invalidate cache for a specific cluster or all clusters
     * @param {string|null} cluster - Cluster name or null for all
     */
    invalidate(cluster = null) {
      if (cluster && cache[cluster]) {
        cache[cluster].timestamp = 0;
        log.debug(`Status cache invalidated for ${cluster}`);
      } else if (cluster) {
        log.warn(`Attempted to invalidate cache for unknown cluster: ${cluster}`);
      } else {
        // Invalidate all clusters dynamically
        Object.keys(cache).forEach(clusterName => {
          cache[clusterName].timestamp = 0;
        });
        log.debug('Status cache invalidated for all clusters');
      }
    },

    /**
     * Get the TTL value
     * @returns {number} TTL in milliseconds
     */
    getTTL() {
      return ttl;
    },

    /**
     * Check if a cluster exists in cache
     * @param {string} cluster - Cluster name
     * @returns {boolean}
     */
    hasCluster(cluster) {
      return cluster in cache;
    },

    /**
     * Get all cluster names
     * @returns {string[]}
     */
    getClusters() {
      return Object.keys(cache);
    },
  };
}

module.exports = {
  createClusterCache,
  DEFAULT_CACHE_TTL,
  DEFAULT_CLUSTERS,
};
