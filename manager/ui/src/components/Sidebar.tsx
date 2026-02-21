/**
 * Sidebar component for neumorphism layout
 * Shows cluster navigation with health bars and sparklines
 * When a GPU is selected, the CPU bar switches to show GPU stats
 */
import type { KeyboardEvent } from 'react';
import { Gauge, Cpu, MemoryStick, Server, Gpu, LucideIcon } from 'lucide-react';
import { Sparkline } from './Sparkline';
import type { ClusterName, ClusterHealth, ClusterHistoryPoint, IdeStatus } from '../types';

// Thresholds for health bar colors
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

function getFairshareLevel(percent: number): Level {
  if (percent < FAIRSHARE_THRESHOLD_LOW) return 'high';
  if (percent < FAIRSHARE_THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

interface MiniHealthBarProps {
  icon: LucideIcon;
  percent: number;
  title: string;
  isFairshare?: boolean;
  sparklineData?: number[];
}

function MiniHealthBar({ icon: Icon, percent, title, isFairshare = false, sparklineData }: MiniHealthBarProps) {
  const safePercent = Math.min(100, Math.max(0, percent || 0));
  const level = isFairshare ? getFairshareLevel(safePercent) : getLevel(safePercent);

  return (
    <div className="health-bar-mini-wrap" title={`${title}: ${safePercent}%`}>
      <Icon size={10} className="health-bar-mini-icon" />
      <div className="health-bar-mini">
        <div
          className={`health-bar-mini-fill ${level}`}
          style={{ width: `${safePercent}%` }}
        />
      </div>
      {sparklineData && sparklineData.length > 1 && (
        <Sparkline data={sparklineData} width={32} height={10} />
      )}
    </div>
  );
}

interface ClusterNavItemProps {
  cluster: ClusterName;
  health: ClusterHealth | null;
  history: ClusterHistoryPoint[];
  isActive: boolean;
  hasRunning: boolean;
  selectedGpu: string;
  onClick: () => void;
}

const CLUSTER_LOCATIONS: Record<ClusterName, string> = {
  gemini: 'Phoenix, AZ',
  apollo: 'Rivergrade, CA',
};

function ApolloIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="apollo-sun" cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#fde047"/>
          <stop offset="100%" stopColor="#f59e0b"/>
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="49" fill="#f59e0b" fillOpacity="0.1"/>
      <circle cx="50" cy="50" r="43" fill="#f59e0b" fillOpacity="0.15"/>
      <circle cx="50" cy="50" r="36" fill="url(#apollo-sun)"/>
      <circle cx="37" cy="37" r="6" fill="white" fillOpacity="0.3"/>
    </svg>
  );
}

function GeminiIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gemini-sphere" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3b82f6"/>
          <stop offset="100%" stopColor="#8b5cf6"/>
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="44" fill="url(#gemini-sphere)"/>
      <circle cx="37" cy="37" r="6" fill="white" fillOpacity="0.25"/>
    </svg>
  );
}

function ClusterNavItem({ cluster, health, history, isActive, hasRunning, selectedGpu, onClick }: ClusterNavItemProps) {
  const displayName = cluster.charAt(0).toUpperCase() + cluster.slice(1);
  const location = CLUSTER_LOCATIONS[cluster];

  // Extract health percentages - types now include fairshare and gpus
  const fairsharePercent = typeof health?.fairshare === 'number' ? Math.round(health.fairshare * 100) : 0;
  const cpuPercent = health?.cpus?.percent ?? 0;
  const memPercent = health?.memory?.percent ?? 0;
  const nodePercent = health?.nodes?.percent ?? 0;

  // GPU stats (when a GPU is selected)
  // Use uppercase for display, but lookup may need case-insensitive matching
  const gpuTypeDisplay = selectedGpu?.toUpperCase();
  const gpuTypeLookup = selectedGpu?.toLowerCase();
  // Try both lowercase and uppercase keys since SLURM data may use either
  const gpuData = gpuTypeLookup && health?.gpus
    ? (health.gpus[gpuTypeLookup] || health.gpus[gpuTypeLookup.toUpperCase()])
    : null;
  const gpuTotal = gpuData ? (gpuData.total || ((gpuData.idle || 0) + (gpuData.busy || 0))) : 0;
  const gpuPercent = gpuTotal > 0 ? Math.round(((gpuData?.busy || 0) / gpuTotal) * 100) : 0;

  // Extract sparkline data from history - API returns cpus, memory, nodes, gpus
  const cpuHistory = history.map(h => h.cpus ?? 0);
  const memHistory = history.map(h => h.memory ?? 0);
  const nodeHistory = history.map(h => h.nodes ?? 0);
  const gpuHistory = history.map(h => h.gpus ?? 0);

  const className = [
    'nav-item',
    isActive ? 'active' : '',
    hasRunning ? 'has-running' : '',
  ].filter(Boolean).join(' ');

  // Show GPU bar when GPU is selected (only for active cluster), otherwise show CPU
  const showGpu = isActive && !!selectedGpu && !!gpuData;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className={className}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      aria-label={`Select ${displayName} cluster`}
    >
      <div className="nav-icon">
        {cluster === 'apollo' ? <ApolloIcon /> : <GeminiIcon />}
      </div>
      <div className="nav-content">
        <div className="nav-name">{displayName}</div>
        <div className="nav-location">{location}</div>
      </div>
      <div className="nav-health">
        <MiniHealthBar icon={Gauge} percent={fairsharePercent} title="Priority" isFairshare />
        {showGpu ? (
          <MiniHealthBar icon={Gpu} percent={gpuPercent} title={`${gpuTypeDisplay} GPUs`} sparklineData={gpuHistory} />
        ) : (
          <MiniHealthBar icon={Cpu} percent={cpuPercent} title="CPU" sparklineData={cpuHistory} />
        )}
        <MiniHealthBar icon={MemoryStick} percent={memPercent} title="Memory" sparklineData={memHistory} />
        <MiniHealthBar icon={Server} percent={nodePercent} title="Nodes" sparklineData={nodeHistory} />
      </div>
    </div>
  );
}

interface SidebarProps {
  clusters: ClusterName[];
  selectedCluster: ClusterName;
  onSelectCluster: (cluster: ClusterName) => void;
  health: Record<string, ClusterHealth | null>;
  history: Record<string, ClusterHistoryPoint[]>;
  status: Record<ClusterName, Record<string, IdeStatus>>;
  selectedGpu: string;
}

export function Sidebar({
  clusters,
  selectedCluster,
  onSelectCluster,
  health,
  history,
  status,
  selectedGpu,
}: SidebarProps) {
  // Check if cluster has any running/pending sessions
  const hasRunning = (cluster: ClusterName) => {
    const clusterStatus = status[cluster];
    if (!clusterStatus) return false;
    return Object.values(clusterStatus).some(
      (s) => s.status === 'running' || s.status === 'pending'
    );
  };

  return (
    <div className="sidebar">
      <div className="nav-section">
        {clusters.map((cluster) => (
          <ClusterNavItem
            key={cluster}
            cluster={cluster}
            health={health[cluster]}
            history={history[cluster] || []}
            isActive={selectedCluster === cluster}
            hasRunning={hasRunning(cluster)}
            selectedGpu={selectedCluster === cluster ? selectedGpu : ''}
            onClick={() => onSelectCluster(cluster)}
          />
        ))}
      </div>
    </div>
  );
}

export default Sidebar;
