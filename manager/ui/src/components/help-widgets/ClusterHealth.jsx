/**
 * ClusterHealth widget for help documentation
 * Displays compact health bars for a specific cluster
 * Receives health/history as props from parent (not via hook - prevents re-render issues)
 */
import { HealthBars } from '../HealthBar';

export function ClusterHealth({ cluster, health = {}, history = {} }) {
  const clusterHealth = health[cluster];
  const clusterHistory = history[cluster] || [];

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
