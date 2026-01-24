/**
 * Core type definitions for HPC Code Server Manager
 */

import { Request } from 'express';

// ============================================================================
// Configuration Types
// ============================================================================

export interface ClusterConfig {
  host: string;
  partition: string;
  singularityBin: string;
  singularityImage: string;
  rLibsSite: string;
  bindPaths: string;
}

export interface IdeConfig {
  port: number;
  name: string;
  command: string;
  healthPath: string;
}

export interface ReleasePaths {
  singularityImage: string;
  rLibsSite: string;
}

export interface ReleaseConfig {
  name: string;
  ides: string[];
  paths: {
    gemini: ReleasePaths;
    apollo: ReleasePaths;
  };
}

export interface Config {
  port: number;
  hpcUser: string;
  stateFile: string;
  additionalPorts: number[];
  defaultPartition: string;
  defaultTime: string;
  defaultCpus: number;
  defaultMem: string;
  singularityBin: string;
  proxyHealthPath: string;
}

// ============================================================================
// Session Types
// ============================================================================

export interface Session {
  jobId: string;
  node?: string;
  port?: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  releaseVersion?: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
}

export interface SessionMap {
  [key: string]: Session;
}

export interface StateData {
  sessions: SessionMap;
  activeSession: string | null;
}

export interface ClearSessionOptions {
  endReason?: string;
}

// ============================================================================
// HPC Types
// ============================================================================

export interface JobInfo {
  jobId: string;
  node?: string;
  state: string;
  partition?: string;
  name?: string;
  timeUsed?: string;
  timeLimit?: string;
}

export interface JobSubmitOptions {
  partition?: string;
  time?: string;
  cpus?: number;
  mem?: string;
  releaseVersion?: string;
}

export interface CancelJobsResult {
  cancelled: string[];
  failed: string[];
}

export interface ClusterHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  totalNodes: number;
  availableNodes: number;
  cpuUsage: number;
  memoryUsage: number;
  runningJobs: number;
  pendingJobs: number;
  queueWaitTime?: number;
}

// ============================================================================
// Tunnel Types
// ============================================================================

export interface TunnelInfo {
  process: import('child_process').ChildProcess;
  hpc: string;
  ide: string;
  node: string;
  localPort: number;
  remotePort: number;
  user: string;
  startedAt: Date;
}

export interface TunnelStartOptions {
  remotePort?: number;
  user?: string;
}

// ============================================================================
// API Types
// ============================================================================

export interface AuthenticatedRequest extends Request {
  user?: {
    username: string;
    name?: string;
    email?: string;
  };
}

export interface ApiError {
  error: string;
  message?: string;
  details?: unknown;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================================
// Cache Types
// ============================================================================

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export interface CacheResult<T> {
  valid: boolean;
  data: T | null;
  age: number;
}

// ============================================================================
// SSH Queue Types
// ============================================================================

export interface QueueStats {
  cluster: string;
  pending: number;
  processing: boolean;
}

// ============================================================================
// Logger Types
// ============================================================================

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogMeta {
  [key: string]: unknown;
}

export interface Logger {
  error: (message: string, meta?: LogMeta) => void;
  warn: (message: string, meta?: LogMeta) => void;
  info: (message: string, meta?: LogMeta) => void;
  debug: (message: string, meta?: LogMeta) => void;
  job: (message: string, meta?: LogMeta) => void;
  ssh: (message: string, meta?: LogMeta) => void;
  tunnel: (message: string, meta?: LogMeta) => void;
  proxy: (message: string, meta?: LogMeta) => void;
  debugFor: (component: string, message: string, meta?: LogMeta) => void;
}
