/**
 * UsageReport - Usage statistics widget
 */
import React, { useState, useEffect } from 'react';
import { Users, Key, Activity, Server, CheckCircle } from 'lucide-react';

export function UsageReport({ getAuthHeader }) {
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
        console.error('Failed to load usage report:', err);
        setLoading(false);
      });
  }, [getAuthHeader]);

  if (loading) {
    return (
      <div className="admin-widget-loading">
        <div className="spinner" />
        <p>Loading report...</p>
      </div>
    );
  }

  if (!stats) {
    return <div className="admin-widget-error">Failed to load report</div>;
  }

  const userStats = stats.stats || {};
  const sessionStats = stats.sessionStats || {};

  return (
    <div className="admin-usage-report">
      <div className="admin-report-section">
        <h4>User Statistics</h4>
        <div className="admin-report-grid">
          <div className="admin-report-item">
            <Users size={16} />
            <div className="admin-report-item-content">
              <span className="admin-report-value">{userStats.totalUsers || 0}</span>
              <span className="admin-report-label">Total Users</span>
            </div>
          </div>

          <div className="admin-report-item">
            <Key size={16} />
            <div className="admin-report-item-content">
              <span className="admin-report-value">{userStats.usersWithKeys || 0}</span>
              <span className="admin-report-label">Managed Keys</span>
            </div>
          </div>

          <div className="admin-report-item">
            <CheckCircle size={16} />
            <div className="admin-report-item-content">
              <span className="admin-report-value">{userStats.usersSetupComplete || 0}</span>
              <span className="admin-report-label">Setup Complete</span>
            </div>
          </div>
        </div>
      </div>

      <div className="admin-report-section">
        <h4>Session Statistics</h4>
        <div className="admin-report-grid">
          <div className="admin-report-item">
            <Activity size={16} />
            <div className="admin-report-item-content">
              <span className="admin-report-value">{sessionStats.activeSessions || 0}</span>
              <span className="admin-report-label">Active Sessions</span>
            </div>
          </div>

          <div className="admin-report-item">
            <Server size={16} />
            <div className="admin-report-item-content">
              <span className="admin-report-value">{sessionStats.pendingSessions || 0}</span>
              <span className="admin-report-label">Pending Sessions</span>
            </div>
          </div>
        </div>
      </div>

      <div className="admin-report-footer">
        Generated: {new Date(stats.generatedAt).toLocaleString()}
      </div>
    </div>
  );
}
