/**
 * ClusterHealthCard - Displays cluster health on login page
 * Reuses HealthBars component for consistency with main UI
 */

import { HealthBars } from './HealthBar';
import type { ClusterHealth, ClusterHistoryPoint } from '../types';

interface ClusterHealthCardProps {
  name: string;
  health: ClusterHealth | null;
  history?: ClusterHistoryPoint[];
  description?: string;
}

function ClusterHealthCard({ name, health, history, description }: ClusterHealthCardProps) {
  // Determine status
  const isLoading = !health;
  const isOffline = health && !health.online;

  const getStatusText = (): string => {
    if (isLoading) return 'Loading...';
    if (isOffline) return 'Offline';
    return 'Online';
  };

  const getStatusClass = (): string => {
    if (isLoading) return '';
    if (isOffline) return 'stopping';
    return 'running';
  };

  return (
    <div className={`login-cluster-card ${isOffline ? 'offline' : ''}`}>
      <div className="login-cluster-header">
        <span className="login-cluster-name">{name}</span>
        <span className="login-cluster-status">
          <span className={`status-dot ${getStatusClass()}`} />
          {getStatusText()}
        </span>
      </div>

      {/* Reuse HealthBars component for health indicators with sparklines */}
      {/* showFairshare=false because fairshare is per-user, not available pre-login */}
      <HealthBars health={health} history={history || []} showFairshare={false} />

      {description && (
        <p
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
            marginTop: '8px',
          }}
        >
          {description}
        </p>
      )}
    </div>
  );
}

export default ClusterHealthCard;
