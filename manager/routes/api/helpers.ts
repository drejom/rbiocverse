/**
 * Shared helpers, interfaces, and singletons for API routes.
 * Extracted from routes/api.ts for reuse across route modules.
 */

import type { Request } from 'express';
import HpcService from '../../services/hpc';
import TunnelService from '../../services/tunnel';
import { parseTimeToSeconds, formatHumanTime } from '../../lib/helpers';
import { config, ides, IdeConfig, ReleaseConfig } from '../../config';
import { log } from '../../lib/logger';
import { errorMessage } from '../../lib/errors';
import { createClusterCache } from '../../lib/cache';
import type { JobInfo, PollingInfo } from '../../lib/state/types';

// Helper to safely get string from req.params (Express types it as string | string[] but it's always string for route params)
export const param = (req: Request, name: string): string => req.params[name] as string;

// Types
export interface StateManager {
  isReady(): boolean;
  getActiveSession(): ActiveSession | null;
  setActiveSession(user: string, hpc: string, ide: string): Promise<void>;
  getSession(user: string, hpc: string, ide: string): Session | null;
  getSessionsForUser(user: string): Record<string, Session | null>;
  getOrCreateSession(user: string, hpc: string, ide: string): Promise<Session>;
  updateSession(user: string, hpc: string, ide: string, updates: Partial<Session>): Promise<Session>;
  clearSession(user: string, hpc: string, ide: string, options?: { endReason?: string }): Promise<void>;
  getPollingInfo(): PollingInfo;
  getClusterHealth(): Record<string, unknown>;
  acquireLock(name: string): void;
  releaseLock(name: string): void;
  onSessionCleared?: ((user: string, hpc: string, ide: string) => void) | null;
}

export interface ActiveSession {
  user: string;
  hpc: string;
  ide: string;
}

export interface Session {
  status: string | null;
  ide?: string;
  jobId?: string | null;
  token?: string | null;
  node?: string | null;
  error?: string | null;
  cpus?: number | null;
  memory?: string | null;
  walltime?: string | null;
  startedAt?: string | null;
  submittedAt?: string | null;
  estimatedStartTime?: string | null;  // SLURM forecast for pending jobs
  releaseVersion?: string | null;
  gpu?: string | null;
  account?: string | null;
  tunnelProcess?: unknown;
  usedDevServer?: boolean;
}

/**
 * Extract user from request
 * In single-user mode, returns config.hpcUser directly.
 * When auth is implemented, this will extract from session/token.
 * @param req - Express request
 * @returns Username
 */
export function getRequestUser(_req: Request): string {
  // Future: return req.session?.user || req.user?.username || config.hpcUser;
  return config.hpcUser;  // Single-user mode: use config.hpcUser directly
}

// Shared tunnel service instance
export const tunnelService = new TunnelService();

// Status cache - reduces SSH calls to HPC clusters
// Long TTL (30min) since we invalidate on user actions (launch/kill)
// Client uses time-aware adaptive polling (15s-1hr) with exponential backoff
// This ensures multi-user environments see updates immediately via cache invalidation
// while dramatically reducing SSH load for stable long-running jobs (6-24+ hours)
export const STATUS_CACHE_TTL = parseInt(process.env.STATUS_CACHE_TTL || '1800000'); // 30 minutes default

// Timing constants for launch/stop operations
export const SLURM_CANCEL_DELAY_MS = 1000;    // Wait for SLURM to process cancellation

// Per-cluster cache to avoid invalidating both clusters on single job change
export const statusCache = createClusterCache(STATUS_CACHE_TTL);

// Progress weights (cumulative percentages) based on observed timing
// Timing: submit ~3s, wait ~3.5s, tunnel+IDE ready ~2-5s (dynamic polling)
export const LAUNCH_PROGRESS: Record<string, number> = {
  connecting: 5,      // Quick SSH connect check
  submitting: 30,     // 2-4s SSH + sbatch
  submitted: 35,      // Instant milestone (shows job ID)
  waiting: 60,        // 3-4s SLURM scheduling (CV 22%)
  starting: 65,       // Instant milestone (shows node name)
  establishing: 100,  // Tunnel + IDE readiness check (~2-5s)
};

/**
 * Invalidate the cluster status cache
 * Call after job state changes (cancel, submit) to force fresh poll
 * @param cluster - Optional cluster name ('gemini' or 'apollo'). If not provided, invalidates all.
 */
export function invalidateStatusCache(cluster: string | null = null): void {
  statusCache.invalidate(cluster);
}

/**
 * Start tunnel with dynamic port discovery
 * Reads the IDE's actual port from the port file before establishing tunnel.
 * This handles port collisions when multiple users land on the same compute node.
 * @param hpc - HPC cluster name
 * @param node - Compute node name
 * @param ide - IDE type
 * @param onExit - Callback when tunnel exits
 * @param user - Username for session tracking (multi-user support)
 * @returns Tunnel process
 */
export async function startTunnelWithPortDiscovery(
  hpc: string,
  node: string,
  ide: string,
  onExit: (code: number | null) => void,
  user: string
): Promise<unknown> {
  const hpcService = new HpcService(hpc, user);
  const remotePort = await hpcService.getIdePort(ide);

  // For VS Code, also get the hpc-proxy port for dev server routing
  let proxyPort: number | undefined;
  if (ide === 'vscode') {
    const port = await hpcService.getProxyPort(user);
    if (port) {
      proxyPort = port;
    }
  }

  return tunnelService.start(hpc, node, ide, onExit, { remotePort, user, proxyPort });
}

/**
 * Ensure a tunnel is running for an existing (reconnect) session.
 * Used when reconnecting to a session that already has a running job.
 * @param session - The session to reconnect
 * @param stateManager - State manager for persisting session updates
 * @param hpc - HPC cluster name
 * @param ide - IDE type
 * @param user - Username for SSH connection
 * @returns ok:true if tunnel is running (or was already running), ok:false with message on failure
 */
