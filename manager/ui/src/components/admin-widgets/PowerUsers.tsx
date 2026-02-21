/**
 * PowerUsers - Table of users with high resource usage patterns
 */
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { DateRangeSelector } from './DateRangeSelector';
import log from '../../lib/logger';

interface PowerUserData {
  user: string;
  sessions: number;
  avgCpus: number;
  avgDuration: number;
  gpuSessions: number;
}

interface SortConfig {
  key: keyof PowerUserData;
  direction: 'asc' | 'desc';
}

interface SortHeaderProps {
  label: string;
  field: keyof PowerUserData;
}

interface PowerUsersProps {
  getAuthHeader: () => Record<string, string>;
}

export function PowerUsers({ getAuthHeader }: PowerUsersProps) {
  const [data, setData] = useState<PowerUserData[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'avgCpus', direction: 'desc' });

  useEffect(() => {
    fetchData();
  }, [days]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/power-users?days=${days}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || []);
    } catch (err) {
      log.error('Failed to fetch power users', { error: err });
    } finally {
      setLoading(false);
    }
  };

  const sortedData = [...data].sort((a, b) => {
    const aVal = a[sortConfig.key];
    const bVal = b[sortConfig.key];
    if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const handleSort = (key: keyof PowerUserData) => {
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

  return (
    <div className="power-users">
      <div className="table-header">
        <h4>
          <AlertTriangle size={16} style={{ marginRight: 6, color: '#F59E0B' }} />
          Power Users (Training Candidates)
        </h4>
        <DateRangeSelector
          value={days}
          onChange={setDays}
          ranges={[
            { value: 30, label: '30d' },
            { value: 90, label: '90d' },
          ]}
        />
      </div>
      <p className="table-description">
        Users with high resource usage patterns who may benefit from HPC training.
      </p>
      {loading ? (
        <div className="table-loading">Loading...</div>
      ) : data.length === 0 ? (
        <div className="table-empty">No power users found in this period.</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <SortHeader label="User" field="user" />
              <SortHeader label="Sessions" field="sessions" />
              <SortHeader label="Avg CPUs" field="avgCpus" />
              <SortHeader label="Avg Duration" field="avgDuration" />
              <SortHeader label="GPU Sessions" field="gpuSessions" />
            </tr>
          </thead>
          <tbody>
            {sortedData.map(user => (
              <tr key={user.user}>
                <td className="user-cell">{user.user}</td>
                <td>{user.sessions}</td>
                <td className={user.avgCpus > 16 ? 'highlight' : ''}>
                  {Math.round(user.avgCpus)}
                </td>
                <td className={user.avgDuration > 480 ? 'highlight' : ''}>
                  {Math.round(user.avgDuration)} min
                </td>
                <td>{user.gpuSessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
