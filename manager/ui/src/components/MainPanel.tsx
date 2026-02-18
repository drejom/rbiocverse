/**
 * MainPanel component for neumorphism layout
 * Shows IDE tabs, session card, and launch form
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import { Play, Plug, Square, X, Cpu, MemoryStick, Package, Zap } from 'lucide-react';
import ReleaseSelector from './ReleaseSelector';
import LaunchForm from './LaunchForm';
import { TimePie } from './TimePie';
import { useSessionState } from '../contexts/SessionStateContext';
import type {
  ClusterName,
  ClusterConfig,
  IdeStatus,
  User,
} from '../types';

// IDE icon mapping
const ideIcons: Record<string, string> = {
  vscode: 'devicon-vscode-plain',
  rstudio: 'devicon-rstudio-plain',
  jupyter: 'devicon-jupyter-plain',
};

/**
 * Format estimated start time in human-friendly way
 */
function formatEstimatedStart(isoTime: string): string {
  const startDate = new Date(isoTime);
  const now = new Date();
  const diffMs = startDate.getTime() - now.getTime();

  if (diffMs < 0) {
    return 'soon';
  }

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const remainingMins = diffMins % 60;

  if (diffHours < 1) {
    return `in ${diffMins}m`;
  } else if (diffHours < 24) {
    return remainingMins > 0 ? `in ${diffHours}h ${remainingMins}m` : `in ${diffHours}h`;
  } else {
    return startDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }
}

interface ExtendedIdeStatus extends IdeStatus {
  node?: string;
  cpus?: number | string;
  memory?: string;
  gpu?: string;
  releaseVersion?: string;
  timeLeftSeconds?: number;
  timeLimitSeconds?: number;
  startTime?: string;
}

interface MainPanelProps {
  cluster: ClusterName;
  user: User | null;
  ideStatuses: Record<string, ExtendedIdeStatus>;
  config: ClusterConfig;
  countdown: (hpc: string, ide: string) => { remaining: number; total: number } | null;
  stoppingJobs: Record<string, boolean>;
  selectedGpu: string;
  onSelectGpu: (gpu: string) => void;
  onLaunch: (hpc: string, ide: string, options: {
    cpus: string;
    mem: string;
    time: string;
    releaseVersion: string | null;
    gpu: string;
  }) => void;
  onConnect: (hpc: string, ide: string) => void;
  onStop: (hpc: string, ide: string) => void;
}

