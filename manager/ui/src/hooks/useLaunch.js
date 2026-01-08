/**
 * Custom hook for launching and connecting to IDE sessions
 * Handles SSE streaming for progress updates
 */
import { useState, useCallback, useRef } from 'react';

// Duration to display error message before auto-dismissing
const ERROR_DISPLAY_MS = 5000;

export function useLaunch(ides, onRefresh) {
  const [launchState, setLaunchState] = useState({
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
  });

  const eventSourceRef = useRef(null);
  const cancelledRef = useRef(false);
  const connectRef = useRef(null);

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
    });
  }, []);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const launch = useCallback((hpc, ide, options) => {
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

    eventSource.onmessage = (event) => {
      if (cancelledRef.current) return;

      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'progress':
            setLaunchState((prev) => ({
              ...prev,
              message: data.message,
              progress: data.progress,
              step: data.step,
            }));
            break;

          case 'pending-timeout':
            closeEventSource();
            resetState();
            onRefresh?.();
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
              setLaunchState((prev) => ({
                ...prev,
                error: data.message,
                header: 'Launch Failed',
              }));
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
  }, [ides, closeEventSource, resetState, onRefresh]);

  const connect = useCallback((hpc, ide) => {
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
    });

    const url = `/api/launch/${hpc}/${ide}/stream`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      if (cancelledRef.current) return;

      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'progress':
            setLaunchState((prev) => ({
              ...prev,
              message: data.message,
              progress: data.progress,
              step: data.step,
            }));
            break;

          case 'complete':
            closeEventSource();
            resetState();
            window.location.href = data.redirectUrl || '/code/';
            break;

          case 'error':
            closeEventSource();
            setLaunchState((prev) => ({
              ...prev,
              error: data.message,
              header: 'Connection Failed',
            }));
            setTimeout(() => {
              resetState();
            }, ERROR_DISPLAY_MS);
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
