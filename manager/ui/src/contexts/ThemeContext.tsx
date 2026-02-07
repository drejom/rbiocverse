/**
 * ThemeContext - Dark/Light theme management
 * Defaults to dark with options for dark/light/auto
 */

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

type Theme = 'dark' | 'light';
type ThemePreference = 'dark' | 'light' | 'auto';

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  isDark: boolean;
  isLight: boolean;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const PREFERENCE_KEY = 'rbiocverse-theme-preference';

/**
 * Get system color scheme preference
 */
function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * ThemeProvider - Manages theme state and persistence
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  // Theme preference: 'dark', 'light', or 'auto'
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    if (typeof window === 'undefined') return 'dark';
    return (localStorage.getItem(PREFERENCE_KEY) as ThemePreference) || 'dark';
  });

  // Actual applied theme (always 'dark' or 'light')
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark';
    const pref = (localStorage.getItem(PREFERENCE_KEY) as ThemePreference) || 'dark';
    if (pref === 'auto') {
      return getSystemTheme();
    }
    return pref;
  });

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.toggle('light-theme', theme === 'light');
  }, [theme]);

  // Listen for system preference changes (only if preference is 'auto')
  useEffect(() => {
    if (preference !== 'auto') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setThemeState(e.matches ? 'dark' : 'light');
    };

    // Set initial value
    setThemeState(mediaQuery.matches ? 'dark' : 'light');

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [preference]);

  // Set theme preference with persistence
  const setPreference = useCallback((newPreference: ThemePreference) => {
    setPreferenceState(newPreference);
    localStorage.setItem(PREFERENCE_KEY, newPreference);

    if (newPreference === 'auto') {
      setThemeState(getSystemTheme());
    } else {
      setThemeState(newPreference);
    }
  }, []);

  // Legacy toggle (for backward compatibility)
  const toggleTheme = useCallback(() => {
    const newTheme: Theme = theme === 'dark' ? 'light' : 'dark';
    setPreference(newTheme);
  }, [theme, setPreference]);

  const value: ThemeContextValue = {
    theme,
    preference,
    isDark: theme === 'dark',
    isLight: theme === 'light',
    setPreference,
    toggleTheme,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * useTheme - Hook to access theme context
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export default ThemeContext;
