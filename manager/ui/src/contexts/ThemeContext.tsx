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
const VALID_PREFERENCES: ThemePreference[] = ['auto', 'light', 'dark'];

/**
 * Validate and return a valid theme preference
 */
function validatePreference(value: string | null): ThemePreference {
  if (value && VALID_PREFERENCES.includes(value as ThemePreference)) {
    return value as ThemePreference;
  }
  return 'auto';
}

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
  // Theme preference: 'auto', 'light', or 'dark' (auto is default)
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    if (typeof window === 'undefined') return 'auto';
    return validatePreference(localStorage.getItem(PREFERENCE_KEY));
  });

  // Actual applied theme (always 'dark' or 'light')
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return getSystemTheme();
    const pref = validatePreference(localStorage.getItem(PREFERENCE_KEY));
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

  // Cycle through: system → light → dark → system
  const toggleTheme = useCallback(() => {
    const cycle: ThemePreference[] = ['auto', 'light', 'dark'];
    const currentIndex = cycle.indexOf(preference);
    const nextIndex = (currentIndex + 1) % cycle.length;
    setPreference(cycle[nextIndex]);
  }, [preference, setPreference]);

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
// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export default ThemeContext;
