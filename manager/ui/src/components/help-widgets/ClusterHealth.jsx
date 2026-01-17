/**
 * ClusterHealth widget for help documentation
 * Displays compact health bars for a specific cluster
 */
import { HealthBars } from '../HealthBar';
import { useClusterStatus } from '../../hooks/useClusterStatus';

export function ClusterHealth({ cluster }) {
  const { health, history } = useClusterStatus();

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
