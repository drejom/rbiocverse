/**
 * Custom hook for managing countdown timers
 * Decrements time remaining every second for running sessions
 */
import { useState, useEffect, useCallback } from 'react';
import type { ClusterStatus } from '../types';

// Countdown level thresholds (percentage of time remaining)
const CRITICAL_THRESHOLD_PERCENT = 10;
const WARNING_THRESHOLD_PERCENT = 25;

interface CountdownInfo {
  remaining: number;
  total: number;
}

interface CountdownState {
  [key: string]: CountdownInfo;
}

interface UseCountdownReturn {
  countdowns: CountdownState;
  getCountdown: (hpc: string, ide: string) => CountdownInfo | null;
}

interface SessionInfo {
  status?: string;
  timeLeftSeconds?: number;
  timeLimitSeconds?: number;
}

export function useCountdown(sessions: ClusterStatus): UseCountdownReturn {
  // Track countdowns by session key (hpc-ide)
  const [countdowns, setCountdowns] = useState<CountdownState>({});

  // Initialize/update countdowns when sessions change
  useEffect(() => {
    setCountdowns(prev => {
      const next = { ...prev };

      // Add/update countdowns for running sessions
      for (const [hpc, ides] of Object.entries(sessions)) {
        for (const [ide, info] of Object.entries(ides as Record<string, SessionInfo>)) {
          const key = `${hpc}-${ide}`;
          if (info.status === 'running' && info.timeLeftSeconds) {
            // Only initialize if not already tracking
            if (!(key in next)) {
              next[key] = {
                remaining: info.timeLeftSeconds,
                total: info.timeLimitSeconds || info.timeLeftSeconds,
              };
            }
          }
        }
      }

      // Remove countdowns for sessions that are no longer running
      for (const key of Object.keys(next)) {
        const [hpc, ide] = key.split('-');
        const session = (sessions[hpc as keyof ClusterStatus] as Record<string, SessionInfo>)?.[ide];
        if (!session || session.status !== 'running') {
          delete next[key];
        }
      }

      return next;
    });
  }, [sessions]);

  // Tick every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdowns(prev => {
        const next = { ...prev };
        let changed = false;

        for (const key of Object.keys(next)) {
          if (next[key].remaining > 0) {
            next[key] = {
              ...next[key],
              remaining: next[key].remaining - 1,
            };
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Get countdown for a specific session
  const getCountdown = useCallback((hpc: string, ide: string): CountdownInfo | null => {
    const key = `${hpc}-${ide}`;
    return countdowns[key] || null;
  }, [countdowns]);

  return { countdowns, getCountdown };
}

/**
 * Format seconds to human-readable time string
 */
export function formatTime(seconds: number | undefined | null): string {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type CountdownLevel = 'normal' | 'warning' | 'critical';

/**
 * Get countdown status level for styling
 */
export function getCountdownLevel(remaining: number, total: number): CountdownLevel {
  if (!total || total <= 0) return 'normal';
  const percent = (remaining / total) * 100;
  if (percent <= CRITICAL_THRESHOLD_PERCENT) return 'critical';
  if (percent <= WARNING_THRESHOLD_PERCENT) return 'warning';
  return 'normal';
}
