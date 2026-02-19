/**
 * State management types, constants, and utility functions
 *
 * This module contains:
 * - Interface definitions for state management
 * - Constants for polling configuration
 * - Utility functions for session key handling
 */

import { config } from '../../config';
import type { Session } from '../db/sessions';
import type { ClusterHealth, HealthHistoryEntry } from '../db/healthSchema';

// Re-export types from db modules for convenience
export type { Session, ClusterHealth, HealthHistoryEntry };

// ============================================
// Interfaces
// ============================================

/**
 * Interface for HPC service operations
 */
export interface HpcService {
  checkJobExists(jobId: string): Promise<boolean>;
  getAllJobs(): Promise<Record<string, JobInfo>>;
  getClusterHealth(options?: { userAccount?: string | null }): Promise<ClusterHealth>;
  getUserDefaultAccount(user: string): Promise<string | null>;
}

/**
 * Job information from SLURM
 */
export interface JobInfo {
  jobId: string;
  state: string;
  node?: string;
  timeLeftSeconds?: number;
  startTime?: string | null; // For pending jobs: SLURM's estimated start time
}

/**
 * Factory function type for creating HPC service instances
 */
export type HpcServiceFactory = (hpc: string) => HpcService;

/**
 * Parsed components of a session key
 */
export interface ParsedSessionKey {
  user: string;
  hpc: string;
  ide: string;
}

/**
 * Reference to the currently active session
 */
export interface ActiveSession {
  user: string;
  hpc: string;
  ide: string;
}

/**
 * Cluster health state with history tracking
 */
export interface ClusterHealthState {
  current: ClusterHealth | null;
  history: HealthHistoryEntry[];
  lastRolloverAt?: number;
  consecutiveFailures: number;
}

/**
 * Application state structure
 */
export interface AppState {
  sessions: Record<string, Session | null>;
  activeSession: ActiveSession | null;
  clusterHealth?: Record<string, ClusterHealthState>;
}

/**
 * Cached user SLURM account information
 */
export interface UserAccountCache {
  account: string | null;
  fetchedAt: number;
}

/**
 * Polling status information for API responses
 */
export interface PollingInfo {
  jobPolling: {
    lastPollTime: number | null;
    nextPollTime: number | null;
    consecutiveUnchangedPolls: number;
    currentInterval: number;
  };
  healthPolling: {
    lastPollTime: number | null;
    interval: number;
  };
}

/**
 * Options for clearing a session
 */
export interface ClearSessionOptions {
  endReason?: string;
  errorMessage?: string | null;
}

// ============================================
// Constants
// ============================================

/**
 * One day in milliseconds
 */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Polling configuration
 *
 * Two independent polling loops:
 * 1. Job polling (adaptive) - checks job status, interval varies by job state
 * 2. Health polling (fixed) - checks cluster health every 30 minutes
 *
 * Job polling uses batch queries: 1 SSH call per cluster (parallel) via getAllJobs()
 * This scales well regardless of number of active sessions.
 */
export const POLLING_CONFIG = {
  // Job polling: adaptive based on job state
  JOB_POLLING: {
    // Time thresholds (seconds) for determining polling frequency
    THRESHOLDS_SECONDS: {
      NEAR_EXPIRY: 600, // 10 min - jobs about to expire
      APPROACHING_END: 1800, // 30 min - jobs approaching end
      MODERATE: 3600, // 1 hr - moderate time remaining
      STABLE: 21600, // 6 hr - long-running stable jobs
    },
    // Polling intervals (milliseconds) for each state
    INTERVALS_MS: {
      FREQUENT: 15000, // 15s - for pending jobs or near expiry
      MODERATE: 60000, // 1m - for jobs approaching end
      RELAXED: 300000, // 5m - for jobs with 30min-1hr left
      INFREQUENT: 600000, // 10m - for jobs with 1-6hr left
      IDLE: 1800000, // 30m - for very stable jobs or no sessions
      MAX: 3600000, // 1hr - absolute maximum interval
    },
    // Exponential backoff configuration
    BACKOFF: {
      START_THRESHOLD: 3, // Apply backoff after 3 unchanged polls
      MULTIPLIER: 1.5, // Multiply interval by 1.5x each time
      MAX_EXPONENT: 3, // Cap exponent at 3 (max multiplier: 3.375x)
    },
  },
  // Health polling: fixed interval (independent of job state)
  HEALTH_POLLING: {
    INTERVAL_MS: 30 * 60 * 1000, // 30 minutes
  },
} as const;

// ============================================
// Utility functions
// ============================================

/**
 * Build session key from components
 * Format: user-hpc-ide (e.g., domeally-gemini-vscode)
 */
export function buildSessionKey(user: string | null, hpc: string, ide: string): string {
  const effectiveUser = user || config.hpcUser;
  return `${effectiveUser}-${hpc}-${ide}`;
}

/**
 * Parse session key into components
 * Format: user-hpc-ide (e.g., domeally-gemini-vscode)
 *
 * Returns null if the key doesn't have at least 3 parts (user-hpc-ide)
 */
export function parseSessionKey(sessionKey: string): ParsedSessionKey | null {
  const parts = sessionKey.split('-');
  if (parts.length >= 3) {
    // user-hpc-ide format (user may contain hyphens)
    // IDE is always last, HPC is second-to-last, user is everything before
    const ide = parts.pop()!;
    const hpc = parts.pop()!;
    const user = parts.join('-');
    return { user, hpc, ide };
  }
  return null;
}

/**
 * Create a fresh idle session object
 * Use this to ensure consistent session structure across the codebase
 */
export function createIdleSession(ide: string): Session {
  return {
    status: 'idle',
    ide: ide,
    user: '',
    jobId: null,
    node: null,
    tunnelProcess: null,
    startedAt: null,
    estimatedStartTime: null,
    cpus: null,
    memory: null,
    walltime: null,
    error: null,
    lastActivity: null,
    token: null,
    releaseVersion: null,
    gpu: null,
    account: null,
    submittedAt: null,
    timeLeftSeconds: null,
    usedDevServer: false,
  };
}
