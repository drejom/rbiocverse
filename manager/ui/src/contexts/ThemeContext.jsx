/**
 * ThemeContext - Dark/Light theme management
 * Defaults to dark with options for dark/light/auto
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const ThemeContext = createContext(null);

const STORAGE_KEY = 'rbiocverse-theme';
const PREFERENCE_KEY = 'rbiocverse-theme-preference'; // 'dark', 'light', or 'auto'

/**
 * Get system color scheme preference
 */
function getSystemTheme() {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * ThemeProvider - Manages theme state and persistence
 */
export function ThemeProvider({ children }) {
  // Theme preference: 'dark', 'light', or 'auto'
  const [preference, setPreferenceState] = useState(() => {
    if (typeof window === 'undefined') return 'dark';
    return localStorage.getItem(PREFERENCE_KEY) || 'dark'; // Default to dark
  });

  // Actual applied theme (always 'dark' or 'light')
  const [theme, setThemeState] = useState(() => {
    if (typeof window === 'undefined') return 'dark';
    const pref = localStorage.getItem(PREFERENCE_KEY) || 'dark';
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
    const handler = (e) => {
      setThemeState(e.matches ? 'dark' : 'light');
    };

    // Set initial value
    setThemeState(mediaQuery.matches ? 'dark' : 'light');

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [preference]);

  // Set theme preference with persistence
  const setPreference = useCallback((newPreference) => {
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
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setPreference(newTheme);
  }, [theme, setPreference]);

  const value = {
    theme,           // Current applied theme: 'dark' or 'light'
    preference,      // User preference: 'dark', 'light', or 'auto'
    isDark: theme === 'dark',
    isLight: theme === 'light',
    setPreference,   // Set preference to 'dark', 'light', or 'auto'
    toggleTheme,     // Legacy toggle
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
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export default ThemeContext;
