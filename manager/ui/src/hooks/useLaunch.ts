/**
 * Custom hook for launching and connecting to IDE sessions
 * Handles SSE streaming for progress updates
 *
 * Refactored to use SessionStateContext as single source of truth.
 * SSE events update the shared context, eliminating timing hacks.
 */
import { useCallback, useRef } from 'react';
import { useSessionState, type LaunchModalState } from '../contexts/SessionStateContext';
import type { IdeConfig } from '../types';

// Duration to display error message before auto-dismissing
const ERROR_DISPLAY_MS = 5000;

// Patterns that indicate SSH authentication/connection issues
const SSH_ERROR_PATTERNS = [
  'permission denied',
  'authentication failed',
  'connection refused',
  'host key verification failed',
  'ssh connection',
  'ssh error',
  'ssh:',
];

interface LaunchOptions {
  cpus: string;
  mem: string;
  time: string;
  releaseVersion: string;
  gpu?: string;
}

interface SseMessage {
  type: 'progress' | 'pending' | 'pending-timeout' | 'complete' | 'error';
  message?: string;
  progress?: number;
  step?: string;
  redirectUrl?: string;
  startTime?: string;  // SLURM estimated start time for pending jobs
  jobId?: string;
}

interface UseLaunchReturn {
  launchModal: LaunchModalState | null;
  launch: (hpc: string, ide: string, options: LaunchOptions) => void;
  connect: (hpc: string, ide: string) => void;
  backToMenu: () => void;
  stopLaunch: () => Promise<void>;
}

/**
 * Check if an error message indicates an SSH issue
 */
