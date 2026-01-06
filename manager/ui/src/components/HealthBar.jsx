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

export function HealthBars({ health }) {
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

  // CPU bar
  if (health.cpus) {
    bars.push(
      <SingleBar
        key="cpu"
        icon="cpu"
        percent={health.cpus.percent}
        label="CPUs"
        detail={`${health.cpus.used}/${health.cpus.total} allocated`}
      />
    );
  }

  // GPU bar
  if (health.gpus && typeof health.gpus.percent !== 'undefined') {
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

  // Fairshare bar
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

  return <div className="health-indicators">{bars}</div>;
}

export default HealthBars;
