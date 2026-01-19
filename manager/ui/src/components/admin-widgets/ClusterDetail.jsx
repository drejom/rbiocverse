/**
 * ClusterDetail - Detailed cluster health widget
 */
import React from 'react';
import { Cpu, MemoryStick, Server, Zap } from 'lucide-react';
import { Sparkline } from '../Sparkline';

// Resource usage thresholds
const THRESHOLD_HIGH = 85;
const THRESHOLD_MEDIUM = 60;

function getLevel(percent) {
  if (percent >= THRESHOLD_HIGH) return 'high';
  if (percent >= THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

function formatMemory(gb) {
  if (!gb) return '0 GB';
  if (gb >= 1024 * 1024) {
    return `${(gb / (1024 * 1024)).toFixed(1)} PB`;
  }
  if (gb >= 1024) {
    return `${(gb / 1024).toFixed(1)} TB`;
  }
  return `${gb} GB`;
}

function SimpleHealthBar({ percent }) {
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

export function ClusterDetail({ cluster, health = {}, history = {} }) {
  // health[cluster] is already the "current" health object (not wrapped)
  const clusterHealth = health[cluster];
  const clusterHistory = history[cluster];

  if (!clusterHealth) {
    return (
      <div className="admin-cluster-detail">
        <h4 className="admin-cluster-name">
          {cluster?.charAt(0).toUpperCase() + cluster?.slice(1)}
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
          {cluster?.charAt(0).toUpperCase() + cluster?.slice(1)}
          <span className={`admin-cluster-status ${clusterHealth.online ? 'online' : 'offline'}`}>
            {clusterHealth.online ? 'Online' : 'Offline'}
          </span>
        </h4>
        <div className="admin-cluster-jobs">
          <span className="admin-job-count running">{runningJobs || 0} running</span>
          <span className="admin-job-count pending">{pendingJobs || 0} pending</span>
        </div>
      </div>

      <div className="admin-cluster-metrics">
        {/* CPU */}
        <div className="admin-metric">
          <div className="admin-metric-header">
            <Cpu size={14} />
            <span>CPU Usage</span>
          </div>
          <div className="admin-metric-content">
            <SimpleHealthBar percent={cpus?.percent || 0} />
            <div className="admin-metric-values">
              <span>{cpus?.used || 0} / {cpus?.total || 0} cores</span>
              <span className="admin-metric-percent">{cpus?.percent || 0}%</span>
            </div>
            {clusterHistory?.cpus && (
              <div className="admin-metric-sparkline">
                <Sparkline data={clusterHistory.cpus} height={24} />
              </div>
            )}
          </div>
        </div>

        {/* Memory */}
        <div className="admin-metric">
          <div className="admin-metric-header">
            <MemoryStick size={14} />
            <span>Memory Usage</span>
          </div>
          <div className="admin-metric-content">
            <SimpleHealthBar percent={memory?.percent || 0} />
            <div className="admin-metric-values">
              <span>{formatMemory(memory?.used)} / {formatMemory(memory?.total)}</span>
              <span className="admin-metric-percent">{memory?.percent || 0}%</span>
            </div>
            {clusterHistory?.memory && (
              <div className="admin-metric-sparkline">
                <Sparkline data={clusterHistory.memory} height={24} />
              </div>
            )}
          </div>
        </div>

        {/* Nodes */}
        <div className="admin-metric">
          <div className="admin-metric-header">
            <Server size={14} />
            <span>Node Status</span>
          </div>
          <div className="admin-metric-content">
            <SimpleHealthBar percent={nodes?.percent || 0} />
            <div className="admin-metric-values">
              <span>{nodes?.busy || 0} / {nodes?.total || 0} busy</span>
              <span className="admin-metric-percent">{nodes?.percent || 0}%</span>
            </div>
          </div>
        </div>

        {/* GPUs (if available) */}
        {gpus && gpus.total > 0 && (
          <div className="admin-metric">
            <div className="admin-metric-header">
              <Zap size={14} />
              <span>GPU Usage</span>
            </div>
            <div className="admin-metric-content">
              <SimpleHealthBar percent={gpus?.percent || 0} />
              <div className="admin-metric-values">
                <span>{gpus?.used || 0} / {gpus?.total || 0} GPUs</span>
                <span className="admin-metric-percent">{gpus?.percent || 0}%</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