function isSshError(message: string | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return SSH_ERROR_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * Create initial modal state for a launch/connect operation
 */
function createInitialModalState(hpc: string, ide: string, header: string): LaunchModalState {
  return {
    active: true,
    hpc,
    ide,
    header,
    message: 'Connecting...',
    progress: 0,
    step: 'connecting',
    error: null,
    pending: false,
    indeterminate: false,
    isSshError: false,
  };
}

export function useLaunch(ides: Record<string, IdeConfig>): UseLaunchReturn {
  const {
    launchModal,
    setLaunchModal,
    updateLaunchModal,
    updateSession,
  } = useSessionState();

  const eventSourceRef = useRef<EventSource | null>(null);
  const cancelledRef = useRef(false);
  const connectRef = useRef<((hpc: string, ide: string) => void) | null>(null);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const resetModal = useCallback(() => {
    setLaunchModal(null);
  }, [setLaunchModal]);

  const launch = useCallback((hpc: string, ide: string, options: LaunchOptions) => {
    const ideName = ides[ide]?.name || ide;
    cancelledRef.current = false;

    setLaunchModal(createInitialModalState(hpc, ide, `Starting ${ideName}...`));

    // Build URL with params
    const params = new URLSearchParams({
      cpus: options.cpus,
      mem: options.mem,
      time: options.time,
      releaseVersion: options.releaseVersion,
    });
    if (options.gpu) params.set('gpu', options.gpu);

    const url = `/api/launch/${hpc}/${ide}/stream?${params}`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event: MessageEvent) => {
      if (cancelledRef.current) return;

      try {
        const data: SseMessage = JSON.parse(event.data);

        switch (data.type) {
          case 'progress': {
            const updates: Partial<LaunchModalState> = {
              message: data.message || undefined,
              step: data.step || undefined,
            };
            if (typeof data.progress === 'number') {
              updates.progress = data.progress;
            }
            updateLaunchModal(updates);
            break;
          }

          case 'pending':
          case 'pending-timeout':
            // Job is pending - update session state with estimatedStartTime
            closeEventSource();

            // KEY FIX: Store estimatedStartTime in shared context immediately
            updateSession(hpc, ide, {
              status: 'pending',
              jobId: data.jobId,
              estimatedStartTime: data.startTime || null,
            });

            // Show pending state briefly in modal, then close
            // No timing hack needed - session context already has the data
            updateLaunchModal({
              step: 'pending',
              progress: 100,
              message: 'Job queued - waiting for resources',
              pending: true,
            });

            // Quick status check - if job started running, auto-connect
            // Otherwise close modal (session card will show pending state from context)
            setTimeout(async () => {
              if (cancelledRef.current) return;
              try {
                const statusRes = await fetch('/api/cluster-status');
                const statusData = await statusRes.json();
                const ideStatus = statusData[hpc]?.[ide];

                if (ideStatus?.status === 'running') {
                  // Job started! Auto-connect to it
                  resetModal();
                  connectRef.current?.(hpc, ide);
                } else {
                  // Still pending - close modal, session card shows pending from context
                  resetModal();
                }
              } catch {
                // On error, just close modal
                resetModal();
              }
            }, 500); // Reduced from 1500ms - just a quick check
            break;

          case 'complete':
            closeEventSource();
            resetModal();
            window.location.href = data.redirectUrl || '/code/';
            break;

          case 'error':
            closeEventSource();
            if (data.message?.includes('already')) {
              resetModal();
              const ideName = ides[ide]?.name || ide;
              if (confirm(`${hpc} already has ${ideName} running. Connect to it?`)) {
                connectRef.current?.(hpc, ide);
              }
            } else {
              const sshErr = isSshError(data.message);
              updateLaunchModal({
                error: data.message || 'Unknown error',
                header: 'Launch Failed',
                isSshError: sshErr,
              });
              // Don't auto-dismiss for SSH errors - user needs to take action
              if (!sshErr) {
                setTimeout(resetModal, ERROR_DISPLAY_MS);
              }
            }
            break;
        }
      } catch (e) {
        console.error('Failed to parse SSE data:', e);
      }
    };

    eventSource.onerror = () => {
      if (cancelledRef.current) return;
      closeEventSource();
      resetModal();
    };
  }, [ides, closeEventSource, resetModal, setLaunchModal, updateLaunchModal, updateSession]);

  const connect = useCallback((hpc: string, ide: string) => {
    const ideName = ides[ide]?.name || ide;
    cancelledRef.current = false;

    setLaunchModal(createInitialModalState(hpc, ide, `Connecting to ${ideName}...`));

    const url = `/api/launch/${hpc}/${ide}/stream`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event: MessageEvent) => {
      if (cancelledRef.current) return;

      try {
        const data: SseMessage = JSON.parse(event.data);

        switch (data.type) {
          case 'progress': {
            const updates: Partial<LaunchModalState> = {
              message: data.message || undefined,
              step: data.step || undefined,
            };
            if (typeof data.progress === 'number') {
              updates.progress = data.progress;
            }
            updateLaunchModal(updates);
            break;
          }

          case 'complete':
            closeEventSource();
            resetModal();
            window.location.href = data.redirectUrl || '/code/';
            break;

          case 'error':
            closeEventSource();
            const sshErr = isSshError(data.message);
            updateLaunchModal({
              error: data.message || 'Unknown error',
              header: 'Connection Failed',
              isSshError: sshErr,
            });
            // Don't auto-dismiss for SSH errors - user needs to take action
            if (!sshErr) {
              setTimeout(resetModal, ERROR_DISPLAY_MS);
            }
            break;
        }
      } catch (e) {
        console.error('Failed to parse SSE data:', e);
      }
    };

    eventSource.onerror = () => {
      if (cancelledRef.current) return;
      closeEventSource();
      resetModal();
    };
  }, [ides, closeEventSource, resetModal, setLaunchModal, updateLaunchModal]);

  // Keep ref updated for use in launch callback
  connectRef.current = connect;

  const backToMenu = useCallback(() => {
    cancelledRef.current = true;
    closeEventSource();
    resetModal();
  }, [closeEventSource, resetModal]);

  const stopLaunch = useCallback(async () => {
    if (!launchModal?.hpc || !launchModal?.ide) return;
    const { hpc, ide } = launchModal;

    cancelledRef.current = true;
    closeEventSource();

    updateLaunchModal({
      header: `Stopping ${ides[ide]?.name || ide}...`,
      message: 'Stopping job...',
      indeterminate: true,
    });

    try {
      const res = await fetch(`/api/stop/${hpc}/${ide}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelJob: true }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server returned ${res.status}`);
      }

      // Clear session from context immediately so UI updates without waiting for poll
      updateSession(hpc, ide, { status: 'idle' });
    } catch (e) {
      console.error('Stop error:', e);
    }

    resetModal();
  }, [launchModal, ides, closeEventSource, resetModal, updateLaunchModal, updateSession]);

  return {
    launchModal,
    launch,
    connect,
    backToMenu,
    stopLaunch,
  };
}

export default useLaunch;