export function MainPanel({
  cluster,
  user,
  ideStatuses,
  config,
  countdown,
  stoppingJobs,
  selectedGpu,
  onSelectGpu,
  onLaunch,
  onConnect,
  onStop,
}: MainPanelProps) {
  const { getSession } = useSessionState();
  const { ides, releases, defaultReleaseVersion, gpuConfig, partitionLimits, defaultPartitions } = config;

  // Get ordered list of IDEs
  const ideList = useMemo(() => Object.keys(ides), [ides]);

  // Track which IDE tab is selected (for viewing)
  const [selectedIdeTab, setSelectedIdeTab] = useState<string>(ideList[0] || 'vscode');

  // Launch form state
  const [selectedRelease, setSelectedRelease] = useState<string | null>(defaultReleaseVersion);
  const [formValues, setFormValues] = useState({
    cpus: config.defaultCpus || '2',
    mem: config.defaultMem || '40G',
    time: config.defaultTime || '12:00:00',
  });

  // Get GPU config for this cluster
  const clusterGpuConfig = useMemo(() => {
    return gpuConfig?.[cluster] || null;
  }, [gpuConfig, cluster]);

  // Get effective partition limits based on GPU selection
  const limits = useMemo(() => {
    const clusterLimits = partitionLimits?.[cluster];
    if (!clusterLimits) return null;

    const gpuInfo = selectedGpu ? clusterGpuConfig?.[selectedGpu] : undefined;
    const partition = gpuInfo?.partition || defaultPartitions?.[cluster] || 'compute';

    return clusterLimits[partition] || null;
  }, [partitionLimits, clusterGpuConfig, defaultPartitions, cluster, selectedGpu]);

  // Sync default release when available
  useEffect(() => {
    if (defaultReleaseVersion && !selectedRelease) {
      setSelectedRelease(defaultReleaseVersion);
    }
  }, [defaultReleaseVersion, selectedRelease]);

  // Categorize IDEs by status
  // Check both polling and context (SSE) for status
  const idesByStatus = useMemo(() => {
    const running: string[] = [];
    const pending: string[] = [];
    const idle: string[] = [];

    for (const ide of ideList) {
      const pollingStatus = ideStatuses?.[ide];
      const contextStatus = getSession(cluster, ide);
      // Context takes priority (SSE updates are more immediate)
      const status = contextStatus?.status || pollingStatus?.status;

      if (status === 'running') {
        running.push(ide);
      } else if (status === 'pending') {
        pending.push(ide);
      } else {
        idle.push(ide);
      }
    }

    return { running, pending, idle };
  }, [ideList, ideStatuses, cluster, getSession]);

  // Find which IDEs are available for the selected release
  const availableIdesForRelease = useMemo(() => {
    if (!selectedRelease) return [];
    const release = releases[selectedRelease];
    return release?.ides || [];
  }, [releases, selectedRelease]);

  // Get current session status for selected tab
  // Check both polling data (ideStatuses) and context (from SSE updates)
  // Context takes priority since SSE is more immediate than polling
  const pollingStatus = ideStatuses?.[selectedIdeTab];
  const contextStatus = getSession(cluster, selectedIdeTab);

  // Merge: use context status if it's more recent (pending/running from SSE)
  // Fall back to polling data for other fields
  const currentStatus = pollingStatus ? {
    ...pollingStatus,
    // Context status takes priority when set (SSE updates are faster)
    status: contextStatus?.status || pollingStatus.status,
    estimatedStartTime: contextStatus?.estimatedStartTime || pollingStatus.estimatedStartTime,
  } : contextStatus ? {
    status: contextStatus.status,
    jobId: contextStatus.jobId,
    node: contextStatus.node,
    cpus: contextStatus.cpus,
    memory: contextStatus.memory,
    estimatedStartTime: contextStatus.estimatedStartTime,
    gpu: contextStatus.gpu,
    releaseVersion: contextStatus.releaseVersion,
    timeLeftSeconds: contextStatus.timeLeftSeconds,
    timeLimitSeconds: contextStatus.timeLimitSeconds,
  } as ExtendedIdeStatus : undefined;

  const isRunning = currentStatus?.status === 'running';
  const isPending = currentStatus?.status === 'pending';
  const isIdle = !isRunning && !isPending;

  // Determine which IDE to show in the launch form:
  // - If selected tab is idle and available for this release, use it
  // - Otherwise, find the first available idle IDE
  const launchableIde = useMemo(() => {
    const selectedIsLaunchable = isIdle && availableIdesForRelease.includes(selectedIdeTab);
    if (selectedIsLaunchable) return selectedIdeTab;

    return availableIdesForRelease.find(
      (ide) => !idesByStatus.running.includes(ide) && !idesByStatus.pending.includes(ide)
    );
  }, [selectedIdeTab, isIdle, availableIdesForRelease, idesByStatus]);

  // Get countdown info
  const countdownInfo = countdown(cluster, selectedIdeTab);

  // Check if stopping
  const isStopping = !!stoppingJobs[`${user?.username}-${cluster}-${selectedIdeTab}`];

  // Handlers
  const handleLaunch = useCallback(() => {
    if (!launchableIde) return;
    onLaunch(cluster, launchableIde, {
      ...formValues,
      releaseVersion: selectedRelease,
      gpu: selectedGpu,
    });
  }, [cluster, launchableIde, formValues, selectedRelease, selectedGpu, onLaunch]);

  const handleConnect = useCallback(() => {
    onConnect(cluster, selectedIdeTab);
  }, [cluster, selectedIdeTab, onConnect]);

  const handleStop = useCallback(() => {
    onStop(cluster, selectedIdeTab);
  }, [cluster, selectedIdeTab, onStop]);

  return (
    <div className="main-panel">
      <div className="panel-header">
        <ReleaseSelector
          releases={releases}
          selectedVersion={selectedRelease}
          onSelect={setSelectedRelease}
          cluster={cluster}
          compact
        />
        <div className="ide-tabs">
          {ideList.map((ide) => {
            const pollingStatus = ideStatuses?.[ide];
            const contextStatus = getSession(cluster, ide);
            // Use context status (from SSE) if available, fallback to polling
            const effectiveStatus = contextStatus?.status || pollingStatus?.status;
            const isActive = ide === selectedIdeTab;
            const ideRunning = effectiveStatus === 'running';
            const idePending = effectiveStatus === 'pending';
            const isAvailable = availableIdesForRelease.includes(ide);
            const isDisabled = !isAvailable && !ideRunning && !idePending;

            return (
              <button
                key={ide}
                className={`ide-tab ${isActive ? 'active' : ''} ${ideRunning ? 'running' : idePending ? 'pending' : isDisabled ? 'unavailable' : 'idle'}`}
                onClick={() => !isDisabled && setSelectedIdeTab(ide)}
                disabled={isDisabled}
                title={isDisabled ? (selectedRelease ? `Not available in Bioc ${selectedRelease}` : 'Select a release first') : undefined}
              >
                <span className="status-dot" />
                <i className={`${ideIcons[ide] || 'devicon-nodejs-plain'}`} style={{ fontSize: '0.9rem' }} />
                <span>{ides[ide]?.name || ide}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel-content">
        {/* Launch Form - always shows selected IDE, disabled when running/pending */}
        <div className={`form-section ${isRunning || isPending ? 'disabled' : ''}`}>
          <div className="form-title">Launch {ides[selectedIdeTab]?.name || selectedIdeTab}</div>

          <LaunchForm
            values={formValues}
            onChange={setFormValues}
            limits={limits}
            gpuConfig={clusterGpuConfig}
            selectedGpu={selectedGpu}
            onGpuSelect={onSelectGpu}
          />

          <button
            className="btn-neu btn-primary"
            onClick={handleLaunch}
            disabled={isRunning || isPending || !launchableIde || selectedIdeTab !== launchableIde}
          >
            <Play className="icon-sm" /> Launch {ides[selectedIdeTab]?.name || selectedIdeTab}
          </button>
        </div>

        {/* Running Session Card */}
        {isRunning && currentStatus && (
          <div className="session-card running">
            <div className="session-header">
              <span className="session-ide">
                <i className={`${ideIcons[selectedIdeTab] || 'devicon-nodejs-plain'}`} style={{ marginRight: 8 }} />
                {ides[selectedIdeTab]?.name || selectedIdeTab}
              </span>
              <span className="session-node">
                <Package className="icon-xs" style={{ marginRight: 4 }} />
                {currentStatus.node || 'node'}
              </span>
            </div>

            <div className="session-stats-inline">
              <TimePie
                remaining={countdownInfo?.remaining || currentStatus.timeLeftSeconds || 0}
                total={countdownInfo?.total || currentStatus.timeLimitSeconds || 1}
              />
              <span className="stat-inline">
                <Cpu size={14} />
                {currentStatus.cpus || '?'}
              </span>
              <span className="stat-inline">
                <MemoryStick size={14} />
                {currentStatus.memory || '?'}
              </span>
              {currentStatus.releaseVersion && (
                <span className="stat-inline">
                  <Package size={14} />
                  Bioc {currentStatus.releaseVersion}
                </span>
              )}
              {currentStatus.gpu && (
                <span className="stat-inline">
                  <Zap size={14} />
                  {currentStatus.gpu.toUpperCase()}
                </span>
              )}
            </div>

            {isStopping ? (
              <div className="stop-progress">
                <div className="stop-progress-text">Stopping job...</div>
                <div className="stop-progress-bar">
                  <div className="stop-progress-fill" />
                </div>
              </div>
            ) : (
              <div className="session-actions">
                <button className="btn-neu btn-success" onClick={handleConnect}>
                  <Plug className="icon-sm" /> Connect
                </button>
                <button className="btn-neu btn-danger" onClick={handleStop}>
                  <Square className="icon-sm" /> Stop
                </button>
              </div>
            )}
          </div>
        )}

        {/* Pending Session Card */}
        {isPending && currentStatus && (
          <div className="session-card">
            <div className="session-header">
              <span className="session-ide">
                <i className={`${ideIcons[selectedIdeTab] || 'devicon-nodejs-plain'}`} style={{ marginRight: 8 }} />
                {ides[selectedIdeTab]?.name || selectedIdeTab}
              </span>
              {!isStopping && <span className="spinner" />}
            </div>
            <div className="session-stats-inline">
              <span className="stat-inline">
                <Cpu size={14} />
                {currentStatus.cpus || formValues.cpus || '?'}
              </span>
              <span className="stat-inline">
                <MemoryStick size={14} />
                {currentStatus.memory || formValues.mem || '?'}
              </span>
              {(currentStatus.releaseVersion || selectedRelease) && (
                <span className="stat-inline">
                  <Package size={14} />
                  Bioc {currentStatus.releaseVersion || selectedRelease}
                </span>
              )}
              {(currentStatus.gpu || selectedGpu) && (
                <span className="stat-inline">
                  <Zap size={14} />
                  {(currentStatus.gpu || selectedGpu).toUpperCase()}
                </span>
              )}
            </div>
            <div className="estimated-start" style={{ marginBottom: 12 }}>
              {currentStatus.estimatedStartTime
                ? `Est: ${formatEstimatedStart(currentStatus.estimatedStartTime)}`
                : 'Waiting for estimated start time...'}
            </div>
            {isStopping ? (
              <div className="stop-progress">
                <div className="stop-progress-text">Cancelling job...</div>
                <div className="stop-progress-bar">
                  <div className="stop-progress-fill" />
                </div>
              </div>
            ) : (
              <div className="session-actions">
                <button className="btn-neu btn-danger" onClick={handleStop}>
                  <X className="icon-sm" /> Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {/* No Session State - placeholder to maintain consistent height */}
        {isIdle && (
          <div className="no-session">
            <div className="no-session-icon">💤</div>
            <div>No active session</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MainPanel;
