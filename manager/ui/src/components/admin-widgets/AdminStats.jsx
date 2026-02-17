/**
 * AdminStats - Quick stats overview for admin dashboard
 */
import React, { useState, useEffect } from 'react';
import { Users, Key, Server, Activity } from 'lucide-react';

export function AdminStats({ getAuthHeader }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/reports/usage', {
      headers: getAuthHeader(),
    })
      .then(res => res.json())
      .then(data => {
        setStats(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load stats:', err);
        setLoading(false);
      });
  }, [getAuthHeader]);

  if (loading) {
    return (
      <div className="admin-stats-loading">
        <div className="spinner" />
      </div>
    );
  }

  if (!stats) {
    return <div className="admin-stats-error">Failed to load stats</div>;
  }

  return (
    <div className="admin-stats">
      <div className="admin-stat-card">
        <div className="admin-stat-icon">
          <Users size={20} />
        </div>
        <div className="admin-stat-content">
          <div className="admin-stat-value">{stats.stats?.totalUsers || 0}</div>
          <div className="admin-stat-label">Total Users</div>
        </div>
      </div>

      <div className="admin-stat-card">
        <div className="admin-stat-icon">
          <Key size={20} />
        </div>
        <div className="admin-stat-content">
          <div className="admin-stat-value">{stats.stats?.usersWithKeys || 0}</div>
          <div className="admin-stat-label">Managed Keys</div>
        </div>
      </div>

      <div className="admin-stat-card">
        <div className="admin-stat-icon">
          <Activity size={20} />
        </div>
        <div className="admin-stat-content">
          <div className="admin-stat-value">{stats.sessionStats?.activeSessions || 0}</div>
          <div className="admin-stat-label">Active Sessions</div>
        </div>
      </div>

      <div className="admin-stat-card">
        <div className="admin-stat-icon">
          <Server size={20} />
        </div>
        <div className="admin-stat-content">
          <div className="admin-stat-value">{stats.stats?.usersSetupComplete || 0}</div>
          <div className="admin-stat-label">Setup Complete</div>
        </div>
      </div>
    </div>
  );
}
