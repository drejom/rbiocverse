/**
 * AuthContext - User authentication state management
 * Handles login, logout, session persistence, and first-login detection
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

const TOKEN_KEY = 'rbiocverse-token';
const USER_KEY = 'rbiocverse-user';

/**
 * AuthProvider - Manages authentication state
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Initialize from localStorage
  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY);
    const storedUser = localStorage.getItem(USER_KEY);

    if (storedToken && storedUser) {
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      } catch (e) {
        // Invalid stored data - clear it
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      }
    }
    setLoading(false);
  }, []);

  // Check session validity
  const checkSession = useCallback(async () => {
    if (!token) return false;

    try {
      const res = await fetch('/api/auth/session', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        return true;
      } else {
        // Session invalid - clear auth
        logout();
        return false;
      }
    } catch (err) {
      console.error('Session check failed:', err);
      return false;
    }
  }, [token]);

  // Login
  const login = useCallback(async (username, password, rememberMe = true) => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, rememberMe }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        setLoading(false);
        return { success: false, error: data.error };
      }

      // Store auth data
      setToken(data.token);
      setUser(data.user);

      if (rememberMe) {
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      }

      setLoading(false);
      return { success: true, user: data.user };
    } catch (err) {
      const errorMsg = 'Connection failed. Please try again.';
      setError(errorMsg);
      setLoading(false);
      return { success: false, error: errorMsg };
    }
  }, []);

  // Logout
  const logout = useCallback(async () => {
    // Clear local state
    setToken(null);
    setUser(null);
    setError(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);

    // Notify server (best effort)
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (e) {
      // Ignore - local logout is complete
    }
  }, [token]);

  // Get auth header for API requests
  const getAuthHeader = useCallback(() => {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [token]);

  // Check if this is the user's first login (needs setup wizard)
  const needsSetup = user && !user.setupComplete;

  // Mark setup as complete
  const completeSetup = useCallback(async () => {
    if (!token) return false;

    try {
      const res = await fetch('/api/auth/complete-setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        return true;
      }
      return false;
    } catch (err) {
      console.error('Complete setup failed:', err);
      return false;
    }
  }, [token]);

  // Generate a managed SSH key
  const generateKey = useCallback(async () => {
    if (!token) return { success: false, error: 'Not authenticated' };

    try {
      const res = await fetch('/api/auth/generate-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (data.success) {
        setUser(data.user);
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        return { success: true };
      }

      return { success: false, error: data.error || 'Failed to generate key' };
    } catch (err) {
      console.error('Generate key failed:', err);
      return { success: false, error: 'Network error' };
    }
  }, [token]);

  // Remove the managed SSH key
  const removeKey = useCallback(async () => {
    if (!token) return { success: false, error: 'Not authenticated' };

    try {
      const res = await fetch('/api/auth/remove-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (data.success) {
        setUser(data.user);
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        return { success: true };
      }

      return {
        success: false,
        error: data.error,
        sshTestResult: data.sshTestResult,
      };
    } catch (err) {
      console.error('Remove key failed:', err);
      return { success: false, error: 'Network error' };
    }
  }, [token]);

  // Regenerate the managed SSH key
  const regenerateKey = useCallback(async () => {
    if (!token) return { success: false, error: 'Not authenticated' };

    try {
      const res = await fetch('/api/auth/regenerate-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (data.success) {
        setUser(data.user);
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        return { success: true };
      }

      return { success: false, error: data.error || 'Failed to regenerate key' };
    } catch (err) {
      console.error('Regenerate key failed:', err);
      return { success: false, error: 'Network error' };
    }
  }, [token]);

  const value = {
    user,
    token,
    loading,
    error,
    isAuthenticated: !!user && !!token,
    needsSetup,
    login,
    logout,
    checkSession,
    getAuthHeader,
    completeSetup,
    generateKey,
    removeKey,
    regenerateKey,
    clearError: () => setError(null),
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth - Hook to access auth context
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
