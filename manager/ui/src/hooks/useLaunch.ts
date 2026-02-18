/**
 * Custom hook for launching and connecting to IDE sessions
 * Handles SSE streaming for progress updates
 */
import { useState, useCallback, useRef } from 'react';
import type { IdeConfig, LaunchState } from '../types';

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
  launchState: LaunchState & { hpc: string | null; ide: string | null };
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

export function useLaunch(
  ides: Record<string, IdeConfig>,
  onRefresh?: () => void
): UseLaunchReturn {
  const [launchState, setLaunchState] = useState<LaunchState & { hpc: string | null; ide: string | null }>({
    active: false,
    hpc: null,
    ide: null,
    header: '',
    message: '',
    progress: 0,
    step: 'connecting',
    error: null,
    pending: false,
    indeterminate: false,
    isSshError: false,
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const cancelledRef = useRef(false);
  const connectRef = useRef<((hpc: string, ide: string) => void) | null>(null);

  const resetState = useCallback(() => {
    setLaunchState({
      active: false,
      hpc: null,
      ide: null,
      header: '',
      message: '',
      progress: 0,
      step: 'connecting',
      error: null,
      pending: false,
      indeterminate: false,
      isSshError: false,
    });
  }, []);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const launch = useCallback((hpc: string, ide: string, options: LaunchOptions) => {
    const ideName = ides[ide]?.name || ide;
    cancelledRef.current = false;

    setLaunchState({
      active: true,
      hpc,
      ide,
      header: `Starting ${ideName}...`,
      message: 'Connecting...',
      progress: 0,
      step: 'connecting',
      error: null,
      pending: false,
      indeterminate: false,
      isSshError: false,
    });

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
          case 'progress':
            setLaunchState((prev) => ({
              ...prev,
              message: data.message || prev.message,
              progress: data.progress ?? prev.progress,
              step: data.step || prev.step,
            }));
            break;

          case 'pending':
          case 'pending-timeout':
            // Job is pending - show brief message, then check if it started running
            closeEventSource();
            setLaunchState((prev) => ({
              ...prev,
              step: 'pending',
              progress: 100,
              message: 'Job queued - waiting for resources',
              pending: true,
            }));
            // After delay, check status - if running, auto-connect; otherwise show pending card
            setTimeout(async () => {
              try {
                const statusRes = await fetch('/api/cluster-status');
                const statusData = await statusRes.json();
                const ideStatus = statusData[hpc]?.[ide];

                if (ideStatus?.status === 'running') {
                  // Job started! Auto-connect to it
                  resetState();
                  connectRef.current?.(hpc, ide);
                } else {
                  // Still pending - show pending card
                  resetState();
                  onRefresh?.();
                }
              } catch {
                // On error, just show pending card
                resetState();
                onRefresh?.();
              }
            }, 2000);
            break;

          case 'complete':
            closeEventSource();
            resetState();
            window.location.href = data.redirectUrl || '/code/';
            break;

          case 'error':
            closeEventSource();
            if (data.message?.includes('already')) {
              resetState();
              if (confirm(`${hpc} already has ${ideName} running. Connect to it?`)) {
                // Use ref to call connect (defined after launch)
                connectRef.current?.(hpc, ide);
              }
            } else {
              const sshErr = isSshError(data.message);
              setLaunchState((prev) => ({
                ...prev,
                error: data.message || 'Unknown error',
                header: 'Launch Failed',
                isSshError: sshErr,
              }));
              // Don't auto-dismiss for SSH errors - user needs to take action
              if (!sshErr) {
                setTimeout(() => {
                  resetState();
                }, ERROR_DISPLAY_MS);
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
      resetState();
    };
  }, [ides, closeEventSource, resetState, onRefresh]);

  const connect = useCallback((hpc: string, ide: string) => {
    const ideName = ides[ide]?.name || ide;
    cancelledRef.current = false;

    setLaunchState({
      active: true,
      hpc,
      ide,
      header: `Connecting to ${ideName}...`,
      message: 'Connecting...',
      progress: 0,
      step: 'connecting',
      error: null,
      pending: false,
      indeterminate: false,
      isSshError: false,
    });

    const url = `/api/launch/${hpc}/${ide}/stream`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event: MessageEvent) => {
      if (cancelledRef.current) return;

      try {
        const data: SseMessage = JSON.parse(event.data);

        switch (data.type) {
          case 'progress':
            setLaunchState((prev) => ({
              ...prev,
              message: data.message || prev.message,
              progress: data.progress ?? prev.progress,
              step: data.step || prev.step,
            }));
            break;

          case 'complete':
            closeEventSource();
            resetState();
            window.location.href = data.redirectUrl || '/code/';
            break;

          case 'error':
            closeEventSource();
            const sshErr = isSshError(data.message);
            setLaunchState((prev) => ({
              ...prev,
              error: data.message || 'Unknown error',
              header: 'Connection Failed',
              isSshError: sshErr,
            }));
            // Don't auto-dismiss for SSH errors - user needs to take action
            if (!sshErr) {
              setTimeout(() => {
                resetState();
              }, ERROR_DISPLAY_MS);
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
      resetState();
    };
  }, [ides, closeEventSource, resetState]);

  // Keep ref updated for use in launch callback
  connectRef.current = connect;

  const backToMenu = useCallback(() => {
    cancelledRef.current = true;
    closeEventSource();
    resetState();
    onRefresh?.();
  }, [closeEventSource, resetState, onRefresh]);

  const stopLaunch = useCallback(async () => {
    const { hpc, ide } = launchState;
    if (!hpc || !ide) return;

    cancelledRef.current = true;
    closeEventSource();

    setLaunchState((prev) => ({
      ...prev,
      header: `Stopping ${ides[ide]?.name || ide}...`,
      message: 'Stopping job...',
      indeterminate: true,
    }));

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
    } catch (e) {
      console.error('Stop error:', e);
    }

    resetState();
    onRefresh?.();
  }, [launchState, ides, closeEventSource, resetState, onRefresh]);

  return {
    launchState,
    launch,
    connect,
    backToMenu,
    stopLaunch,
  };
}

export default useLaunch;
