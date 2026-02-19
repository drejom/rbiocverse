/**
 * InactiveUsers - Table of users with no recent activity
 */
import { useEffect, useState } from 'react';
import { UserMinus } from 'lucide-react';
import log from '../../lib/logger';

interface InactiveUserData {
  user: string;
  lastSession: string | null;
  daysSinceLastSession: number;
  totalSessions: number;
}

interface SortConfig {
  key: keyof InactiveUserData;
  direction: 'asc' | 'desc';
}

interface SortHeaderProps {
  label: string;
  field: keyof InactiveUserData;
}

interface InactiveUsersProps {
  getAuthHeader: () => Record<string, string>;
}

export function InactiveUsers({ getAuthHeader }: InactiveUsersProps) {
  const [data, setData] = useState<InactiveUserData[]>([]);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'daysSinceLastSession', direction: 'desc' });

  useEffect(() => {
    fetchData();
  }, [days]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/inactive?days=${days}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || []);
    } catch (err) {
      log.error('Failed to fetch inactive users', { error: err });
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

  const handleSort = (key: keyof InactiveUserData) => {
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

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString();
  };

  const daysOptions = [
    { value: 60, label: '60+ days' },
    { value: 90, label: '90+ days' },
    { value: 180, label: '180+ days' },
  ];

  return (
    <div className="inactive-users">
      <div className="table-header">
        <h4>
          <UserMinus size={16} style={{ marginRight: 6, color: 'var(--text-muted)' }} />
          Inactive Users
        </h4>
        <div className="date-range-selector">
          {daysOptions.map(opt => (
            <button
              key={opt.value}
              className={`date-range-btn ${days === opt.value ? 'active' : ''}`}
              onClick={() => setDays(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <p className="table-description">
        Users with no session activity in {days}+ days. Consider for account review.
      </p>
      {loading ? (
        <div className="table-loading">Loading...</div>
      ) : data.length === 0 ? (
        <div className="table-empty">No inactive users found.</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <SortHeader label="User" field="user" />
              <SortHeader label="Last Session" field="lastSession" />
              <SortHeader label="Days Inactive" field="daysSinceLastSession" />
              <SortHeader label="Total Sessions" field="totalSessions" />
            </tr>
          </thead>
          <tbody>
            {sortedData.map(user => (
              <tr key={user.user}>
                <td className="user-cell">{user.user}</td>
                <td>{formatDate(user.lastSession)}</td>
                <td className={user.daysSinceLastSession > 180 ? 'highlight warning' : ''}>
                  {Math.round(user.daysSinceLastSession)}
                </td>
                <td>{user.totalSessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
