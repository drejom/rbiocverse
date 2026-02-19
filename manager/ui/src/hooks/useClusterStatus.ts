/**
 * Custom hook for fetching and managing cluster status
 * Handles polling, caching, and state updates
 *
 * Also updates SessionStateContext with session data from polling,
 * ensuring shared state stays in sync with backend.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { ClusterStatus, ClusterConfig, ClusterHealth, ClusterHistoryPoint, IdeStatus } from '../types';
import log from '../lib/logger';
import { useSessionState, type SessionState } from '../contexts/SessionStateContext';

const POLL_INTERVAL_MS = 2000;

export interface ClusterHealthState {
  gemini: ClusterHealth | null;
  apollo: ClusterHealth | null;
  [key: string]: ClusterHealth | null;
}

export interface ClusterHistoryState {
  gemini: ClusterHistoryPoint[];
  apollo: ClusterHistoryPoint[];
  [key: string]: ClusterHistoryPoint[];
}

interface UseClusterStatusReturn {
  status: ClusterStatus;
  config: ClusterConfig;
  health: ClusterHealthState;
  history: ClusterHistoryState;
  loading: boolean;
  error: string | null;
  lastUpdate: Date | null;
  refresh: () => void;
}

interface ClusterStatusResponse {
  gemini?: Record<string, unknown>;
  apollo?: Record<string, unknown>;
  ides?: Record<string, unknown>;
  releases?: Record<string, unknown>;
  defaultReleaseVersion?: string;
  gpuConfig?: Record<string, unknown>;
  partitionLimits?: Record<string, Record<string, unknown>>;
  defaultPartitions?: Record<string, string>;
  defaultCpus?: string;
  defaultMem?: string;
  defaultTime?: string;
  clusterHealth?: {
    gemini?: { current?: ClusterHealth; history?: ClusterHistoryPoint[] };
    apollo?: { current?: ClusterHealth; history?: ClusterHistoryPoint[] };
  };
}

export function useClusterStatus(): UseClusterStatusReturn {
  const { updateSessionsFromPoll } = useSessionState();

  const [status, setStatus] = useState<ClusterStatus>({
    gemini: {},
    apollo: {},
  });
  const [config, setConfig] = useState<ClusterConfig>({
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
  const [health, setHealth] = useState<ClusterHealthState>({
    gemini: null,
    apollo: null,
  });
  const [history, setHistory] = useState<ClusterHistoryState>({
    gemini: [],
    apollo: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

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

      const data: ClusterStatusResponse = await res.json();

      // Update config (only on first load or if present)
      if (data.ides || data.releases || data.gpuConfig) {
        hasConfig.current = true;
        setConfig(prev => ({
          ...prev,
          ides: (data.ides || prev.ides) as ClusterConfig['ides'],
          releases: (data.releases || prev.releases) as ClusterConfig['releases'],
          defaultReleaseVersion: data.defaultReleaseVersion || prev.defaultReleaseVersion,
          gpuConfig: (data.gpuConfig || prev.gpuConfig) as ClusterConfig['gpuConfig'],
          partitionLimits: (data.partitionLimits || prev.partitionLimits) as ClusterConfig['partitionLimits'],
          defaultPartitions: (data.defaultPartitions || prev.defaultPartitions) as ClusterConfig['defaultPartitions'],
          defaultCpus: data.defaultCpus || prev.defaultCpus,
          defaultMem: data.defaultMem || prev.defaultMem,
          defaultTime: data.defaultTime || prev.defaultTime,
        }));
      }

      // Update cluster status
      const geminiStatus = (data.gemini || {}) as ClusterStatus['gemini'];
      const apolloStatus = (data.apollo || {}) as ClusterStatus['apollo'];

      setStatus({
        gemini: geminiStatus,
        apollo: apolloStatus,
      });

      // Update shared session state context with poll data
      // This keeps SSE-sourced data (like estimatedStartTime) in sync with polling
      const convertToSessionState = (ideStatus: IdeStatus): Partial<SessionState> => ({
        status: ideStatus.status || 'idle',
        jobId: ideStatus.jobId,
        node: ideStatus.node,
        cpus: ideStatus.cpus,
        memory: ideStatus.memory,
        gpu: ideStatus.gpu,
        releaseVersion: ideStatus.releaseVersion,
        estimatedStartTime: ideStatus.estimatedStartTime,
        timeLeftSeconds: ideStatus.timeLeftSeconds,
        timeLimitSeconds: ideStatus.timeLimitSeconds,
        startTime: ideStatus.startTime,
      });

      // Update context for each cluster's IDEs
      const geminiSessions: Record<string, Partial<SessionState>> = {};
      for (const [ide, ideStatus] of Object.entries(geminiStatus)) {
        geminiSessions[ide] = convertToSessionState(ideStatus);
      }
      updateSessionsFromPoll('gemini', geminiSessions);

      const apolloSessions: Record<string, Partial<SessionState>> = {};
      for (const [ide, ideStatus] of Object.entries(apolloStatus)) {
        apolloSessions[ide] = convertToSessionState(ideStatus);
      }
      updateSessionsFromPoll('apollo', apolloSessions);

      // Update health and history
      if (data.clusterHealth) {
        setHealth({
          gemini: data.clusterHealth.gemini?.current || null,
          apollo: data.clusterHealth.apollo?.current || null,
        });
        setHistory({
          gemini: data.clusterHealth.gemini?.history || [],
          apollo: data.clusterHealth.apollo?.history || [],
        });
      }

      setLastUpdate(new Date());
      setError(null);
    } catch (e) {
      log.error('Status fetch error', { error: e });
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [updateSessionsFromPoll]);

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

  // Listen for refresh-status events (e.g., from Stop All Jobs)
  useEffect(() => {
    const handleRefresh = () => fetchStatus(true);
    window.addEventListener('refresh-status', handleRefresh);
    return () => window.removeEventListener('refresh-status', handleRefresh);
  }, [fetchStatus]);

  const refresh = useCallback(() => fetchStatus(true), [fetchStatus]);

  return {
    status,
    config,
    health,
    history,
    loading,
    error,
    lastUpdate,
    refresh,
  };
}
