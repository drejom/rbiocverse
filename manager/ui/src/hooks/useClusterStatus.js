/**
 * Custom hook for fetching and managing cluster status
 * Handles polling, caching, and state updates
 */
import { useState, useEffect, useCallback, useRef } from 'react';

const POLL_INTERVAL_MS = 2000;

export function useClusterStatus() {
  const [status, setStatus] = useState({
    gemini: {},
    apollo: {},
  });
  const [config, setConfig] = useState({
    ides: {},
    releases: {},
    defaultReleaseVersion: null,
    gpuConfig: {},
    partitionLimits: {},
    defaultPartitions: {},
    defaultCpus: '2',
    defaultMem: '40G',
    defaultTime: '12:00:00',
  });
  const [health, setHealth] = useState({
    gemini: null,
    apollo: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  // Track if we've received initial config (to skip static data on subsequent polls)
  const hasConfig = useRef(false);

  const fetchStatus = useCallback(async (forceRefresh = false) => {
    try {
      const params = new URLSearchParams();
      if (forceRefresh) params.set('refresh', 'true');
      if (hasConfig.current) params.set('hasLimits', 'true');

      const url = '/api/cluster-status' + (params.toString() ? '?' + params : '');
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();

      // Update config (only on first load or if present)
      if (data.ides || data.releases || data.gpuConfig) {
        hasConfig.current = true;
        setConfig(prev => ({
          ...prev,
          ides: data.ides || prev.ides,
          releases: data.releases || prev.releases,
          defaultReleaseVersion: data.defaultReleaseVersion || prev.defaultReleaseVersion,
          gpuConfig: data.gpuConfig || prev.gpuConfig,
          partitionLimits: data.partitionLimits || prev.partitionLimits,
          defaultPartitions: data.defaultPartitions || prev.defaultPartitions,
          defaultCpus: data.defaultCpus || prev.defaultCpus,
          defaultMem: data.defaultMem || prev.defaultMem,
          defaultTime: data.defaultTime || prev.defaultTime,
        }));
      }

      // Update cluster status
      setStatus({
        gemini: data.gemini || {},
        apollo: data.apollo || {},
      });

      // Update health
      if (data.clusterHealth) {
        setHealth({
          gemini: data.clusterHealth.gemini?.current || null,
          apollo: data.clusterHealth.apollo?.current || null,
        });
      }

      setLastUpdate(new Date());
      setError(null);
    } catch (e) {
      console.error('Status fetch error:', e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Polling - fetchStatus is stable (useCallback with []) so interval won't be recreated
  useEffect(() => {
    const interval = setInterval(() => fetchStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Visibility handling - refresh when tab becomes visible
  // fetchStatus is stable (useCallback with []) so listener won't be recreated
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        fetchStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [fetchStatus]);

  const refresh = useCallback(() => fetchStatus(true), [fetchStatus]);

  return {
    status,
    config,
    health,
    loading,
    error,
    lastUpdate,
    refresh,
  };
}
