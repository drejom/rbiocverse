/**
 * rbiocverse Launcher - Main App Component
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useClusterStatus } from './hooks/useClusterStatus';
import { useCountdown } from './hooks/useCountdown';
import { useLaunch } from './hooks/useLaunch';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { SessionStateProvider, useSessionState } from './contexts/SessionStateContext';
import Sidebar from './components/Sidebar';
import MainPanel from './components/MainPanel';
import LoadingOverlay from './components/LoadingOverlay';
import Login from './pages/Login';
import SetupWizard from './components/SetupWizard';
import UserMenu from './components/UserMenu';
import HelpPanel from './components/HelpPanel';
import AdminPanel from './components/AdminPanel';
import KeyManagementModal from './components/KeyManagementModal';
import { HelpCircle, Settings } from 'lucide-react';
import AppFooter from './components/AppFooter';
import './styles/index.css';
import './styles/themes.css';
import type { ClusterName } from './types';

// Fallback timeout for stop operation (SLURM scancel + tunnel cleanup)
const STOP_TIMEOUT_MS = 15000;

// Fixed cluster list - backend only supports these two clusters
// Could be derived from API in future if dynamic clusters are needed
const CLUSTER_NAMES: ClusterName[] = ['gemini', 'apollo'];

interface StoppingJobsState {
  [key: string]: boolean;
}

/**
 * Main launcher UI - shown after authentication
 * Now uses sidebar + main panel neumorphism layout
 */
// Session check interval for sliding token refresh (1 hour)
const SESSION_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function Launcher() {
  const { status, config, health, history, loading, refresh } = useClusterStatus();
  const { getCountdown } = useCountdown(status);
  // useLaunch now uses SessionStateContext - no longer needs onRefresh callback
  const { launch, connect, backToMenu, stopLaunch } = useLaunch(config.ides);
  const { user, checkSession } = useAuth();
  const { clearSession } = useSessionState();

  // Periodic session check for sliding token refresh
  // Ensures active users get their token refreshed before expiry
  useEffect(() => {
    const interval = setInterval(() => {
      checkSession();
    }, SESSION_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkSession]);

  // Sidebar state
  const [selectedCluster, setSelectedCluster] = useState<ClusterName>(CLUSTER_NAMES[0]);
  const [selectedGpu, setSelectedGpu] = useState<string>('');

  // Reset GPU selection when switching clusters to avoid stale/invalid values
  useEffect(() => {
    setSelectedGpu('');
  }, [selectedCluster]);

  const [stoppingJobs, setStoppingJobs] = useState<StoppingJobsState>({});
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [keyModalOpen, setKeyModalOpen] = useState(false);

  // Stable callbacks for panels to prevent memo invalidation
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const closeAdmin = useCallback(() => setAdminOpen(false), []);

  // Handle SSH key setup from error state - opens modal instead of generating directly
  const handleSetupKeys = useCallback(() => {
    backToMenu(); // Clear the error state
    setKeyModalOpen(true); // Open key management modal
  }, [backToMenu]);

  // Track active EventSources for cleanup on unmount
  const stopEventSourcesRef = useRef<Map<string, EventSource>>(new Map());

  // Cleanup all EventSources on unmount
  useEffect(() => {
    return () => {
      stopEventSourcesRef.current.forEach((es) => es.close());
      stopEventSourcesRef.current.clear();
    };
  }, []);

  const handleLaunch = useCallback((hpc: string, ide: string, options: {
    cpus: string;
    mem: string;
    time: string;
    releaseVersion: string | null;
    gpu: string;
  }) => {
    setError(null);
    launch(hpc, ide, {
      cpus: options.cpus,
      mem: options.mem,
      time: options.time,
      releaseVersion: options.releaseVersion || '',
      gpu: options.gpu || undefined,
    });
  }, [launch]);

  const handleConnect = useCallback((hpc: string, ide: string) => {
    setError(null);
    connect(hpc, ide);
  }, [connect]);

  // Note: Using native confirm() is intentional - it's simple, accessible, and
  // sufficient for this low-frequency action. A custom modal would add complexity.
  const handleStop = useCallback((hpc: string, ide: string) => {
    const key = `${user?.username}-${hpc}-${ide}`;
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
      // Clear session from context so UI updates immediately
      clearSession(hpc, ide);
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
  }, [user, config, stoppingJobs, refresh, clearSession]);

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
        {/* Header with actions */}
        <div className="launcher-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="login-logo-icon" style={{ width: 48, height: 48, borderRadius: 10 }}>
              <img src="/icons/icon.svg" alt="rbiocverse" width={32} height={32} />
            </div>
            <div>
              <h1 style={{ marginBottom: 0 }}>rbiocverse</h1>
              <p className="subtitle" style={{ marginBottom: 0 }}>VS Code, RStudio, JupyterLab on HPRCC</p>
            </div>
          </div>
          <div className="header-actions">
            {user?.isAdmin && (
              <button
                className="admin-btn"
                onClick={() => setAdminOpen(true)}
                title="Admin Panel"
                aria-label="Open admin panel"
              >
                <Settings size={18} />
              </button>
            )}
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

        {/* Neumorphism sidebar + panel layout */}
        <div className="app-layout">
          <Sidebar
            clusters={CLUSTER_NAMES}
            selectedCluster={selectedCluster}
            onSelectCluster={setSelectedCluster}
            health={health}
            history={history}
            status={status}
            selectedGpu={selectedGpu}
          />
          <MainPanel
            cluster={selectedCluster}
            user={user}
            ideStatuses={status[selectedCluster] || {}}
            config={config}
            countdown={getCountdown}
            stoppingJobs={stoppingJobs}
            selectedGpu={selectedGpu}
            onSelectGpu={setSelectedGpu}
            onLaunch={handleLaunch}
            onConnect={handleConnect}
            onStop={handleStop}
          />
        </div>
      </div>

      {/* LoadingOverlay now reads from SessionStateContext */}
      <LoadingOverlay
        onBack={backToMenu}
        onCancel={stopLaunch}
        onSetupKeys={handleSetupKeys}
      />

      <HelpPanel isOpen={helpOpen} onClose={closeHelp} health={health} history={history} />
      <AdminPanel isOpen={adminOpen} onClose={closeAdmin} health={health} history={history} />
      <KeyManagementModal isOpen={keyModalOpen} onClose={() => setKeyModalOpen(false)} />
    </>
  );
}

/**
 * Login page wrapper - only polls cluster status when showing login
 * This avoids duplicate polling when authenticated (Launcher has its own hook)
 */
function LoginWrapper() {
  const { health, history } = useClusterStatus();
  return <Login clusterHealth={health} clusterHistory={history} />;
}

/**
 * App wrapper - handles authentication flow
 */
function AppContent() {
  const { isAuthenticated, needsSetup, loading } = useAuth();

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

  // Not authenticated - show login (with its own cluster status polling)
  if (!isAuthenticated) {
    return <LoginWrapper />;
  }

  // First login - show setup wizard
  if (needsSetup) {
    return (
      <div className="launcher" style={{ maxWidth: 650 }}>
        <SetupWizard />
      </div>
    );
  }

  // Authenticated - show main launcher (has its own cluster status polling)
  return <Launcher />;
}

/**
 * Root App component with providers
 */
function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <SessionStateProvider>
          <AppContent />
          <AppFooter />
        </SessionStateProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
