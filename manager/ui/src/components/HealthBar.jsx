/**
 * Health indicator bar component
 * Shows resource usage with color-coded fill
 */
import { Cpu, MemoryStick, Server, Gauge, Gpu, WifiOff } from 'lucide-react';

// Resource usage thresholds (percent)
const THRESHOLD_HIGH = 85;
const THRESHOLD_MEDIUM = 60;

// Fairshare thresholds (inverted - higher is better)
const FAIRSHARE_THRESHOLD_LOW = 30;
const FAIRSHARE_THRESHOLD_MEDIUM = 60;

function getLevel(percent) {
  if (percent >= THRESHOLD_HIGH) return 'high';
  if (percent >= THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

// Fairshare is inverted - higher is better
function getFairshareLevel(percent) {
  if (percent < FAIRSHARE_THRESHOLD_LOW) return 'high';
  if (percent < FAIRSHARE_THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

const iconMap = {
  cpu: Cpu,
  'memory-stick': MemoryStick,
  server: Server,
  gauge: Gauge,
  gpu: Gpu,
};

function SingleBar({ icon, percent, label, detail, isFairshare = false }) {
  const Icon = iconMap[icon] || Cpu;
  const safePercent = Math.min(100, Math.max(0, percent || 0));
  const level = isFairshare ? getFairshareLevel(safePercent) : getLevel(safePercent);
  const tooltip = `${label}: ${safePercent}% ${isFairshare ? 'priority' : 'used'}${detail ? ` (${detail})` : ''}`;

  return (
    <span className="health-indicator" title={tooltip}>
      <Icon className="icon-xs" />
      <div className="health-bar">
        <div
          className={`health-bar-fill ${level}`}
          style={{ width: `${safePercent}%` }}
        />
      </div>
    </span>
  );
}

export function HealthBars({ health, selectedGpu }) {
  if (!health || !health.online) {
    return (
      <div className="health-indicators offline">
        <span className="health-indicator offline" title="Cluster offline or loading...">
          <WifiOff className="icon-xs" />
        </span>
      </div>
    );
  }

  const bars = [];

  // Determine which CPU stats to show based on GPU selection
  // When a GPU is selected, show that partition's CPU stats instead of cluster-wide
  const partitionKey = selectedGpu ? `gpu-${selectedGpu}` : null;
  const partitionData = partitionKey ? health.partitions?.[partitionKey] : null;
  const effectiveCpus = partitionData?.cpus || health.cpus;

  // Fairshare bar (leftmost - most important for user)
  if (typeof health.fairshare === 'number') {
    bars.push(
      <SingleBar
        key="fairshare"
        icon="gauge"
        percent={Math.round(health.fairshare * 100)}
        label="Priority"
        detail="higher is better"
        isFairshare
      />
    );
  }

  // CPU bar - shows partition-specific stats when GPU selected
  if (effectiveCpus) {
    const cpuLabel = selectedGpu ? `${selectedGpu.toUpperCase()} CPUs` : 'CPUs';
    bars.push(
      <SingleBar
        key="cpu"
        icon="cpu"
        percent={effectiveCpus.percent}
        label={cpuLabel}
        detail={`${effectiveCpus.used}/${effectiveCpus.total} allocated`}
      />
    );
  }

  // GPU bar - only show when viewing cluster-wide (no GPU selected)
  // When a specific GPU is selected, the CPU bar already shows that partition's usage
  if (!selectedGpu && health.gpus && typeof health.gpus.percent !== 'undefined') {
    const gpuDetails = Object.entries(health.gpus)
      .filter(([type]) => type !== 'percent')
      .map(([type, data]) => {
        const total = data.total || ((data.idle || 0) + (data.busy || 0));
        return `${type.toUpperCase()}: ${data.busy || 0}/${total}`;
      })
      .join(', ');

    bars.push(
      <SingleBar
        key="gpu"
        icon="gpu"
        percent={health.gpus.percent}
        label="GPUs"
        detail={gpuDetails}
      />
    );
  }

  // When GPU is selected, show that specific GPU type's usage
  if (selectedGpu && health.gpus) {
    const gpuType = selectedGpu.toUpperCase();
    const gpuData = health.gpus[gpuType];
    if (gpuData) {
      const total = gpuData.total || ((gpuData.idle || 0) + (gpuData.busy || 0));
      const percent = total > 0 ? Math.round((gpuData.busy / total) * 100) : 0;
      bars.push(
        <SingleBar
          key="gpu"
          icon="gpu"
          percent={percent}
          label={`${gpuType} GPUs`}
          detail={`${gpuData.busy || 0}/${total} in use`}
        />
      );
    }
  }

  // Memory bar
  if (health.memory) {
    bars.push(
      <SingleBar
        key="memory"
        icon="memory-stick"
        percent={health.memory.percent}
        label="Memory"
        detail={`${health.memory.used}/${health.memory.total} ${health.memory.unit}`}
      />
    );
  }

  // Nodes bar
  if (health.nodes && health.nodes.total > 0) {
    bars.push(
      <SingleBar
        key="nodes"
        icon="server"
        percent={health.nodes.percent}
        label="Nodes"
        detail={`${health.nodes.idle} idle, ${health.nodes.busy} busy, ${health.nodes.down} down`}
      />
    );
  }

  return <div className="health-indicators">{bars}</div>;
}

export default HealthBars;
