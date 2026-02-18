/**
 * SessionStateContext - Shared state for session management
 *
 * Single source of truth for:
 * - Session state (status, jobId, estimatedStartTime, etc.)
 * - Launch modal state (progress, messages, errors)
 *
 * Both SSE events (useLaunch) and polling (useClusterStatus) write here.
 * Components read from here instead of maintaining separate state.
 */
import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';

/**
 * Session state for a single HPC/IDE combination
 * Merges data from SSE events and polling
 */
export interface SessionState {
  status: 'idle' | 'pending' | 'running' | 'stopping' | 'error';
  jobId?: string;
  node?: string;
  cpus?: number | string;
  memory?: string;
  gpu?: string | null;
  releaseVersion?: string | null;
  estimatedStartTime?: string | null;
  timeLeftSeconds?: number;
  timeLimitSeconds?: number;
  startTime?: string;
  error?: string | null;
}

/**
 * Launch modal state - controls the LoadingOverlay component
 */
export interface LaunchModalState {
  active: boolean;
  hpc: string;
  ide: string;
  header: string;
  message: string;
  progress: number;
  step: string;
  error: string | null;
  pending: boolean;
  indeterminate: boolean;
  isSshError: boolean;
}

/**
 * Context value interface
 */
interface SessionStateContextValue {
  // Session data indexed by "hpc-ide" key
  sessions: Record<string, SessionState>;

  // Update a session (merges with existing state)
  updateSession: (hpc: string, ide: string, updates: Partial<SessionState>) => void;

  // Get session by hpc/ide (returns null if not found)
  getSession: (hpc: string, ide: string) => SessionState | null;

  // Clear a session (resets to idle)
  clearSession: (hpc: string, ide: string) => void;

  // Batch update sessions from polling (replaces all for a cluster)
  updateSessionsFromPoll: (hpc: string, ideStatuses: Record<string, Partial<SessionState>>) => void;

  // Launch modal state
  launchModal: LaunchModalState | null;

  // Update launch modal (null to close)
  setLaunchModal: (state: LaunchModalState | null) => void;

  // Update launch modal partially (for progress updates)
  updateLaunchModal: (updates: Partial<LaunchModalState>) => void;
}

const SessionStateContext = createContext<SessionStateContextValue | null>(null);

/**
 * Build session key from hpc and ide
 */
function buildKey(hpc: string, ide: string): string {
  return `${hpc}-${ide}`;
}

/**
 * Default idle session state
 */
const defaultSession: SessionState = {
  status: 'idle',
};

/**
 * SessionStateProvider - Wrap your app with this to enable shared session state
 */
export function SessionStateProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [launchModal, setLaunchModalState] = useState<LaunchModalState | null>(null);

  const updateSession = useCallback((hpc: string, ide: string, updates: Partial<SessionState>) => {
    const key = buildKey(hpc, ide);
    setSessions(prev => ({
      ...prev,
      [key]: {
        ...(prev[key] || defaultSession),
        ...updates,
      },
    }));
  }, []);

  const getSession = useCallback((hpc: string, ide: string): SessionState | null => {
    const key = buildKey(hpc, ide);
    return sessions[key] || null;
  }, [sessions]);

  const clearSession = useCallback((hpc: string, ide: string) => {
    const key = buildKey(hpc, ide);
    setSessions(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const updateSessionsFromPoll = useCallback((hpc: string, ideStatuses: Record<string, Partial<SessionState>>) => {
    setSessions(prev => {
      const next = { ...prev };
      const hpcPrefix = `${hpc}-`;

      // First, handle IDEs that are in the poll data
      for (const [ide, status] of Object.entries(ideStatuses)) {
        const key = buildKey(hpc, ide);
        const existing = prev[key];

        // CRITICAL: Don't let stale poll data overwrite SSE-sourced pending status
        // If context has pending (from SSE) and poll says idle, keep pending until poll catches up
        const shouldKeepExistingStatus = (
          existing?.status === 'pending' &&
          status.status === 'idle'
        );

        next[key] = {
          ...(existing || defaultSession),
          ...status,
          // Keep pending status if poll hasn't caught up yet
          status: shouldKeepExistingStatus ? existing.status : (status.status || existing?.status || 'idle'),
          // Preserve estimatedStartTime from SSE if poll doesn't have it
          estimatedStartTime: status.estimatedStartTime ?? existing?.estimatedStartTime ?? null,
          // Preserve jobId from SSE if poll doesn't have it
          jobId: status.jobId ?? existing?.jobId,
        };
      }

      // Clear zombie sessions: reset any sessions for this HPC that are no longer in poll data
      // But preserve pending sessions that may not have appeared in poll yet (SSE race)
      for (const key of Object.keys(prev)) {
        if (key.startsWith(hpcPrefix)) {
          const ide = key.slice(hpcPrefix.length);
          const existing = prev[key];
          // If IDE not in poll data and not pending, reset to idle
          if (!(ide in ideStatuses) && existing?.status !== 'pending') {
            next[key] = defaultSession;
          }
        }
      }

      return next;
    });
  }, []);

  const setLaunchModal = useCallback((state: LaunchModalState | null) => {
    setLaunchModalState(state);
  }, []);

  const updateLaunchModal = useCallback((updates: Partial<LaunchModalState>) => {
    setLaunchModalState(prev => {
      if (!prev) return null;
      return { ...prev, ...updates };
    });
  }, []);

  const value = useMemo<SessionStateContextValue>(() => ({
    sessions,
    updateSession,
    getSession,
    clearSession,
    updateSessionsFromPoll,
    launchModal,
    setLaunchModal,
    updateLaunchModal,
  }), [sessions, updateSession, getSession, clearSession, updateSessionsFromPoll, launchModal, setLaunchModal, updateLaunchModal]);

  return (
    <SessionStateContext.Provider value={value}>
      {children}
    </SessionStateContext.Provider>
  );
}

/**
 * Hook to access session state context
 * @throws Error if used outside SessionStateProvider
 */
export function useSessionState(): SessionStateContextValue {
  const context = useContext(SessionStateContext);
  if (!context) {
    throw new Error('useSessionState must be used within a SessionStateProvider');
  }
  return context;
}

export default SessionStateContext;
