/**
 * AuthContext - User authentication state management
 * Handles login, logout, session persistence, and first-login detection
 *
 * SECURITY NOTE: Token Storage Decision
 * =====================================
 * Tokens are stored in localStorage, which is accessible to JavaScript.
 * This is an acceptable trade-off for this application because:
 *
 * 1. VPN-only access: The application is only accessible from the internal
 *    hospital network via VPN. Public internet access is blocked.
 *
 * 2. HTTPS-only: All traffic is encrypted via Let's Encrypt certificates.
 *
 * 3. No sensitive PHI: This app launches HPC sessions; it doesn't store
 *    patient data directly.
 *
 * 4. UX benefits: localStorage persists across tabs and browser restarts,
 *    avoiding frustrating re-authentication for users running long HPC jobs.
 *
 * Alternative (httpOnly cookies) would provide XSS protection but:
 * - Requires additional backend CSRF handling
 * - Complicates token refresh for long-running sessions
 * - Adds complexity for this internal-only tool
 *
 * If this app were public-facing, httpOnly cookies with CSRF tokens would
 * be the recommended approach.
 */

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import type { User, AuthResult, SshTestResult } from '../types';

interface ImportKeyResult extends AuthResult {
  keyType?: string;
  sshTestResult?: SshTestResult;
}

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  error: string | null;
  isAuthenticated: boolean;
  needsSetup: boolean;
  login: (username: string, password: string, rememberMe?: boolean) => Promise<AuthResult>;
  logout: () => Promise<void>;
  checkSession: () => Promise<boolean>;
  getAuthHeader: () => Record<string, string>;
  completeSetup: () => Promise<boolean>;
  generateKey: (password: string) => Promise<AuthResult>;
  removeKey: () => Promise<AuthResult>;
  regenerateKey: (password: string) => Promise<AuthResult>;
  importKey: (privateKeyPem: string) => Promise<ImportKeyResult>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = 'rbiocverse-token';
const USER_KEY = 'rbiocverse-user';

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * AuthProvider - Manages authentication state
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize from localStorage
  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY);
    const storedUser = localStorage.getItem(USER_KEY);

    if (storedToken && storedUser) {
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      } catch {
        // Invalid stored data - clear it
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      }
    }
    setLoading(false);
  }, []);

  // Logout - defined early so checkSession can reference it
  const logout = useCallback(async () => {
    const currentToken = token;
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
        headers: currentToken ? { Authorization: `Bearer ${currentToken}` } : {},
      });
    } catch {
      // Ignore - local logout is complete
    }
  }, [token]);

  // Check session validity (also handles sliding token refresh)
  const checkSession = useCallback(async (): Promise<boolean> => {
    if (!token) return false;

    try {
      const res = await fetch('/api/auth/session', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        // Handle sliding session token refresh
        const newToken = res.headers.get('X-Refreshed-Token');
        if (newToken && newToken !== token) {
          setToken(newToken);
          localStorage.setItem(TOKEN_KEY, newToken);
        }

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
  }, [token, logout]);

  // Login
  const login = useCallback(async (username: string, password: string, rememberMe = true): Promise<AuthResult> => {
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
    } catch {
      const errorMsg = 'Connection failed. Please try again.';
      setError(errorMsg);
      setLoading(false);
      return { success: false, error: errorMsg };
    }
  }, []);

  // Get auth header for API requests
  const getAuthHeader = useCallback((): Record<string, string> => {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [token]);

  // Check if this is the user's first login (needs setup wizard)
  const needsSetup = !!(user && !user.setupComplete);

  // Mark setup as complete
  const completeSetup = useCallback(async (): Promise<boolean> => {
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

  // Generate a managed SSH key (requires password for encryption)
  const generateKey = useCallback(async (password: string): Promise<AuthResult> => {
    if (!token) return { success: false, error: 'Not authenticated' };
    if (!password) return { success: false, error: 'Password required' };

    try {
      const res = await fetch('/api/auth/generate-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ password }),
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
  const removeKey = useCallback(async (): Promise<AuthResult> => {
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
        sshTestResult: data.sshTestResult as SshTestResult,
      };
    } catch (err) {
      console.error('Remove key failed:', err);
      return { success: false, error: 'Network error' };
    }
  }, [token]);

  // Regenerate the managed SSH key (requires password for encryption)
  const regenerateKey = useCallback(async (password: string): Promise<AuthResult> => {
    if (!token) return { success: false, error: 'Not authenticated' };
    if (!password) return { success: false, error: 'Password required' };

    try {
      const res = await fetch('/api/auth/regenerate-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ password }),
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

  // Import an existing SSH private key (encrypted with server key)
  const importKey = useCallback(async (privateKeyPem: string): Promise<ImportKeyResult> => {
    if (!token) return { success: false, error: 'Not authenticated' };
    if (!privateKeyPem) return { success: false, error: 'Private key required' };

    try {
      const res = await fetch('/api/auth/import-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ privateKeyPem }),
      });

      const data = await res.json();

      if (data.success) {
        setUser(data.user);
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        return { success: true, keyType: data.keyType };
      }

      return {
        success: false,
        error: data.error || 'Failed to import key',
        sshTestResult: data.sshTestResult as SshTestResult,
      };
    } catch (err) {
      console.error('Import key failed:', err);
      return { success: false, error: 'Network error' };
    }
  }, [token]);

  const value: AuthContextValue = {
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
    importKey,
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
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
