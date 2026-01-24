/**
 * AccountUsage - Table of usage by Slurm account/PI
 */
import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { DateRangeSelector } from './DateRangeSelector';
import { ExportButton } from './ExportButton';

interface AccountData {
  account: string;
  uniqueUsers: number;
  sessions: number;
  computeHours: number | null;
  gpuSessions: number;
}

interface SortConfig {
  key: keyof AccountData;
  direction: 'asc' | 'desc';
}

interface SortHeaderProps {
  label: string;
  field: keyof AccountData;
}

interface AccountUsageProps {
  getAuthHeader: () => Record<string, string>;
}

export function AccountUsage({ getAuthHeader }: AccountUsageProps) {
  const [data, setData] = useState<AccountData[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'computeHours', direction: 'desc' });

  useEffect(() => {
    fetchData();
  }, [days]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/by-account?days=${days}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || []);
    } catch (err) {
      console.error('Failed to fetch account usage:', err);
    } finally {
      setLoading(false);
    }
  };

  const sortedData = [...data].sort((a, b) => {
    const aVal = a[sortConfig.key];
    const bVal = b[sortConfig.key];
    if (aVal === null) return 1;
    if (bVal === null) return -1;
    if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const handleSort = (key: keyof AccountData) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  const SortHeader = ({ label, field }: SortHeaderProps) => (
    <th onClick={() => handleSort(field)} style={{ cursor: 'pointer' }}>
      {label}
      {sortConfig.key === field && (
        <span style={{ marginLeft: 4 }}>{sortConfig.direction === 'desc' ? '↓' : '↑'}</span>
      )}
    </th>
  );

  const formatHours = (hours: number | null) => {
    if (hours === null || hours === undefined) return '-';
    return hours.toLocaleString(undefined, { maximumFractionDigits: 1 });
  };

  return (
    <div className="account-usage">
      <div className="table-header">
        <h4>
          <Building2 size={16} style={{ marginRight: 6 }} />
          Usage by Account/PI
        </h4>
        <div className="table-controls">
          <DateRangeSelector
            value={days}
            onChange={setDays}
            ranges={[
              { value: 30, label: '30d' },
              { value: 90, label: '90d' },
              { value: 365, label: '1yr' },
            ]}
          />
          <ExportButton type="summary" days={days} getAuthHeader={getAuthHeader} />
        </div>
      </div>
      <p className="table-description">
        Compute usage breakdown by Slurm account for grant reporting and chargebacks.
      </p>
      {loading ? (
        <div className="table-loading">Loading...</div>
      ) : data.length === 0 ? (
        <div className="table-empty">No account data available.</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <SortHeader label="Account" field="account" />
              <SortHeader label="Users" field="uniqueUsers" />
              <SortHeader label="Sessions" field="sessions" />
              <SortHeader label="Compute Hours" field="computeHours" />
              <SortHeader label="GPU Sessions" field="gpuSessions" />
            </tr>
          </thead>
          <tbody>
            {sortedData.map(account => (
              <tr key={account.account}>
                <td className="account-cell">
                  {account.account === 'unknown' ? (
                    <span className="unknown-account">Not specified</span>
                  ) : (
                    account.account
                  )}
                </td>
                <td>{account.uniqueUsers}</td>
                <td>{account.sessions}</td>
                <td className="compute-hours">{formatHours(account.computeHours)}</td>
                <td>{account.gpuSessions}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Total</strong></td>
              <td><strong>{data.reduce((sum, d) => sum + d.uniqueUsers, 0)}</strong></td>
              <td><strong>{data.reduce((sum, d) => sum + d.sessions, 0)}</strong></td>
              <td className="compute-hours">
                <strong>{formatHours(data.reduce((sum, d) => sum + (d.computeHours || 0), 0))}</strong>
              </td>
              <td><strong>{data.reduce((sum, d) => sum + d.gpuSessions, 0)}</strong></td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
