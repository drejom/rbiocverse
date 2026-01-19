/**
 * UserTable - User management table with actions
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Search, Trash2, Key, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

export function UserTable({ getAuthHeader }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [actionLoading, setActionLoading] = useState(null);

  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users', {
        headers: getAuthHeader(),
      });
      const data = await res.json();
      setUsers(data.users || []);
      setLoading(false);
    } catch (err) {
      console.error('Failed to load users:', err);
      setLoading(false);
    }
  }, [getAuthHeader]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleDeleteKey = async (username) => {
    if (!confirm(`Delete SSH key for ${username}? They will need to re-setup.`)) return;

    setActionLoading(username);
    try {
      await fetch(`/api/admin/users/${username}/key`, {
        method: 'DELETE',
        headers: getAuthHeader(),
      });
      await loadUsers();
    } catch (err) {
      console.error('Failed to delete key:', err);
    }
    setActionLoading(null);
  };

  const handleDeleteUser = async (username) => {
    if (!confirm(`Delete user ${username}? This cannot be undone.`)) return;

    setActionLoading(username);
    try {
      await fetch(`/api/admin/users/${username}`, {
        method: 'DELETE',
        headers: getAuthHeader(),
      });
      await loadUsers();
    } catch (err) {
      console.error('Failed to delete user:', err);
    }
    setActionLoading(null);
  };

  const handleBulkAction = async (action) => {
    if (selectedUsers.size === 0) return;

    const actionLabel = action === 'delete' ? 'delete' : 'delete keys for';
    if (!confirm(`Are you sure you want to ${actionLabel} ${selectedUsers.size} user(s)?`)) return;

    setActionLoading('bulk');
    try {
      await fetch('/api/admin/users/bulk', {
        method: 'POST',
        headers: {
          ...getAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          usernames: Array.from(selectedUsers),
        }),
      });
      setSelectedUsers(new Set());
      await loadUsers();
    } catch (err) {
      console.error('Bulk action failed:', err);
    }
    setActionLoading(null);
  };

  const toggleSelect = (username) => {
    const next = new Set(selectedUsers);
    if (next.has(username)) {
      next.delete(username);
    } else {
      next.add(username);
    }
    setSelectedUsers(next);
  };

  const toggleSelectAll = () => {
    if (selectedUsers.size === filteredUsers.length) {
      setSelectedUsers(new Set());
    } else {
      setSelectedUsers(new Set(filteredUsers.map(u => u.username)));
    }
  };

  const filteredUsers = users.filter(u =>
    u.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.fullName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="admin-widget-loading">
        <div className="spinner" />
        <p>Loading users...</p>
      </div>
    );
  }

  return (
    <div className="admin-user-table">
      {/* Search and bulk actions */}
      <div className="admin-table-toolbar">
        <div className="admin-table-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {selectedUsers.size > 0 && (
          <div className="admin-bulk-actions">
            <span className="admin-bulk-count">{selectedUsers.size} selected</span>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => handleBulkAction('delete-keys')}
              disabled={actionLoading === 'bulk'}
            >
              <Key size={12} />
              Delete Keys
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => handleBulkAction('delete')}
              disabled={actionLoading === 'bulk'}
            >
              <Trash2 size={12} />
              Delete Users
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="admin-table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={selectedUsers.size === filteredUsers.length && filteredUsers.length > 0}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>Username</th>
              <th>Full Name</th>
              <th style={{ width: 80 }}>Key</th>
              <th style={{ width: 80 }}>Setup</th>
              <th style={{ width: 120 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  {searchQuery ? 'No matching users' : 'No users found'}
                </td>
              </tr>
            ) : (
              filteredUsers.map(user => (
                <tr key={user.username}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedUsers.has(user.username)}
                      onChange={() => toggleSelect(user.username)}
                    />
                  </td>
                  <td className="admin-table-username">{user.username}</td>
                  <td>{user.fullName || '-'}</td>
                  <td>
                    {user.hasPublicKey ? (
                      <CheckCircle size={16} className="admin-icon-success" />
                    ) : (
                      <XCircle size={16} className="admin-icon-muted" />
                    )}
                  </td>
                  <td>
                    {user.setupComplete ? (
                      <CheckCircle size={16} className="admin-icon-success" />
                    ) : (
                      <AlertCircle size={16} className="admin-icon-warning" />
                    )}
                  </td>
                  <td>
                    <div className="admin-table-actions">
                      {user.hasPublicKey && (
                        <button
                          className="admin-action-btn"
                          onClick={() => handleDeleteKey(user.username)}
                          disabled={actionLoading === user.username}
                          title="Delete SSH key"
                        >
                          <Key size={14} />
                        </button>
                      )}
                      <button
                        className="admin-action-btn admin-action-danger"
                        onClick={() => handleDeleteUser(user.username)}
                        disabled={actionLoading === user.username}
                        title="Delete user"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="admin-table-footer">
        {filteredUsers.length} user(s)
      </div>
    </div>
  );
}
