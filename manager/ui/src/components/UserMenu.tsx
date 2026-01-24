/**
 * UserMenu - User avatar dropdown with profile actions
 */

import { useState, useRef, useEffect } from 'react';
import { Key, LogOut, ChevronDown, Moon, Sun, Monitor } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import KeyManagementModal from './KeyManagementModal';

function UserMenu() {
  const { user, logout } = useAuth();
  const { preference, setPreference } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: globalThis.MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Get user initials for avatar
  const getInitials = (): string => {
    if (!user?.fullName) return user?.username?.[0]?.toUpperCase() || '?';
    const names = user.fullName.split(' ');
    return names.map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

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
            Manage Keys
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

      {/* Key Management Modal */}
      <KeyManagementModal
        isOpen={showKeyModal}
        onClose={() => setShowKeyModal(false)}
      />
    </div>
  );
}

export default UserMenu;
