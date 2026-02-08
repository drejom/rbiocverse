/**
 * Cluster card component
 * Contains IDE sessions, launch form, and health indicators
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import { Play, Square } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { HealthBars } from './HealthBar';
import ReleaseSelector from './ReleaseSelector';
import IdeSelector from './IdeSelector';
import LaunchForm from './LaunchForm';
import { RunningSession, PendingSession } from './IdeSession';
import type { ClusterConfig, ClusterHealth, ClusterHistoryPoint, IdeStatus, User } from '../types';

interface IdeWithStatus {
  ide: string;
  status: IdeStatus & {
    node?: string;
    cpus?: number | string;
    memory?: string;
    gpu?: string;
    releaseVersion?: string;
    timeLeftSeconds?: number;
    timeLimitSeconds?: number;
    startTime?: string;
  };
}

interface ClusterCardProps {
  hpc: string;
  user: User | null;
  ideStatuses: Record<string, IdeStatus & {
    node?: string;
    cpus?: number | string;
    memory?: string;
    gpu?: string;
    releaseVersion?: string;
    timeLeftSeconds?: number;
    timeLimitSeconds?: number;
    startTime?: string;
  }>;
  health: ClusterHealth | null;
  history: ClusterHistoryPoint[];
  config: ClusterConfig;
  countdown: (hpc: string, ide: string) => { remaining: number; total: number } | null;
  stoppingJobs: Record<string, boolean>;
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

export function ClusterCard({
  hpc,
  user,
  ideStatuses,
  health,
  history,
  config,
  countdown,
  stoppingJobs,
  onLaunch,
  onConnect,
  onStop,
}: ClusterCardProps) {
  const { ides, releases, defaultReleaseVersion, gpuConfig, partitionLimits, defaultPartitions } = config;
  const api = useApi();

  // Local state for launch form
  const [selectedIde, setSelectedIde] = useState('vscode');
  const [selectedRelease, setSelectedRelease] = useState<string | null>(defaultReleaseVersion);
  const [selectedGpu, setSelectedGpu] = useState('');
  const [formValues, setFormValues] = useState({
    cpus: config.defaultCpus || '2',
    mem: config.defaultMem || '40G',
    time: config.defaultTime || '12:00:00',
  });
  const [isStoppingAll, setIsStoppingAll] = useState(false);
  const [stopAllError, setStopAllError] = useState<string | null>(null);

  // Sync default release when it becomes available
  useEffect(() => {
    if (defaultReleaseVersion && !selectedRelease) {
      setSelectedRelease(defaultReleaseVersion);
    }
  }, [defaultReleaseVersion, selectedRelease]);

  // Categorize IDEs by status
  const { runningIdes, pendingIdes } = useMemo(() => {
    const running: IdeWithStatus[] = [];
    const pending: IdeWithStatus[] = [];

    for (const [ide, status] of Object.entries(ideStatuses || {})) {
      if (status.status === 'running') {
        running.push({ ide, status });
      } else if (status.status === 'pending') {
        pending.push({ ide, status });
      }
    }

    return { runningIdes: running, pendingIdes: pending };
  }, [ideStatuses]);

  // Get available IDEs for selected release
  const availableIdesForRelease = useMemo(() => {
    if (!selectedRelease) return [];
    const release = releases[selectedRelease] as { ides?: string[] } | undefined;
    return release?.ides || [];
  }, [releases, selectedRelease]);

  // Running IDE names (to disable in selector)
  const runningIdeNames = useMemo(
    () => runningIdes.map((r) => r.ide),
    [runningIdes]
  );

  // Auto-select first available IDE if current is unavailable
  useEffect(() => {
    const isUnavailable =
      runningIdeNames.includes(selectedIde) ||
      !availableIdesForRelease.includes(selectedIde);

    if (isUnavailable && availableIdesForRelease.length > 0) {
      const firstAvailable = availableIdesForRelease.find(
        (ide) => !runningIdeNames.includes(ide)
      );
      if (firstAvailable) {
        setSelectedIde(firstAvailable);
      }
    }
  }, [availableIdesForRelease, runningIdeNames, selectedIde]);

  // Get effective partition limits
  const limits = useMemo(() => {
    const clusterLimits = partitionLimits[hpc];
    if (!clusterLimits) return null;

    let partition: string;
    const clusterGpuConfig = gpuConfig?.[hpc] as Record<string, { partition?: string }> | undefined;
    const gpuConfigForSelection = clusterGpuConfig?.[selectedGpu];
    if (selectedGpu && gpuConfigForSelection) {
      partition = gpuConfigForSelection.partition || 'compute';
    } else {
      partition = defaultPartitions[hpc] || 'compute';
    }

    return clusterLimits[partition] || null;
  }, [partitionLimits, gpuConfig, defaultPartitions, hpc, selectedGpu]);

  // Card status
  const cardStatus = useMemo(() => {
    if (runningIdes.length > 0) return 'running';
    if (pendingIdes.length > 0) return 'pending';
    return 'idle';
  }, [runningIdes, pendingIdes]);

  const statusText = useMemo(() => {
    if (runningIdes.length === 1) {
      const ideInfo = ides[runningIdes[0].ide];
      return `${ideInfo?.name || 'IDE'} running`;
    }
    if (runningIdes.length > 1) {
      return `${runningIdes.length} IDEs running`;
    }
    if (pendingIdes.length > 0) return 'Pending';
    return 'No session';
  }, [runningIdes, pendingIdes, ides]);

  // Handle launch
  const handleLaunch = useCallback(() => {
    onLaunch(hpc, selectedIde, {
      ...formValues,
      releaseVersion: selectedRelease,
      gpu: selectedGpu,
    });
  }, [hpc, selectedIde, formValues, selectedRelease, selectedGpu, onLaunch]);

  // Count of running + pending jobs (for Stop All button visibility)
  const activeJobCount = runningIdes.length + pendingIdes.length;

  // Handle stop all jobs
  const handleStopAll = useCallback(async () => {
    if (!confirm(`Stop all ${activeJobCount} jobs on ${hpc.charAt(0).toUpperCase() + hpc.slice(1)}?`)) {
      return;
    }

    setIsStoppingAll(true);
    setStopAllError(null);

    try {
      const data = await api.post<{ cancelled?: string[]; failed?: string[] }>(`/api/stop-all/${hpc}`);

      if (data.failed && data.failed.length > 0) {
        // Some jobs failed to cancel - show which ones
        setStopAllError(`Failed to stop ${data.failed.length} job(s): ${data.failed.join(', ')}`);
      }

      // Trigger a status refresh
      window.dispatchEvent(new CustomEvent('refresh-status'));
    } catch (e) {
      setStopAllError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setIsStoppingAll(false);
    }
  }, [hpc, activeJobCount]);

  // Check if any IDEs are available to launch
  const canLaunch = useMemo(() => {
    return availableIdesForRelease.some((ide) => !runningIdeNames.includes(ide));
  }, [availableIdesForRelease, runningIdeNames]);

  const selectedIdeInfo = ides[selectedIde] || { name: 'IDE' };

  return (
    <div className={`cluster-card ${cardStatus}`}>
      <div className="cluster-header">
        <div className="cluster-header-left">
          <span className="cluster-name">{hpc.charAt(0).toUpperCase() + hpc.slice(1)}</span>
          <HealthBars health={health} selectedGpu={selectedGpu} history={history} />
        </div>
        <div className="cluster-status">
          <span className={`status-dot ${cardStatus}`} />
          <span>{statusText}</span>
        </div>
      </div>

      <div className="cluster-content">
        {/* Pending sessions */}
        {pendingIdes.map(({ ide, status }) => (
          <PendingSession
            key={ide}
            hpc={hpc}
            ide={ide}
            status={status}
            ides={ides}
            onStop={onStop}
            stopping={isStoppingAll || !!stoppingJobs[`${user?.username}-${hpc}-${ide}`]}
          />
        ))}

        {/* Running sessions */}
        {runningIdes.length > 0 && (
          <div className="running-sessions">
            {runningIdes.map(({ ide, status }) => (
              <RunningSession
                key={ide}
                hpc={hpc}
                ide={ide}
                status={status}
                countdown={countdown(hpc, ide)}
                ides={ides}
                onConnect={onConnect}
                onStop={onStop}
                stopping={isStoppingAll || !!stoppingJobs[`${user?.username}-${hpc}-${ide}`]}
              />
            ))}
          </div>
        )}

        {/* Stop All Jobs button - only show when >1 job */}
        {activeJobCount > 1 && (
          <div className="stop-all-section">
            {stopAllError && (
              <div className="error-message small">{stopAllError}</div>
            )}
            <button
              className="btn btn-danger btn-sm stop-all-btn"
              onClick={handleStopAll}
              disabled={isStoppingAll}
            >
              <Square className="icon-sm" />
              {isStoppingAll ? 'Stopping...' : `Stop All Jobs (${activeJobCount})`}
            </button>
          </div>
        )}

        {/* Launch section */}
        {canLaunch ? (
          <div className="launch-section">
            {runningIdes.length > 0 && (
              <div className="section-divider">Launch another IDE</div>
            )}

            <ReleaseSelector
              releases={releases}
              selectedVersion={selectedRelease}
              onSelect={setSelectedRelease}
              cluster={hpc}
            />

            <IdeSelector
              ides={ides}
              selectedIde={selectedIde}
              onSelect={setSelectedIde}
              runningIdes={runningIdeNames}
              availableIdes={availableIdesForRelease}
              releaseVersion={selectedRelease || undefined}
              releases={releases}
            />

            <LaunchForm
              values={formValues}
              onChange={setFormValues}
              limits={limits}
              gpuConfig={gpuConfig[hpc] || null}
              selectedGpu={selectedGpu}
              onGpuSelect={setSelectedGpu}
            />

            <div className="btn-group">
              <button className="btn btn-primary" onClick={handleLaunch}>
                <Play className="lucide" /> Launch {selectedIdeInfo.name}
              </button>
            </div>
          </div>
        ) : runningIdes.length === 0 && pendingIdes.length === 0 ? (
          <div className="cluster-info">No active sessions</div>
        ) : null}
      </div>
    </div>
  );
}

export default ClusterCard;
