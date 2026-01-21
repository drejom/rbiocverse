/**
 * PartitionLimits - Display SLURM partition limits for a cluster
 */
import React from 'react';
import { Cpu, MemoryStick, Clock, Zap, Lock, RefreshCw } from 'lucide-react';

function formatTime(slurmTime) {
  if (!slurmTime) return 'N/A';
  const dayMatch = slurmTime.match(/^(\d+)-/);
  if (dayMatch) {
    return `${dayMatch[1]}d`;
  }
  const hourMatch = slurmTime.match(/^(\d+):/);
  if (hourMatch) {
    return `${hourMatch[1]}h`;
  }
  return slurmTime;
}

function formatMemoryGB(gb) {
  if (!gb) return 'N/A';
  if (gb >= 1024) {
    return `${(gb / 1024).toFixed(1)}T`;
  }
  return `${gb}G`;
}

export function PartitionLimits({ cluster, partitions = {}, onRefreshPartitions, isRefreshing }) {
  const clusterPartitions = partitions[cluster] || {};

  if (!clusterPartitions || Object.keys(clusterPartitions).length === 0) {
    return null;
  }

  return (
    <div className="admin-partitions">
      <div className="admin-partitions-header">
        <h5>Partition Limits</h5>
        {onRefreshPartitions && (
          <button
            className="admin-refresh-btn"
            onClick={onRefreshPartitions}
            disabled={isRefreshing}
            title="Refresh partition data from SLURM"
          >
            <RefreshCw size={14} className={isRefreshing ? 'spinning' : ''} />
          </button>
        )}
      </div>
      <div className="admin-partitions-grid">
        {Object.entries(clusterPartitions).map(([name, limits]) => (
          <div key={name} className={`admin-partition ${limits.restricted ? 'restricted' : ''}`}>
            <div className="admin-partition-name">
              {name}
              {limits.isDefault && <span className="admin-partition-default">default</span>}
              {limits.restricted && (
                <span className="admin-partition-restricted" title={limits.restrictionReason || 'Restricted'}>
                  <Lock size={12} />
                </span>
              )}
            </div>
            <div className="admin-partition-limits">
              <span title="Max CPUs per node">
                <Cpu size={12} /> {limits.maxCpus || 'N/A'}
              </span>
              <span title="Max memory per node">
                <MemoryStick size={12} /> {formatMemoryGB(limits.maxMemGB)}
              </span>
              <span title="Max walltime">
                <Clock size={12} /> {formatTime(limits.maxTime)}
              </span>
              {limits.gpuType && (
                <span title={`${limits.gpuCount || 0}x ${limits.gpuType} GPU`}>
                  <Zap size={12} /> {limits.gpuCount}x {limits.gpuType}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
