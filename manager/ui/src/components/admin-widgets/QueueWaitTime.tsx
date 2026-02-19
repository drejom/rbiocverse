/**
 * QueueWaitTime - Queue wait time percentiles by cluster
 */
import { useEffect, useState } from 'react';
import { DateRangeSelector } from './DateRangeSelector';
import log from '../../lib/logger';

interface QueueStats {
  p50: number | null;
  p90: number | null;
  p99: number | null;
  count: number;
}

interface QueueData {
  [cluster: string]: QueueStats;
}

interface QueueWaitTimeProps {
  getAuthHeader: () => Record<string, string>;
}

export function QueueWaitTime({ getAuthHeader }: QueueWaitTimeProps) {
  const [data, setData] = useState<QueueData | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [days]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/queue?days=${days}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || null);
    } catch (err) {
      log.error('Failed to fetch queue wait times', { error: err });
    } finally {
      setLoading(false);
    }
  };

  const formatSeconds = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined) return 'N/A';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const getWaitTimeColor = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined) return 'var(--text-muted)';
    if (seconds < 60) return 'var(--status-success)';
    if (seconds < 300) return 'var(--status-warning)';
    return 'var(--status-error)';
  };

  const clusters = data ? Object.keys(data) : [];

  return (
    <div className="queue-wait-time">
      <div className="chart-header">
        <h4>Queue Wait Times</h4>
        <DateRangeSelector
          value={days}
          onChange={setDays}
          ranges={[
            { value: 30, label: '30d' },
            { value: 90, label: '90d' },
          ]}
        />
      </div>
      {loading ? (
        <div className="chart-loading">Loading...</div>
      ) : !data || clusters.length === 0 ? (
        <div className="chart-empty">No wait time data available</div>
      ) : (
        <div className="wait-time-grid">
          {clusters.map(cluster => {
            const stats = data[cluster];
            return (
              <div key={cluster} className="wait-time-card">
                <div className="cluster-name">{cluster}</div>
                <div className="wait-stats">
                  <div className="stat">
                    <span className="stat-label">Median</span>
                    <span
                      className="stat-value"
                      style={{ color: getWaitTimeColor(stats.p50) }}
                    >
                      {formatSeconds(stats.p50)}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">p90</span>
                    <span
                      className="stat-value"
                      style={{ color: getWaitTimeColor(stats.p90) }}
                    >
                      {formatSeconds(stats.p90)}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">p99</span>
                    <span
                      className="stat-value"
                      style={{ color: getWaitTimeColor(stats.p99) }}
                    >
                      {formatSeconds(stats.p99)}
                    </span>
                  </div>
                </div>
                <div className="sample-size">
                  {stats.count} sample{stats.count !== 1 ? 's' : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
