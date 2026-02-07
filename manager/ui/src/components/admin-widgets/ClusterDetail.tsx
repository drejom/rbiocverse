/**
 * ClusterDetail - Detailed cluster health widget
 */
import { Cpu, MemoryStick, Server, Zap } from 'lucide-react';
import type { ClusterHealth, ClusterHistoryPoint } from '../../types';

// Resource usage thresholds
const THRESHOLD_HIGH = 85;
const THRESHOLD_MEDIUM = 60;

function getLevel(percent: number): 'high' | 'medium' | 'low' {
  if (percent >= THRESHOLD_HIGH) return 'high';
  if (percent >= THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

function formatMemory(gb: number | null | undefined): string {
  if (!gb) return '0 GB';
  if (gb >= 1024 * 1024) {
    return `${(gb / (1024 * 1024)).toFixed(1)} PB`;
  }
  if (gb >= 1024) {
    return `${(gb / 1024).toFixed(1)} TB`;
  }
  return `${gb} GB`;
}

interface SimpleHealthBarProps {
  percent: number;
}

function SimpleHealthBar({ percent }: SimpleHealthBarProps) {
  const safePercent = Math.min(100, Math.max(0, percent || 0));
  const level = getLevel(safePercent);

  return (
    <div className="health-bar" style={{ flex: 1 }}>
      <div
        className={`health-bar-fill ${level}`}
        style={{ width: `${safePercent}%` }}
      />
    </div>
  );
}

interface ClusterDetailProps {
  cluster?: string;
  health?: Record<string, ClusterHealth | null>;
  history?: Record<string, ClusterHistoryPoint[]>;
}

export function ClusterDetail({ cluster, health = {} }: ClusterDetailProps) {
  // health[cluster] is already the "current" health object (not wrapped)
  const clusterHealth = cluster ? health[cluster] : null;

  if (!clusterHealth || !cluster) {
    return (
      <div className="admin-cluster-detail">
        <h4 className="admin-cluster-name">
          {cluster ? cluster.charAt(0).toUpperCase() + cluster.slice(1) : 'Unknown'}
        </h4>
        <div className="admin-cluster-offline">
          <Server size={20} />
          <span>Cluster offline or unavailable</span>
        </div>
      </div>
    );
  }

  const { cpus, memory, nodes, gpus, runningJobs, pendingJobs } = clusterHealth;

  return (
    <div className="admin-cluster-detail">
      <div className="admin-cluster-header">
        <h4 className="admin-cluster-name">
          {cluster.charAt(0).toUpperCase() + cluster.slice(1)}
          <span className={`admin-cluster-status ${clusterHealth.online ? 'online' : 'offline'}`}>
            {clusterHealth.online ? 'Online' : 'Offline'}
          </span>
        </h4>
        <div className="admin-cluster-jobs">
          <span className="admin-job-count running">{runningJobs || 0} running</span>
          <span className="admin-job-count pending">{pendingJobs || 0} pending</span>
        </div>
      </div>

      <div className="admin-cluster-metrics-row">
        {/* CPU */}
        <div className="admin-metric-compact">
          <div className="admin-metric-compact-header">
            <Cpu size={12} />
            <span>CPU</span>
          </div>
          <SimpleHealthBar percent={cpus?.percent || 0} />
          <div className="admin-metric-compact-value">
            {cpus?.used || 0}/{cpus?.total || 0} <span className="admin-metric-percent">{cpus?.percent || 0}%</span>
          </div>
        </div>

        {/* Memory */}
        <div className="admin-metric-compact">
          <div className="admin-metric-compact-header">
            <MemoryStick size={12} />
            <span>Memory</span>
          </div>
          <SimpleHealthBar percent={memory?.percent || 0} />
          <div className="admin-metric-compact-value">
            {formatMemory(memory?.used)}/{formatMemory(memory?.total)} <span className="admin-metric-percent">{memory?.percent || 0}%</span>
          </div>
        </div>

        {/* Nodes */}
        <div className="admin-metric-compact">
          <div className="admin-metric-compact-header">
            <Server size={12} />
            <span>Nodes</span>
          </div>
          <SimpleHealthBar percent={nodes?.percent || 0} />
          <div className="admin-metric-compact-value">
            {nodes?.busy || 0}/{(nodes as { total?: number })?.total || 0} <span className="admin-metric-percent">{nodes?.percent || 0}%</span>
          </div>
        </div>

        {/* GPUs (if available) */}
        {gpus && (gpus as { total?: number }).total && (gpus as { total: number }).total > 0 && (
          <div className="admin-metric-compact">
            <div className="admin-metric-compact-header">
              <Zap size={12} />
              <span>GPUs</span>
            </div>
            <SimpleHealthBar percent={(gpus as { percent?: number })?.percent || 0} />
            <div className="admin-metric-compact-value">
              {(gpus as { used?: number })?.used || 0}/{(gpus as { total?: number })?.total || 0} <span className="admin-metric-percent">{(gpus as { percent?: number })?.percent || 0}%</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
