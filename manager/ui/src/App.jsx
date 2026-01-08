/**
 * HPC Code Server Launcher - Main App Component
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useClusterStatus } from './hooks/useClusterStatus';
import { useCountdown } from './hooks/useCountdown';
import { useLaunch } from './hooks/useLaunch';
import ClusterCard from './components/ClusterCard';
import LoadingOverlay from './components/LoadingOverlay';
import './styles/index.css';

// Fallback timeout for stop operation (SLURM scancel + tunnel cleanup)
const STOP_TIMEOUT_MS = 15000;

// Fixed cluster list - backend only supports these two clusters
// Could be derived from API in future if dynamic clusters are needed
const CLUSTER_NAMES = ['gemini', 'apollo'];

function App() {
  const { status, config, health, history, loading, refresh } = useClusterStatus();
  const { getCountdown } = useCountdown(status);
  const { launchState, launch, connect, backToMenu, stopLaunch } = useLaunch(config.ides, refresh);

  const [stoppingJobs, setStoppingJobs] = useState({});
  const [error, setError] = useState(null);

  // Track active EventSources for cleanup on unmount
  const stopEventSourcesRef = useRef(new Map());

  // Cleanup all EventSources on unmount
  useEffect(() => {
    return () => {
      stopEventSourcesRef.current.forEach((es) => es.close());
      stopEventSourcesRef.current.clear();
    };
  }, []);

  const handleLaunch = useCallback((hpc, ide, options) => {
    setError(null);
    launch(hpc, ide, options);
  }, [launch]);

  const handleConnect = useCallback((hpc, ide) => {
    setError(null);
    connect(hpc, ide);
  }, [connect]);

  // Note: Using native confirm() is intentional - it's simple, accessible, and
  // sufficient for this low-frequency action. A custom modal would add complexity.
  const handleStop = useCallback((hpc, ide) => {
    const key = `${hpc}-${ide}`;
    const ideName = config.ides?.[ide]?.name || ide;

    if (stoppingJobs[key]) return;
    if (!confirm(`Stop ${ideName} on ${hpc}?`)) return;

    setStoppingJobs((prev) => ({ ...prev, [key]: true }));

    // Use SSE for progress
    const eventSource = new EventSource(`/api/stop/${hpc}/${ide}/stream`);
    stopEventSourcesRef.current.set(key, eventSource);

    const cleanup = () => {
      setStoppingJobs((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      eventSource.close();
      stopEventSourcesRef.current.delete(key);
      refresh();
    };

    const timeout = setTimeout(cleanup, STOP_TIMEOUT_MS);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'complete' || data.type === 'error') {
          clearTimeout(timeout);
          if (data.type === 'error') {
            setError(`Failed to stop job: ${data.message || 'Unknown error'}`);
          }
          cleanup();
        }
      } catch (e) {
        console.error('Stop SSE parse error:', e);
      }
    };

    eventSource.onerror = () => {
      clearTimeout(timeout);
      cleanup();
    };
  }, [config, stoppingJobs, refresh]);

  if (loading && !config.ides) {
    return (
      <div className="launcher">
        <div className="loading-content">
          <div className="spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="launcher">
        <div className="launcher-header">
          <div>
            <h1>HPC Code Server</h1>
            <p className="subtitle">VS Code on SLURM compute nodes</p>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        {CLUSTER_NAMES.map((hpc) => (
          <ClusterCard
            key={hpc}
            hpc={hpc}
            ideStatuses={status[hpc]}
            health={health[hpc]}
            history={history[hpc]}
            config={config}
            countdown={getCountdown}
            stoppingJobs={stoppingJobs}
            onLaunch={handleLaunch}
            onConnect={handleConnect}
            onStop={handleStop}
          />
        ))}
      </div>

      <LoadingOverlay
        visible={launchState.active}
        header={launchState.header}
        message={launchState.message}
        progress={launchState.progress}
        step={launchState.step}
        error={launchState.error}
        pending={launchState.pending}
        indeterminate={launchState.indeterminate}
        onBack={backToMenu}
        onCancel={stopLaunch}
      />
    </>
  );
}

export default App;
