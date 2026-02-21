/**
 * PartitionLimits - Display SLURM partition limits for a cluster
 */
import { Cpu, MemoryStick, Clock, Zap, Lock, RefreshCw, Shield } from 'lucide-react';
import { formatTime } from '../../hooks/useCountdown';

interface PartitionData {
  maxCpus?: number;
  maxMemGB?: number;
  maxTime?: string;
  restricted?: boolean;
  restrictionReason?: string;
  isDefault?: boolean;
  gpuType?: string;
  gpuCount?: number;
}

interface PartitionLimitsProps {
  cluster?: string;
  partitions?: Record<string, Record<string, PartitionData>>;
  onRefreshPartitions?: () => void;
  isRefreshing?: boolean;
  onScanHostKeys?: () => void;
  isScanningHostKeys?: boolean;
  hostKeyScanResult?: { ok: boolean; message: string } | null;
}

/**
 * Parse SLURM time string to seconds
 * Mirrors lib/helpers.js parseTimeToSeconds
 */
function parseTimeToSeconds(timeStr: string): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(':');

  // MM:SS format
  if (parts.length === 2) {
    const [m, s] = parts;
    const minutes = parseInt(m, 10);
    const seconds = parseInt(s, 10);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return null;
    }
    return minutes * 60 + seconds;
  }

  // HH:MM:SS or D-HH:MM:SS format
  if (parts.length === 3) {
    const [h, m, s] = parts;
    const minutes = parseInt(m, 10);
    const seconds = parseInt(s, 10);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return null;
    }
    if (h.includes('-')) {
      const [daysStr, hoursStr] = h.split('-');
      const days = parseInt(daysStr, 10);
      const hours = parseInt(hoursStr, 10);
      if (!Number.isFinite(days) || !Number.isFinite(hours)) {
        return null;
      }
      return days * 86400 + hours * 3600 + minutes * 60 + seconds;
    }
    const hours = parseInt(h, 10);
    if (!Number.isFinite(hours)) {
      return null;
    }
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

/**
 * Format SLURM time string to human-readable
 */
function formatSlurmTime(slurmTime: string | undefined): string {
  if (!slurmTime) return 'N/A';
  const seconds = parseTimeToSeconds(slurmTime);
  if (seconds === null) return slurmTime;

  // For times >= 1 day, show days
  if (seconds >= 86400) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  return formatTime(seconds);
}

function formatMemoryGB(gb: number | undefined): string {
  if (!gb) return 'N/A';
  if (gb >= 1024) {
    return `${(gb / 1024).toFixed(1)}T`;
  }
  return `${gb}G`;
}

export function PartitionLimits({ cluster, partitions = {}, onRefreshPartitions, isRefreshing, onScanHostKeys, isScanningHostKeys, hostKeyScanResult }: PartitionLimitsProps) {
  const clusterPartitions = cluster ? partitions[cluster] || {} : {};

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
        {onScanHostKeys && (
          <button
            className="admin-action-btn"
            onClick={onScanHostKeys}
            disabled={isScanningHostKeys}
            title="Scan and enroll SSH host keys"
          >
            <Shield size={14} />
            {isScanningHostKeys ? 'Scanning...' : 'Scan Host Keys'}
          </button>
        )}
        {hostKeyScanResult && (
          <p className={hostKeyScanResult.ok ? 'admin-action-success' : 'admin-action-error'}>
            {hostKeyScanResult.message}
          </p>
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
                <Clock size={12} /> {formatSlurmTime(limits.maxTime)}
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