export async function ensureTunnelStarted(
  session: Session,
  stateManager: StateManager,
  hpc: string,
  ide: string,
  user: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (session.tunnelProcess) return { ok: true };
  if (!session.node) {
    return { ok: false, message: 'Cannot start tunnel: session has no compute node assigned' };
  }
  try {
    const tunnelProcess = await startTunnelWithPortDiscovery(
      hpc,
      session.node,
      ide,
      makeTunnelOnExit(stateManager, user, hpc, ide),
      user,
    );
    await stateManager.updateSession(user, hpc, ide, { tunnelProcess });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

/**
 * Build the onExit callback for a new-launch tunnel.
 * Refetches session via stateManager to avoid stale local reference.
 * @param stateManager - State manager instance for refetching and updating session
 * @param user - Username for session lookup
 * @param hpc - HPC cluster name
 * @param ide - IDE type
 * @returns Callback that handles tunnel exit by updating session state via stateManager
 */
export function makeTunnelOnExit(
  stateManager: StateManager,
  user: string,
  hpc: string,
  ide: string,
): (code: number | null) => void {
  return (code) => {
    log.tunnel('Exit callback', { hpc, ide, code });
    const currentSession = stateManager.getSession(user, hpc, ide);
    if (currentSession?.status === 'running') {
      stateManager
        .updateSession(user, hpc, ide, { status: 'idle', tunnelProcess: null })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error('Failed to update session on tunnel exit', { error: message, user, hpc, ide });
        });
    }
  };
}

/**
 * Verify a session's job still exists in SLURM
 * Returns true if job exists and matches, false if stale (job gone)
 * @param session - Session object with jobId
 * @param hpc - HPC cluster name
 * @param ide - IDE type
 * @param user - Username for SSH connection
 * @returns True if job exists, false if stale
 */
export async function verifyJobExists(session: Session, hpc: string, ide: string, user: string): Promise<boolean> {
  const hpcService = new HpcService(hpc, user);
  const jobInfo = await hpcService.getJobInfo(ide);
  return jobInfo !== null && jobInfo.jobId === session.jobId;
}

/**
 * Fetch fresh status for a single cluster and update its cache
 * @param clusterName - Cluster name ('gemini' or 'apollo')
 * @returns Fresh cluster status data
 */
export async function fetchSingleClusterStatus(clusterName: string): Promise<Record<string, unknown>> {
  log.info(`Fetching fresh status for ${clusterName}`);

  const hpcService = new HpcService(clusterName);
  const jobs = await hpcService.getAllJobs();

  const formatJobStatus = (job: JobInfo | null): Record<string, unknown> => {
    if (!job) return { status: 'idle' };

    const timeLeftSeconds = parseTimeToSeconds(job.timeLeft || '');
    const timeLimitSeconds = parseTimeToSeconds(job.timeLimit || '');

    return {
      status: job.state === 'RUNNING' ? 'running' : 'pending',
      ide: job.ide,
      jobId: job.jobId,
      node: job.node,
      timeLeft: job.timeLeft,
      timeLeftSeconds,
      timeLeftHuman: formatHumanTime(timeLeftSeconds),
      timeLimit: job.timeLimit,
      timeLimitSeconds,
      cpus: job.cpus,
      memory: job.memory,
      startTime: job.startTime,
    };
  };

  const formatClusterStatus = (clusterJobs: Record<string, JobInfo | null>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [ide, job] of Object.entries(clusterJobs)) {
      result[ide] = formatJobStatus(job);
    }
    return result;
  };

  const freshData = formatClusterStatus(jobs);

  // Update cache for this cluster
  statusCache.set(clusterName, freshData);

  return freshData;
}

/**
 * Fetch fresh cluster status for all clusters and update cache
 * @param stateManager - State manager instance
 * @returns Fresh cluster status data for all clusters
 */
export async function fetchClusterStatus(stateManager: StateManager): Promise<Record<string, unknown>> {
  log.info('Fetching fresh cluster status for all clusters');

  // Fetch both clusters in parallel
  const [geminiData, apolloData] = await Promise.all([
    fetchSingleClusterStatus('gemini'),
    fetchSingleClusterStatus('apollo'),
  ]);

  return {
    gemini: geminiData,
    apollo: apolloData,
    activeSession: stateManager.getActiveSession(),
    ides: Object.fromEntries(
      Object.entries(ides).map(([k, v]) => [k, { name: (v as IdeConfig).name, icon: (v as IdeConfig).icon, proxyPath: (v as IdeConfig).proxyPath }])
    ),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Build session key (user-hpc-ide format)
 * @param user - Username
 * @param hpc - HPC cluster name
 * @param ide - IDE type
 * @returns Session key string
 */
export function buildSessionKey(user: string, hpc: string, ide: string): string {
  const effectiveUser = user || config.hpcUser;
  return `${effectiveUser}-${hpc}-${ide}`;
}

/**
 * Parse session key (user-hpc-ide format)
 * @param key - Session key string
 * @returns Parsed user, hpc, ide or null if invalid
 */
export function parseSessionKey(key: string): { user: string; hpc: string; ide: string } | null {
  const parts = key.split('-');
  if (parts.length >= 3) {
    const ide = parts.pop()!;
    const hpc = parts.pop()!;
    const user = parts.join('-');
    return { user, hpc, ide };
  }
  return null;
}

// Re-export PollingInfo type used in StateManager interface
export type { PollingInfo } from '../../lib/state/types';
// Re-export ReleaseConfig for consumers
export type { IdeConfig };
export type { ReleaseConfig };
