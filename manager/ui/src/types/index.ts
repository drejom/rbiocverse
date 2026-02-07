/**
 * Shared TypeScript types for the UI
 */

// User types
export interface User {
  username: string;
  fullName?: string;
  publicKey?: string | null;
  setupComplete: boolean;
  isAdmin?: boolean;
  hasActiveKey?: boolean;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  user?: User;
  sshTestResult?: SshTestResult;
}

export interface SshTestResult {
  gemini: boolean;
  apollo: boolean;
  bothSucceeded: boolean;
  geminiError?: string;
  apolloError?: string;
}

// Cluster types
export type ClusterName = 'gemini' | 'apollo';

export interface ClusterHealth {
  online?: boolean;
  cpus?: {
    percent?: number | null;
    used?: number | null;
    total?: number | null;
  };
  memory?: {
    percent?: number | null;
    used?: number | null;
    total?: number | null;
    unit?: string;
  };
  nodes?: {
    percent?: number | null;
    idle?: number | null;
    busy?: number | null;
    down?: number | null;
    total?: number | null;
  };
  gpus?: Record<string, unknown> | null;
  runningJobs?: number;
  pendingJobs?: number;
  lastChecked?: string | null;
}

export interface ClusterHistoryPoint {
  timestamp: string;
  cpuPercent?: number;
  memoryPercent?: number;
  nodePercent?: number;
}

export interface ClusterStatus {
  gemini: Record<string, IdeStatus>;
  apollo: Record<string, IdeStatus>;
}

export interface ClusterConfig {
  ides: Record<string, IdeConfig>;
  releases: Record<string, ReleaseConfig>;
  defaultReleaseVersion: string | null;
  gpuConfig: Record<string, GpuConfig>;
  partitionLimits: Record<string, Record<string, PartitionLimits>>;
  defaultPartitions: Record<string, string>;
  defaultCpus: string;
  defaultMem: string;
  defaultTime: string;
}

// IDE types
export interface IdeConfig {
  name: string;
  icon?: string;
  description?: string;
  defaultPort?: number;
}

export interface IdeStatus {
  status: 'idle' | 'pending' | 'running' | 'stopping' | 'error';
  jobId?: string;
  url?: string;
  timeRemaining?: number;
  startTime?: string;
  endTime?: string;
  error?: string;
  resources?: {
    cpus?: number;
    memory?: string;
    partition?: string;
    gpus?: number;
  };
}

// Release and partition types
export interface ReleaseConfig {
  version: string;
  label?: string;
  bioconductor?: string;
  r?: string;
  default?: boolean;
}

export interface GpuTypeConfig {
  type?: string;
  count?: number;
  partition?: string;
}

export type GpuConfig = Record<string, GpuTypeConfig>;

export interface PartitionLimits {
  isDefault?: boolean;
  maxCpus?: number;
  maxMemMB?: number | null;
  maxMemGB?: number | null;
  maxTime?: string;
  defaultTime?: string;
  gpuType?: string | null;
  gpuCount?: number | null;
  restricted?: boolean;
  restrictionReason?: string | null;
}

// Launch types
export interface LaunchOptions {
  release?: string;
  cpus?: string | number;
  memory?: string;
  time?: string;
  partition?: string;
  gpus?: number;
  enableShiny?: boolean;
  enableLiveServer?: boolean;
}

export interface LaunchState {
  active: boolean;
  header?: string;
  message?: string;
  progress?: number;
  step?: string;
  error?: string | null;
  pending?: boolean;
  indeterminate?: boolean;
  isSshError?: boolean;
}

// API types
export interface ApiError extends Error {
  status: number;
  details?: unknown;
}

// Admin types
export interface AdminStats {
  totalSessions: number;
  uniqueUsers: number;
  activeToday: number;
  averageSessionDuration: number;
}

export interface SessionRecord {
  id: string;
  username: string;
  cluster: string;
  ide: string;
  startTime: string;
  endTime?: string;
  duration?: number;
  status: string;
}
