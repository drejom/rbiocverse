/**
 * ClusterHealth widget for help documentation
 * Displays compact health bars for a specific cluster
 * Receives health/history as props from parent (not via hook - prevents re-render issues)
 */
import { HealthBars } from '../HealthBar';
import type { ClusterHealth as ClusterHealthType, ClusterHistoryPoint } from '../../types';

interface ClusterHealthProps {
  cluster?: string;
  health?: Record<string, ClusterHealthType | null>;
  history?: Record<string, ClusterHistoryPoint[]>;
}

export function ClusterHealth({ cluster, health = {}, history = {} }: ClusterHealthProps) {
  const clusterHealth = cluster ? health[cluster] : null;
  const clusterHistory = cluster ? history[cluster] || [] : [];

  if (!clusterHealth) {
    return (
      <div className="help-widget-cluster-health loading">
        Loading {cluster} health...
      </div>
    );
  }

  return (
    <div className="help-widget-cluster-health">
      <HealthBars
        health={clusterHealth}
        history={clusterHistory}
        showFairshare={false}
      />
    </div>
  );
}
