/**
 * Health indicator bar component
 * Shows resource usage with color-coded fill and 24hr trend sparkline
 */
import React from 'react';
import { Cpu, MemoryStick, Server, Gauge, Gpu, WifiOff, LucideIcon } from 'lucide-react';
import { Sparkline } from './Sparkline';
import type { ClusterHealth, ClusterHistoryPoint } from '../types';

// Resource usage thresholds (percent)
const THRESHOLD_HIGH = 85;
const THRESHOLD_MEDIUM = 60;

// Fairshare thresholds (inverted - higher is better)
const FAIRSHARE_THRESHOLD_LOW = 30;
const FAIRSHARE_THRESHOLD_MEDIUM = 60;

type Level = 'low' | 'medium' | 'high';

function getLevel(percent: number): Level {
  if (percent >= THRESHOLD_HIGH) return 'high';
  if (percent >= THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

// Fairshare is inverted - higher is better
function getFairshareLevel(percent: number): Level {
  if (percent < FAIRSHARE_THRESHOLD_LOW) return 'high';
  if (percent < FAIRSHARE_THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

type IconName = 'cpu' | 'memory-stick' | 'server' | 'gauge' | 'gpu';

const iconMap: Record<IconName, LucideIcon> = {
  cpu: Cpu,
  'memory-stick': MemoryStick,
  server: Server,
  gauge: Gauge,
  gpu: Gpu,
};

interface SingleBarProps {
  icon: IconName;
  percent: number;
  label: string;
  detail?: string;
  isFairshare?: boolean;
  trend?: number[] | null;
}

function SingleBar({ icon, percent, label, detail, isFairshare = false, trend = null }: SingleBarProps) {
  const Icon = iconMap[icon] || Cpu;
  const safePercent = Math.min(100, Math.max(0, percent || 0));
  const level = isFairshare ? getFairshareLevel(safePercent) : getLevel(safePercent);
  const tooltip = `${label}: ${safePercent}% ${isFairshare ? 'priority' : 'used'}${detail ? ` (${detail})` : ''}`;

  return (
    <span className="health-indicator" title={tooltip}>
      <Icon className="icon-xs" />
      <div className="health-bar-container">
        {trend && trend.length >= 2 && (
          <Sparkline data={trend} width={40} height={8} />
        )}
        <div className="health-bar">
          <div
            className={`health-bar-fill ${level}`}
            style={{ width: `${safePercent}%` }}
          />
        </div>
      </div>
    </span>
  );
}

interface HealthBarsProps {
  health: ClusterHealth | null;
  selectedGpu?: string | null;
  history?: ClusterHistoryPoint[];
  showFairshare?: boolean;
}

interface PartitionData {
  cpus?: {
    percent?: number;
    used?: number;
    total?: number;
  };
}

interface GpuData {
  total?: number;
  idle?: number;
  busy?: number;
}

export function HealthBars({ health, selectedGpu, history = [], showFairshare = true }: HealthBarsProps) {
  if (!health || !health.online) {
    return (
      <div className="health-indicators offline">
        <span className="health-indicator offline" title="Cluster offline or loading...">
          <WifiOff className="icon-xs" />
        </span>
      </div>
    );
  }

  const bars: React.ReactElement[] = [];

  // Extract trend data from history (last 24 entries = 24 hours)
  // API returns history with cpus, memory, nodes, gpus holding percentage values
  const cpuTrend = history.map(h => h.cpus).filter((v): v is number => v != null).slice(-24);
  const memoryTrend = history.map(h => h.memory).filter((v): v is number => v != null).slice(-24);
  const nodesTrend = history.map(h => h.nodes).filter((v): v is number => v != null).slice(-24);
  const gpusTrend = history.map(h => h.gpus).filter((v): v is number => v != null).slice(-24);

  // Determine which CPU stats to show based on GPU selection
  // When a GPU is selected, show that partition's CPU stats instead of cluster-wide
  const partitionKey = selectedGpu ? `gpu-${selectedGpu}` : null;
  const partitions = (health as { partitions?: Record<string, PartitionData> }).partitions;
  const partitionData = partitionKey ? partitions?.[partitionKey] : null;
  const effectiveCpus = partitionData?.cpus || health.cpus;

  // Fairshare bar (leftmost - most important for user) - no trend for fairshare
  // Only show when showFairshare is true (not on login page - it's per-user)
  const fairshare = (health as { fairshare?: number }).fairshare;
  if (showFairshare && typeof fairshare === 'number') {
    bars.push(
      <SingleBar
        key="fairshare"
        icon="gauge"
        percent={Math.round(fairshare * 100)}
        label="Priority"
        detail="higher is better"
        isFairshare
      />
    );
  }

  // Second bar: CPU when no GPU selected, specific GPU when GPU selected
  // The icon changes from CPU to GPU based on selection
  const gpus = health.gpus as Record<string, GpuData> | undefined;
  if (selectedGpu && gpus) {
    // GPU selected: show that specific GPU type's usage with GPU icon
    const gpuType = selectedGpu.toUpperCase();
    const gpuData = gpus[gpuType];
    if (gpuData) {
      const total = gpuData.total || ((gpuData.idle || 0) + (gpuData.busy || 0));
      const percent = total > 0 ? Math.round(((gpuData.busy || 0) / total) * 100) : 0;
      bars.push(
        <SingleBar
          key="resource"
          icon="gpu"
          percent={percent}
          label={`${gpuType} GPUs`}
          detail={`${gpuData.busy || 0}/${total} in use`}
          trend={gpusTrend}
        />
      );
    }
  } else if (effectiveCpus) {
    // No GPU selected: show cluster-wide CPU stats with CPU icon
    bars.push(
      <SingleBar
        key="resource"
        icon="cpu"
        percent={effectiveCpus.percent || 0}
        label="CPUs"
        detail={`${effectiveCpus.used}/${effectiveCpus.total} allocated`}
        trend={cpuTrend}
      />
    );
  }

  // Memory bar
  if (health.memory) {
    const memory = health.memory as { percent?: number; used?: number; total?: number; unit?: string };
    bars.push(
      <SingleBar
        key="memory"
        icon="memory-stick"
        percent={memory.percent || 0}
        label="Memory"
        detail={`${memory.used}/${memory.total} ${memory.unit || ''}`}
        trend={memoryTrend}
      />
    );
  }

  // Nodes bar
  if (health.nodes && (health.nodes as { total?: number }).total && (health.nodes as { total: number }).total > 0) {
    const nodes = health.nodes as { percent?: number; idle?: number; busy?: number; down?: number; total: number };
    bars.push(
      <SingleBar
        key="nodes"
        icon="server"
        percent={nodes.percent || 0}
        label="Nodes"
        detail={`${nodes.idle} idle, ${nodes.busy} busy, ${nodes.down} down`}
        trend={nodesTrend}
      />
    );
  }

  return <div className="health-indicators">{bars}</div>;
}
