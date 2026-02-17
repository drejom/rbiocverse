/**
 * Cluster Status Cache
 * Per-cluster caching to reduce SSH calls to HPC clusters
 */

import { log } from './logger';

// Default TTL: 30 minutes (invalidated on user actions)
export const DEFAULT_CACHE_TTL = 1800000;

// Supported HPC clusters - add new clusters here
export const DEFAULT_CLUSTERS = ['gemini', 'apollo'];

interface CacheEntry<T> {
  data: T | null;
  timestamp: number;
}

interface CacheResult<T> {
  data: T | null;
  age: number;
  valid: boolean;
}

export interface ClusterCache<T = unknown> {
  get(cluster: string): CacheResult<T>;
  set(cluster: string, data: T): void;
  invalidate(cluster?: string | null): void;
  getTTL(): number;
  hasCluster(cluster: string): boolean;
  getClusters(): string[];
}

/**
 * Create a new cache manager for cluster status
 * @param ttl - Cache TTL in milliseconds
 * @param clusters - List of cluster names to cache
 * @returns Cache manager with get, set, invalidate methods
 */
export function createClusterCache<T = unknown>(
  ttl: number = DEFAULT_CACHE_TTL,
  clusters: string[] = DEFAULT_CLUSTERS
): ClusterCache<T> {
  // Initialize cache dynamically from cluster list
  const cache: Record<string, CacheEntry<T>> = Object.fromEntries(
    clusters.map(c => [c, { data: null, timestamp: 0 }])
  );

  return {
    /**
     * Get cached data for a cluster if valid
     * @param cluster - Cluster name ('gemini' or 'apollo')
     * @returns Cache result with data, age, and validity flag
     */
    get(cluster: string): CacheResult<T> {
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
     * @param cluster - Cluster name ('gemini' or 'apollo')
     * @param data - Data to cache
     */
    set(cluster: string, data: T): void {
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
     * @param cluster - Cluster name or null for all
     */
    invalidate(cluster: string | null = null): void {
      if (cluster && cache[cluster]) {
        cache[cluster].timestamp = 0;
        log.debugFor('cache', `invalidated for ${cluster}`);
      } else if (cluster) {
        log.warn(`Attempted to invalidate cache for unknown cluster: ${cluster}`);
      } else {
        // Invalidate all clusters dynamically
        Object.keys(cache).forEach(clusterName => {
          cache[clusterName].timestamp = 0;
        });
        log.debugFor('cache', 'invalidated for all clusters');
      }
    },

    /**
     * Get the TTL value
     * @returns TTL in milliseconds
     */
    getTTL(): number {
      return ttl;
    },

    /**
     * Check if a cluster exists in cache
     * @param cluster - Cluster name
     * @returns Whether cluster exists in cache
     */
    hasCluster(cluster: string): boolean {
      return cluster in cache;
    },

    /**
     * Get all cluster names
     * @returns Array of cluster names
     */
    getClusters(): string[] {
      return Object.keys(cache);
    },
  };
}

// CommonJS compatibility for existing require() calls
module.exports = { createClusterCache, DEFAULT_CACHE_TTL, DEFAULT_CLUSTERS };
