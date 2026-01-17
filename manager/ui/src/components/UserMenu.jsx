/**
 * UserMenu - User avatar dropdown with profile actions
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Key, LogOut, ChevronDown, Copy, Download, CheckCircle, Moon, Sun, Monitor } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';

function UserMenu() {
  const { user, logout } = useAuth();
  const { preference, setPreference } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Get user initials for avatar
  const getInitials = () => {
    if (!user?.fullName) return user?.username?.[0]?.toUpperCase() || '?';
    const names = user.fullName.split(' ');
    return names.map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  // Copy public key
  const copyKey = useCallback(async () => {
    if (!user?.publicKey) return;
    try {
      await navigator.clipboard.writeText(user.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }, [user?.publicKey]);

  // Download public key
  const downloadKey = useCallback(() => {
    if (!user?.publicKey) return;
    const blob = new Blob([user.publicKey], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rbiocverse_id.pub';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [user?.publicKey]);

  if (!user) return null;

  return (
    <div className="user-menu-container" ref={menuRef}>
      <button
        className="user-menu-trigger"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <div className="user-avatar">{getInitials()}</div>
        <span className="user-name">{user.fullName || user.username}</span>
        <ChevronDown size={16} style={{ opacity: 0.5 }} />
      </button>

      {isOpen && (
        <div className="user-menu-dropdown">
          {/* User info */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              {user.fullName || user.username}
            </div>
            {user.fullName && (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {user.username}
              </div>
            )}
          </div>

          {/* Theme options */}
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Theme
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                className={`theme-option ${preference === 'dark' ? 'active' : ''}`}
                onClick={() => setPreference('dark')}
                title="Dark"
              >
                <Moon size={14} />
              </button>
              <button
                className={`theme-option ${preference === 'light' ? 'active' : ''}`}
                onClick={() => setPreference('light')}
                title="Light"
              >
                <Sun size={14} />
              </button>
              <button
                className={`theme-option ${preference === 'auto' ? 'active' : ''}`}
                onClick={() => setPreference('auto')}
                title="System"
              >
                <Monitor size={14} />
              </button>
            </div>
          </div>

          {/* Menu items */}
          <button
            className="user-menu-item"
            onClick={() => {
              setShowKeyModal(true);
              setIsOpen(false);
            }}
          >
            <Key size={16} />
            View Public Key
          </button>

          <div className="user-menu-divider" />

          <button
            className="user-menu-item danger"
            onClick={() => {
              setIsOpen(false);
              logout();
            }}
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      )}

      {/* Public Key Modal */}
      {showKeyModal && (
        <div
          className="loading-overlay"
          onClick={() => setShowKeyModal(false)}
        >
          <div
            style={{
              background: 'var(--bg-panel)',
              borderRadius: '16px',
              padding: '24px',
              width: 'min(500px, 90vw)',
              maxHeight: '80vh',
              overflow: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '16px', color: 'var(--text-primary)' }}>
              Your Public Key
            </h3>
            <p style={{ marginBottom: '16px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              This is the SSH public key used for HPC cluster authentication.
            </p>

            <div
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '16px',
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                wordBreak: 'break-all',
                color: 'var(--text-secondary)',
              }}
            >
              {user?.publicKey || 'No public key available'}
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                className={`key-btn ${copied ? 'copied' : ''}`}
                onClick={copyKey}
                style={{ flex: 1 }}
              >
                {copied ? (
                  <>
                    <CheckCircle size={16} />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy size={16} />
                    Copy
                  </>
                )}
              </button>

              <button
                className="key-btn"
                onClick={downloadKey}
                style={{ flex: 1 }}
              >
                <Download size={16} />
                Download
              </button>

              <button
                className="key-btn"
                onClick={() => setShowKeyModal(false)}
                style={{ flex: 1 }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default UserMenu;
