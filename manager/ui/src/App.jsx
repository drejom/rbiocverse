/**
 * rbiocverse Launcher - Main App Component
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useClusterStatus } from './hooks/useClusterStatus';
import { useCountdown } from './hooks/useCountdown';
import { useLaunch } from './hooks/useLaunch';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import ClusterCard from './components/ClusterCard';
import LoadingOverlay from './components/LoadingOverlay';
import Login from './pages/Login';
import SetupWizard from './components/SetupWizard';
import UserMenu from './components/UserMenu';
import HelpPanel from './components/HelpPanel';
import { HelpCircle, Hexagon } from 'lucide-react';
import './styles/index.css';
import './styles/themes.css';

// Fallback timeout for stop operation (SLURM scancel + tunnel cleanup)
const STOP_TIMEOUT_MS = 15000;

// Fixed cluster list - backend only supports these two clusters
// Could be derived from API in future if dynamic clusters are needed
const CLUSTER_NAMES = ['gemini', 'apollo'];

/**
 * Main launcher UI - shown after authentication
 */
function Launcher() {
  const { status, config, health, history, loading, refresh } = useClusterStatus();
  const { getCountdown } = useCountdown(status);
  const { launchState, launch, connect, backToMenu, stopLaunch } = useLaunch(config.ides, refresh);
  const { generateKey } = useAuth();

  const [stoppingJobs, setStoppingJobs] = useState({});
  const [error, setError] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Stable callback for HelpPanel to prevent memo invalidation
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  // Handle SSH key setup from error state
  const handleSetupKeys = useCallback(async () => {
    backToMenu(); // Clear the error state
    // Generate a managed key which will trigger setup wizard
    const result = await generateKey();
    if (result.success) {
      // User will be redirected to setup wizard via needsSetup
    }
  }, [backToMenu, generateKey]);

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
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="login-logo-icon" style={{ width: 36, height: 36, borderRadius: 8 }}>
              <Hexagon size={20} />
            </div>
            <div>
              <h1 style={{ marginBottom: 0 }}>rbiocverse</h1>
              <p className="subtitle" style={{ marginBottom: 0 }}>VS Code, RStudio, JupyterLab on HPC</p>
            </div>
          </div>
          <div className="header-actions">
            <button
              className="help-btn"
              onClick={() => setHelpOpen(true)}
              title="Help"
              aria-label="Open help panel"
            >
              <HelpCircle size={18} />
            </button>
            <UserMenu />
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
        isSshError={launchState.isSshError}
        onBack={backToMenu}
        onCancel={stopLaunch}
        onSetupKeys={handleSetupKeys}
      />

      <HelpPanel isOpen={helpOpen} onClose={closeHelp} health={health} history={history} />
    </>
  );
}

/**
 * App wrapper - handles authentication flow
 */
function AppContent() {
  const { isAuthenticated, needsSetup, loading, user } = useAuth();
  const { health, history } = useClusterStatus();

  // Show loading while checking auth
  if (loading) {
    return (
      <div className="launcher">
        <div className="loading-content">
          <div className="spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  // Not authenticated - show login
  if (!isAuthenticated) {
    return <Login clusterHealth={health} clusterHistory={history} />;
  }

  // First login - show setup wizard
  if (needsSetup) {
    return (
      <div className="launcher" style={{ maxWidth: 650 }}>
        <SetupWizard publicKey={user?.publicKey || ''} />
      </div>
    );
  }

  // Authenticated - show main launcher
  return <Launcher />;
}

/**
 * Root App component with providers
 */
function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
