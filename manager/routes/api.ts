/**
 * API Routes
 * Handles all /api/* endpoints using extracted services
 *
 * Multi-user ready: All session operations accept a user parameter.
 * In single-user mode, user defaults to config.hpcUser.
 * When auth is added, user will come from req.session.user or similar.
 */

import express, { Request, Response, Router } from 'express';

const router = express.Router();

// Parse JSON bodies only for API routes (not globally, which breaks http-proxy)
router.use(express.json());

import HpcService from '../services/hpc';
import TunnelService from '../services/tunnel';
import { validateSbatchInputs, validateHpcName } from '../lib/validation';
import { parseTimeToSeconds, formatHumanTime } from '../lib/helpers';
import { asyncHandler } from '../lib/asyncHandler';
import { config, ides, gpuConfig, releases, defaultReleaseVersion, partitionLimits, clusters, ReleaseConfig } from '../config';
import { log } from '../lib/logger';
import { createClusterCache } from '../lib/cache';

// Helper to safely get string from req.params (Express types it as string | string[] but it's always string for route params)
const param = (req: Request, name: string): string => req.params[name] as string;

// Types
interface StateManager {
  isReady(): boolean;
  getActiveSession(): ActiveSession | null;
  setActiveSession(user: string, hpc: string, ide: string): Promise<void>;
  getSession(user: string, hpc: string, ide: string): Session | null;
  getSessionsForUser(user: string): Record<string, Session | null>;
  getOrCreateSession(user: string, hpc: string, ide: string): Promise<Session>;
  updateSession(user: string, hpc: string, ide: string, updates: Partial<Session>): Promise<void>;
  clearSession(user: string, hpc: string, ide: string, options?: { endReason?: string }): Promise<void>;
  getPollingInfo(): { lastPollTime: number | null; nextPollTime: number | null; currentInterval: number };
  getClusterHealth(): Record<string, unknown>;
  acquireLock(name: string): void;
  releaseLock(name: string): void;
  state: {
    sessions: Record<string, Session | null>;
  };
  onSessionCleared?: (user: string, hpc: string, ide: string) => void;
}

interface ActiveSession {
  user: string;
  hpc: string;
  ide: string;
}

interface Session {
  status: 'idle' | 'starting' | 'pending' | 'running';
  ide?: string;
  jobId?: string;
  token?: string;
  node?: string;
  error?: string | null;
  cpus?: number;
  memory?: string;
  walltime?: string;
  startedAt?: string;
  submittedAt?: string;
  estimatedStartTime?: string | null;  // SLURM forecast for pending jobs
  releaseVersion?: string;
  gpu?: string | null;
  account?: string | null;
  tunnelProcess?: unknown;
  usedDevServer?: boolean;
}

interface JobInfo {
  jobId: string;
  node?: string;
  state?: string;
  ide?: string;
  timeLeft?: string;
  timeLimit?: string;
  cpus?: number;
  memory?: string;
  startTime?: string;
}

interface IdeConfig {
  name: string;
  icon?: string;
  proxyPath?: string;
}

/**
 * Extract user from request
 * In single-user mode, returns config.hpcUser directly.
 * When auth is implemented, this will extract from session/token.
 * @param req - Express request
 * @returns Username
 */
function getRequestUser(_req: Request): string {
  // Future: return req.session?.user || req.user?.username || config.hpcUser;
  return config.hpcUser;  // Single-user mode: use config.hpcUser directly
}

// Shared tunnel service instance
const tunnelService = new TunnelService();

// Status cache - reduces SSH calls to HPC clusters
// Long TTL (30min) since we invalidate on user actions (launch/kill)
// Client uses time-aware adaptive polling (15s-1hr) with exponential backoff
// This ensures multi-user environments see updates immediately via cache invalidation
// while dramatically reducing SSH load for stable long-running jobs (6-24+ hours)
const STATUS_CACHE_TTL = parseInt(process.env.STATUS_CACHE_TTL || '1800000'); // 30 minutes default

// Timing constants for launch/stop operations
const SLURM_CANCEL_DELAY_MS = 1000;    // Wait for SLURM to process cancellation

// Per-cluster cache to avoid invalidating both clusters on single job change
const statusCache = createClusterCache(STATUS_CACHE_TTL);

// Progress weights (cumulative percentages) based on observed timing
// Timing: submit ~3s, wait ~3.5s, tunnel+IDE ready ~2-5s (dynamic polling)
const LAUNCH_PROGRESS: Record<string, number> = {
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
function invalidateStatusCache(cluster: string | null = null): void {
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
async function startTunnelWithPortDiscovery(
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
 * Verify a session's job still exists in SLURM
 * Returns true if job exists and matches, false if stale (job gone)
 * @param session - Session object with jobId
 * @param hpc - HPC cluster name
 * @param ide - IDE type
 * @param user - Username for SSH connection
 * @returns True if job exists, false if stale
 */
async function verifyJobExists(session: Session, hpc: string, ide: string, user: string): Promise<boolean> {
  const hpcService = new HpcService(hpc, user);
  const jobInfo = await hpcService.getJobInfo(ide);
  return jobInfo !== null && jobInfo.jobId === session.jobId;
}

/**
 * Fetch fresh status for a single cluster and update its cache
 * @param clusterName - Cluster name ('gemini' or 'apollo')
 * @returns Fresh cluster status data
 */
async function fetchSingleClusterStatus(clusterName: string): Promise<Record<string, unknown>> {
  log.info(`Fetching fresh status for ${clusterName}`);

  const hpcService = new HpcService(clusterName);
  const jobs = await hpcService.getAllJobs() as unknown as Record<string, JobInfo | null>;

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
async function fetchClusterStatus(stateManager: StateManager): Promise<Record<string, unknown>> {
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
 * Initialize router with state manager dependency
 * @param stateManager - State manager instance
 * @returns Configured router
 */
function createApiRouter(stateManager: StateManager): Router {
  // Set up callback to stop tunnels when sessions are cleared
  // This handles: job expiry (walltime), reconcile cleanup, manual clear
  stateManager.onSessionCleared = (user: string, hpc: string, ide: string) => {
    log.tunnel('Session cleared, stopping tunnel', { user, hpc, ide });
    tunnelService.stop(hpc, ide, user);
  };

  // Helper: build session key (user-hpc-ide format)
  function buildSessionKey(user: string, hpc: string, ide: string): string {
    const effectiveUser = user || config.hpcUser;
    return `${effectiveUser}-${hpc}-${ide}`;
  }

  // Helper: parse session key (user-hpc-ide format)
  function parseSessionKey(key: string): { user: string; hpc: string; ide: string } | null {
    const parts = key.split('-');
    if (parts.length >= 3) {
      const ide = parts.pop()!;
      const hpc = parts.pop()!;
      const user = parts.join('-');
      return { user, hpc, ide };
    }
    return null;
  }

  // Helper: get sessions info for status endpoint (grouped by hpc then ide)
  // For single-user mode, shows all sessions for config.hpcUser
  function getSessionsInfo(user: string): Record<string, Record<string, unknown>> {
    const sessions: Record<string, Record<string, unknown>> = {};
    const allSessions = stateManager.getSessionsForUser(user);
    for (const [key, session] of Object.entries(allSessions)) {
      if (!session) continue;

      const parsed = parseSessionKey(key);
      if (!parsed) continue;
      const { hpc, ide } = parsed;
      if (!sessions[hpc]) sessions[hpc] = {};

      sessions[hpc][ide] = {
        status: session.status,
        ide: session.ide,
        jobId: session.jobId,
        node: session.node,
        error: session.error,
        cpus: session.cpus,
        memory: session.memory,
        walltime: session.walltime,
        startedAt: session.startedAt,
        estimatedStartTime: session.estimatedStartTime,  // SLURM forecast for pending jobs
        releaseVersion: session.releaseVersion,  // Bioconductor release for floating menu
        gpu: session.gpu,                        // GPU type for floating menu
      };
    }
    return sessions;
  }

  // Health check - returns 503 if state manager not ready
  router.get('/health', (req: Request, res: Response) => {
    if (!stateManager.isReady()) {
      return res.status(503).json({ status: 'starting', ready: false });
    }
    res.json({ status: 'ok', ready: true });
  });

  // Check dev server ports - returns list of active ports
  // Scans ports from config.additionalPorts (default: 5500, 3838)
  router.get('/dev-servers', async (req: Request, res: Response) => {
    const user = getRequestUser(req);

    // Only check if there's an active VS Code session
    const activeSession = stateManager.getActiveSession();
    if (!activeSession || activeSession.ide !== 'vscode') {
      return res.json({ activePorts: [] });
    }

    const { hpc } = activeSession;
    const session = stateManager.getSession(user, hpc, 'vscode');

    if (!session || session.status !== 'running' || !session.node) {
      return res.json({ activePorts: [] });
    }

    try {
      const hpcService = new HpcService(hpc, user);
      // Check all configured dev server ports in one SSH call
      const portsToCheck = config.additionalPorts;
      const result = await hpcService.checkPorts(session.node, portsToCheck) as Record<number, boolean>;

      // Return list of active ports
      const activePorts = portsToCheck.filter(port => result[port]);

      // Track feature usage for analytics (only mark once per session)
      if (activePorts.length > 0 && !session.usedDevServer) {
        await stateManager.updateSession(user, hpc, 'vscode', { usedDevServer: true });
        log.info('Dev server usage detected', { user, hpc, ports: activePorts });
      }

      res.json({ activePorts });
    } catch (e) {
      log.debugFor('api', 'dev-servers check failed', { error: (e as Error).message });
      res.json({ activePorts: [] });
    }
  });

  // Logging middleware for user actions
  router.use((req: Request, res: Response, next) => {
    if (req.method !== 'GET') {
      log.api(`${req.method} ${req.path}`, req.body || {});
    }
    next();
  });

  // Get session status
  // Returns cached state from StateManager background polling
  // No SSH calls - instant response from cached data
  router.get('/status', async (req: Request, res: Response) => {
    const user = getRequestUser(req);

    // Backend polling keeps state fresh automatically
    // Frontend can poll frequently since this is just reading from memory
    const pollingInfo = stateManager.getPollingInfo();

    res.json({
      sessions: getSessionsInfo(user),
      activeSession: stateManager.getActiveSession(), // { user, hpc, ide } or null
      ides: Object.keys(ides), // Available IDE types
      config: {
        defaultHpc: config.defaultHpc,
        defaultIde: config.defaultIde,
        defaultCpus: config.defaultCpus,
        defaultMem: config.defaultMem,
        defaultTime: config.defaultTime,
      },
      polling: {
        lastPollTime: pollingInfo.lastPollTime,
        nextPollTime: pollingInfo.nextPollTime,
        intervalMs: pollingInfo.currentInterval,
      },
    });
  });

  // Get job status for both clusters (checks SLURM directly)
  // Cached to reduce SSH load - use ?refresh=true to force update
  // Returns jobs grouped by cluster then IDE
  router.get('/cluster-status', async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === 'true';
    const hasLimits = req.query.hasLimits === 'true';  // Client has partition limits

    try {
      // Check cache status for each cluster
      const geminiCache = statusCache.get('gemini');
      const apolloCache = statusCache.get('apollo');

      const geminiFetchNeeded = !geminiCache.valid || forceRefresh;
      const apolloFetchNeeded = !apolloCache.valid || forceRefresh;

      // Fetch stale clusters in parallel for better performance
      const promises: Promise<unknown>[] = [];
      if (geminiFetchNeeded) {
        promises.push(fetchSingleClusterStatus('gemini'));
      } else {
        log.debugFor('cache', 'Using cached gemini status', { ageMs: geminiCache.age });
        promises.push(Promise.resolve(geminiCache.data));
      }

      if (apolloFetchNeeded) {
        promises.push(fetchSingleClusterStatus('apollo'));
      } else {
        log.debugFor('cache', 'Using cached apollo status', { ageMs: apolloCache.age });
        promises.push(Promise.resolve(apolloCache.data));
      }

      const [geminiData, apolloData] = await Promise.all(promises) as [Record<string, unknown>, Record<string, unknown>];

      const anyFresh = geminiFetchNeeded || apolloFetchNeeded;
      const geminiCacheAge = geminiFetchNeeded ? 0 : geminiCache.age;
      const apolloCacheAge = apolloFetchNeeded ? 0 : apolloCache.age;
      const maxCacheAge = Math.max(geminiCacheAge, apolloCacheAge);

      // Merge session data (releaseVersion, gpu) with SLURM job data
      // SLURM doesn't track releaseVersion/gpu, so we get it from stateManager
      // If no session exists (e.g., server restart), these will be null
      const user = getRequestUser(req);
      function enrichWithSessionData(clusterData: Record<string, unknown>, hpc: string): Record<string, unknown> {
        const enriched = { ...clusterData };
        for (const [ide, jobData] of Object.entries(enriched)) {
          const session = stateManager.getSession(user, hpc, ide);
          const job = jobData as Record<string, unknown>;
          // DEBUG: trace session lookup for releaseVersion/gpu enrichment
          if (job.status !== 'idle') {
            log.state('enrichWithSessionData lookup', {
              user,
              hpc,
              ide,
              jobStatus: job.status,
              sessionFound: !!session,
              sessionStatus: session?.status,
              releaseVersion: session?.releaseVersion,
              gpu: session?.gpu,
            });
          }
          enriched[ide] = {
            ...job,
            releaseVersion: session?.releaseVersion || null,
            gpu: session?.gpu || null,
            // Use session's estimatedStartTime if available, fallback to SLURM's startTime
            estimatedStartTime: session?.estimatedStartTime || job.startTime || null,
          };
        }
        return enriched;
      }

      res.json({
        gemini: enrichWithSessionData(geminiData, 'gemini'),
        apollo: enrichWithSessionData(apolloData, 'apollo'),
        activeSession: stateManager.getActiveSession(),  // Always use current activeSession, not cached
        clusterHealth: stateManager.getClusterHealth(),  // Include cluster health data
        ides: Object.fromEntries(
          Object.entries(ides).map(([k, v]) => [k, { name: (v as IdeConfig).name, icon: (v as IdeConfig).icon, proxyPath: (v as IdeConfig).proxyPath }])
        ),
        releases: Object.fromEntries(
          Object.entries(releases).map(([k, v]) => {
            const release = v as ReleaseConfig;
            return [k, {
              name: release.name,
              ides: release.ides,
              clusters: Object.keys(release.paths),  // Which clusters support this release
            }];
          })
        ),
        defaultReleaseVersion,
        gpuConfig,  // Include GPU config for client-side validation
        // Only include static partition limits if client doesn't have them yet
        ...(hasLimits ? {} : {
          partitionLimits,
          // Default partition per cluster (for client-side limit lookup)
          defaultPartitions: Object.fromEntries(
            Object.entries(clusters).map(([k, v]) => [k, (v as { partition: string }).partition])
          ),
        }),
        updatedAt: new Date().toISOString(),
        cached: !anyFresh,
        cacheAge: Math.floor(maxCacheAge / 1000),
        cacheTtl: Math.floor(STATUS_CACHE_TTL / 1000),
      });
    } catch (e) {
      log.error('Failed to fetch cluster status', { error: (e as Error).message });
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Launch session for a specific IDE
  router.post('/launch', async (req: Request, res: Response) => {
    const user = getRequestUser(req);
    const {
      hpc = config.defaultHpc,
      ide = config.defaultIde,
      cpus = config.defaultCpus,
      mem = config.defaultMem,
      time = config.defaultTime
    } = req.body;

    // Validate IDE type
    if (!ides[ide as keyof typeof ides]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    const sessionKey = buildSessionKey(user, hpc, ide);
    const lockName = `launch:${sessionKey}`;

    // Acquire lock to prevent concurrent launches
    try {
      stateManager.acquireLock(lockName);
    } catch (e) {
      return res.status(429).json({ error: (e as Error).message });
    }

    try {
      // Get or create session
      const session = await stateManager.getOrCreateSession(user, hpc, ide);

      // If session thinks it's running, verify with SLURM before reconnecting
      if (session.status === 'running') {
        const jobExists = await verifyJobExists(session, hpc, ide, user);

        if (!jobExists) {
          // Job is gone (walltime expired, cancelled, etc) - clear stale session
          log.state('Stale session detected, clearing', { user, hpc, ide, jobId: session.jobId });
          await stateManager.clearSession(user, hpc, ide, { endReason: 'timeout' });
          // Fall through to fresh launch flow below
        } else {
          // Job exists - safe to reconnect
          if (!session.tunnelProcess) {
            try {
              session.tunnelProcess = await startTunnelWithPortDiscovery(hpc, session.node!, ide, (_code) => {
                if (session.status === 'running') {
                  session.status = 'idle';
                }
                session.tunnelProcess = null;
              }, user);
            } catch (error) {
              stateManager.releaseLock(lockName);
              return res.status(500).json({ error: (error as Error).message });
            }
          }

          await stateManager.setActiveSession(user, hpc, ide);
          stateManager.releaseLock(lockName);
          return res.json({ status: 'connected', hpc, ide, jobId: session.jobId, node: session.node });
        }
      }

      // Reject if starting/pending (in progress)
      if (session.status !== 'idle') {
        stateManager.releaseLock(lockName);
        return res.status(400).json({ error: `${hpc} ${ide} is already ${session.status}` });
      }

      // SECURITY: Validate inputs before using in shell command
      // Note: POST /launch doesn't support GPU, so no GPU limit checking here
      try {
        validateSbatchInputs(cpus, mem, time, hpc);
      } catch (e) {
        stateManager.releaseLock(lockName);
        return res.status(400).json({ error: (e as Error).message });
      }

      await stateManager.updateSession(user, hpc, ide, {
        status: 'starting',
        error: null,
        cpus: cpus,
        memory: mem,
        walltime: time,
      });

      const hpcService = new HpcService(hpc, user);

      // Use local variables to collect job data (avoid mutating session directly)
      let jobId: string, token: string | undefined, node: string;

      // Check for existing job for this IDE
      const jobInfo = await hpcService.getJobInfo(ide);

      if (!jobInfo) {
        // Submit new job
        log.job(`Submitting new job`, { hpc, ide, cpus, mem, time });
        const result = await hpcService.submitJob(cpus, mem, time, ide);
        jobId = result.jobId;
        token = result.token ?? undefined;  // Auth token for VS Code/Jupyter

        // Record submission time for wait time analytics
        await stateManager.updateSession(user, hpc, ide, {
          submittedAt: new Date().toISOString(),
        });

        log.job(`Submitted`, { hpc, ide, jobId });
      } else {
        jobId = jobInfo.jobId;
        node = jobInfo.node!;
        log.job(`Found existing job`, { hpc, ide, jobId });
      }

      // Wait for job to get a node
      log.job('Waiting for node assignment...', { hpc, ide, jobId });
      const waitResult = await hpcService.waitForNode(jobId, ide);
      if (waitResult.pending) {
        throw new Error('Timeout waiting for node assignment');
      }
      node = waitResult.node!;
      log.job(`Running on node`, { hpc, ide, node });

      // Start tunnel - it will verify IDE is responding before returning
      // Uses port discovery to handle dynamic ports from multi-user scenarios
      const tunnelProcess = await startTunnelWithPortDiscovery(hpc, node, ide, (code) => {
        // Tunnel exit callback - refetch session since local ref may be stale
        log.tunnel(`Exit callback`, { hpc, ide, code });
        const currentSession = stateManager.getSession(user, hpc, ide);
        if (currentSession?.status === 'running') {
          stateManager.updateSession(user, hpc, ide, { status: 'idle', tunnelProcess: null });
        }
      }, user);

      await stateManager.updateSession(user, hpc, ide, {
        status: 'running',
        jobId,
        token,
        node,
        tunnelProcess,
        startedAt: new Date().toISOString(),
      });
      await stateManager.setActiveSession(user, hpc, ide);

      // Invalidate cache for this cluster and fetch fresh status after successful launch
      // This ensures ALL users (multi-user environment) see the new job on their next poll
      invalidateStatusCache(hpc);
      let clusterStatus: Record<string, unknown> | null = null;
      try {
        clusterStatus = await fetchClusterStatus(stateManager);
      } catch (e) {
        log.error('Failed to refresh cluster status after launch', { error: (e as Error).message });
      }

      res.json({
        status: 'running',
        jobId,
        node,
        hpc,
        ide,
        clusterStatus,
      });

    } catch (error) {
      log.error('Launch error', { hpc, ide, error: (error as Error).message });
      const session = stateManager.getSession(user, hpc, ide);
      if (session) {
        await stateManager.updateSession(user, hpc, ide, {
          status: 'idle',
          error: (error as Error).message,
        });
      }

      if (!res.headersSent) {
        res.status(500).json({ error: (error as Error).message });
      }
    } finally {
      stateManager.releaseLock(lockName);
    }
  });

  // Launch session with SSE progress streaming
  // Returns real-time progress events during job submission and startup
  router.get('/launch/:hpc/:ide/stream', async (req: Request, res: Response) => {
    const user = getRequestUser(req);
    const hpc = param(req, 'hpc');
    const ide = param(req, 'ide');
    const cpus = (req.query.cpus as string) || config.defaultCpus;
    const mem = (req.query.mem as string) || config.defaultMem;
    const time = (req.query.time as string) || config.defaultTime;
    const gpu = (req.query.gpu as string) || '';
    const releaseVersion = (req.query.releaseVersion as string) || defaultReleaseVersion;

    // Validate IDE type
    if (!ides[ide as keyof typeof ides]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    // Validate releaseVersion
    if (!releases[releaseVersion as keyof typeof releases]) {
      // Show releases available for this specific cluster
      const releasesForCluster = Object.entries(releases)
        .filter(([, release]) => {
          const r = release as ReleaseConfig;
          return r.paths && r.paths[hpc];
        })
        .map(([version]) => version)
        .join(', ');
      return res.status(400).json({
        error: releasesForCluster
          ? `Invalid release: ${releaseVersion} for ${hpc}. Available: ${releasesForCluster}`
          : `Invalid release: ${releaseVersion}. No releases configured for ${hpc}.`
      });
    }

    const releaseConfig = releases[releaseVersion as keyof typeof releases] as ReleaseConfig;

    // Validate release is available for this cluster
    if (!releaseConfig.paths[hpc]) {
      const availableClusters = Object.keys(releaseConfig.paths).join(', ');
      return res.status(400).json({ error: `${releaseConfig.name} is not available on ${hpc}. Available on: ${availableClusters}` });
    }

    // Validate IDE is available for this release
    if (!releaseConfig.ides.includes(ide)) {
      const availableIdes = releaseConfig.ides.join(', ');
      return res.status(400).json({ error: `${(ides[ide as keyof typeof ides] as IdeConfig).name} is not available on ${releaseConfig.name}. Available IDEs: ${availableIdes}` });
    }

    // Validate GPU type
    if (gpu) {
      const clusterGpuConfig = gpuConfig[hpc as keyof typeof gpuConfig] as Record<string, unknown> | undefined;
      if (!clusterGpuConfig) {
        return res.status(400).json({ error: `GPU support is not available on the ${hpc} cluster` });
      }
      if (!clusterGpuConfig[gpu]) {
        const availableGpus = Object.keys(clusterGpuConfig).join(', ');
        return res.status(400).json({ error: `Invalid GPU type: ${gpu}. Available on ${hpc}: ${availableGpus}` });
      }
    }

    // Set up SSE response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Helper to send progress events
    const sendProgress = (step: string, message: string, extra: Record<string, unknown> = {}) => {
      const progress = LAUNCH_PROGRESS[step] || 0;
      const data = JSON.stringify({ type: 'progress', step, progress, message, ...extra });
      res.write(`data: ${data}\n\n`);
    };

    // Helper to send error event
    const sendError = (message: string) => {
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    };

    // Helper to send completion event
    const sendComplete = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify({ type: 'complete', ...data })}\n\n`);
      res.end();
    };

    const sessionKey = buildSessionKey(user, hpc, ide);
    const lockName = `launch:${sessionKey}`;

    // Acquire lock to prevent concurrent launches
    try {
      stateManager.acquireLock(lockName);
    } catch (e) {
      return sendError((e as Error).message);
    }

    try {
      // Get or create session
      const session = await stateManager.getOrCreateSession(user, hpc, ide);

      // If session thinks it's running, verify with SLURM before reconnecting
      if (session.status === 'running') {
        sendProgress('verifying', 'Checking job status...');
        const jobExists = await verifyJobExists(session, hpc, ide, user);

        if (!jobExists) {
          // Job is gone (walltime expired, cancelled, etc) - clear stale session
          log.state('Stale session detected, clearing', { user, hpc, ide, jobId: session.jobId });
          await stateManager.clearSession(user, hpc, ide, { endReason: 'timeout' });
          sendProgress('launching', 'Previous job ended, starting fresh...');
          // Fall through to fresh launch flow below
        } else {
          // Job exists - safe to reconnect
          sendProgress('connecting', 'Reconnecting tunnel...');

          // Backfill missing metadata if reconnecting to pre-migration job
          if (!session.releaseVersion && releaseVersion) {
            await stateManager.updateSession(user, hpc, ide, {
              releaseVersion,
              gpu: gpu || null,
            });
          }

          // Ensure tunnel is running for this session
          if (!session.tunnelProcess) {
            try {
              session.tunnelProcess = await startTunnelWithPortDiscovery(hpc, session.node!, ide, (_code) => {
                if (session.status === 'running') {
                  session.status = 'idle';
                }
                session.tunnelProcess = null;
              }, user);
            } catch (error) {
              stateManager.releaseLock(lockName);
              return sendError((error as Error).message);
            }
          }

          await stateManager.setActiveSession(user, hpc, ide);
          stateManager.releaseLock(lockName);

          const ideConfig = ides[ide as keyof typeof ides] as IdeConfig;
          return sendComplete({
            status: 'connected',
            hpc,
            ide,
            jobId: session.jobId,
            node: session.node,
            redirectUrl: ideConfig?.proxyPath || '/code/',
          });
        }
      }

      // Reject if starting/pending (in progress)
      if (session.status !== 'idle') {
        stateManager.releaseLock(lockName);
        return sendError(`${hpc} ${ide} is already ${session.status}`);
      }

      // SECURITY: Validate inputs before using in shell command
      // Pass hpc and gpu for cluster-specific limit checking
      try {
        validateSbatchInputs(cpus, mem, time, hpc, gpu);
      } catch (e) {
        stateManager.releaseLock(lockName);
        return sendError((e as Error).message);
      }

      await stateManager.updateSession(user, hpc, ide, {
        status: 'starting',
        error: null,
        cpus: parseInt(cpus as string, 10),
        memory: mem,
        walltime: time,
      });

      // Step 1: Connecting
      sendProgress('connecting', 'Connecting...');

      const hpcService = new HpcService(hpc, user);

      // Use local variables to collect job data (avoid mutating session directly)
      let jobId: string, token: string | undefined, node: string;
      let jobReleaseVersion = releaseVersion;
      let jobGpu: string | null = gpu || null;

      // Check for existing job for this IDE
      const jobInfo = await hpcService.getJobInfo(ide);

      // For existing jobs, preserve session's releaseVersion and gpu
      // (SLURM doesn't track these, so we rely on session state)
      if (jobInfo && session) {
        jobReleaseVersion = session.releaseVersion || releaseVersion;
        jobGpu = session.gpu || gpu || null;
      }

      // Helper to check job status - quick check, don't block for long
      // If job is pending, immediately return with startTime so UI can show it
      const checkJobStatus = async (currentJobId: string): Promise<{
        running: boolean;
        node?: string;
        startTime?: string;
      }> => {
        // Quick check - 2 attempts max (~5 seconds total)
        for (let attempt = 0; attempt < 2; attempt++) {
          const jobInfo = await hpcService.getJobInfo(ide);

          if (!jobInfo || jobInfo.jobId !== currentJobId) {
            throw new Error('Job disappeared from queue');
          }

          if (jobInfo.state === 'RUNNING' && jobInfo.node) {
            return { running: true, node: jobInfo.node };
          }

          // If pending, return immediately with startTime (don't wait 30 seconds)
          if (jobInfo.state === 'PENDING') {
            return { running: false, startTime: jobInfo.startTime || undefined };
          }

          // Brief wait before retry
          if (attempt < 1) {
            await new Promise(resolve => setTimeout(resolve, 2500));
          }
        }

        // Still not running after quick check - return pending
        const jobInfo = await hpcService.getJobInfo(ide);
        return { running: false, startTime: jobInfo?.startTime || undefined };
      };

      // Helper to handle pending job - update state and send response
      const handlePendingJob = async (currentJobId: string, startTime?: string) => {
        await stateManager.updateSession(user, hpc, ide, {
          status: 'pending',
          jobId: currentJobId,
          estimatedStartTime: startTime || null,
        });
        stateManager.releaseLock(lockName);

        res.write(`data: ${JSON.stringify({
          type: 'pending',
          jobId: currentJobId,
          startTime: startTime || null,
          message: startTime ? `Estimated start: ${startTime}` : 'Waiting for resources...',
        })}\n\n`);
        res.end();
      };

      if (!jobInfo) {
        // Fresh launch - submit new job
        const gpuLabel = gpu ? ` (${gpu.toUpperCase()})` : '';
        sendProgress('submitting', `Requesting resources${gpuLabel}...`);
        log.job(`Submitting new job`, { hpc, ide, cpus, mem, time, gpu: gpu || 'none', releaseVersion });

        const result = await hpcService.submitJob(parseInt(cpus, 10), mem, time, ide, { gpu, releaseVersion });
        jobId = result.jobId;
        token = result.token ?? undefined;

        // Record submission time for wait time analytics
        await stateManager.updateSession(user, hpc, ide, {
          submittedAt: new Date().toISOString(),
          releaseVersion: jobReleaseVersion,
          gpu: jobGpu,
          account: session.account || null,
        });

        sendProgress('submitted', `Job ${jobId} submitted`, { jobId });
        log.job(`Submitted`, { hpc, ide, jobId });

        // Quick check for node assignment (don't block for 30 seconds)
        sendProgress('waiting', 'Checking job status...');
        log.job('Checking job status...', { hpc, ide, jobId });

        const statusResult = await checkJobStatus(jobId);
        if (!statusResult.running) {
          // Job is pending - send pending status with startTime and close stream
          log.job('Job pending, returning to UI', { hpc, ide, jobId, startTime: statusResult.startTime });
          await handlePendingJob(jobId, statusResult.startTime);
          return;
        }
        node = statusResult.node!;
      } else {
        // Found existing job - connect to it
        jobId = jobInfo.jobId;
        node = jobInfo.node!;

        if (jobInfo.node) {
          // Job is running - skip straight to connecting
          sendProgress('starting', `Connecting to running job on ${node}`, { jobId, node });
          log.job(`Found running job`, { hpc, ide, jobId, node });
        } else {
          // Job is pending - quick check then return to UI
          sendProgress('submitted', `Found job ${jobId}`, { jobId });
          sendProgress('waiting', 'Checking job status...');
          log.job(`Found pending job`, { hpc, ide, jobId });

          const statusResult = await checkJobStatus(jobId);
          if (!statusResult.running) {
            // Still pending - send status with startTime and close stream
            log.job('Job still pending, returning to UI', { hpc, ide, jobId, startTime: statusResult.startTime });
            await handlePendingJob(jobId, statusResult.startTime);
            return;
          }
          node = statusResult.node!;
        }
      }
      log.job(`Running on node`, { hpc, ide, node });

      // Step 6: Establishing tunnel and waiting for IDE
      sendProgress('establishing', 'Almost ready...');

      // Start tunnel and wait for it to establish
      // Uses port discovery to handle dynamic ports from multi-user scenarios
      const tunnelProcess = await startTunnelWithPortDiscovery(hpc, node, ide, (code) => {
        // Tunnel exit callback - refetch session since local ref may be stale
        log.tunnel(`Exit callback`, { hpc, ide, code });
        const currentSession = stateManager.getSession(user, hpc, ide);
        if (currentSession?.status === 'running') {
          stateManager.updateSession(user, hpc, ide, { status: 'idle', tunnelProcess: null });
        }
      }, user);

      log.state('Saving session with releaseVersion', {
        user, hpc, ide, jobId, node,
        releaseVersion: jobReleaseVersion,
        gpu: jobGpu,
      });
      await stateManager.updateSession(user, hpc, ide, {
        status: 'running',
        jobId,
        token,
        node,
        releaseVersion: jobReleaseVersion,
        gpu: jobGpu,
        tunnelProcess,
        startedAt: new Date().toISOString(),
      });
      await stateManager.setActiveSession(user, hpc, ide);

      // Invalidate cache for this cluster
      invalidateStatusCache(hpc);

      // Audit log session launch
      log.audit('Session started', {
        user, hpc, ide, jobId, node,
        cpus, mem, time,
        gpu: jobGpu || 'none',
        releaseVersion: jobReleaseVersion,
      });

      const ideConfig = ides[ide as keyof typeof ides] as IdeConfig;
      sendComplete({
        status: 'running',
        jobId,
        node,
        hpc,
        ide,
        redirectUrl: ideConfig?.proxyPath || '/code/',
      });

    } catch (error) {
      log.error('Launch stream error', { hpc, ide, error: (error as Error).message });
      const session = stateManager.getSession(user, hpc, ide);
      if (session) {
        await stateManager.updateSession(user, hpc, ide, {
          status: 'idle',
          error: (error as Error).message,
        });
      }
      sendError((error as Error).message);
    } finally {
      stateManager.releaseLock(lockName);
    }
  });

  // Switch active session (connect to different HPC/IDE)
  router.post('/switch/:hpc/:ide', async (req: Request, res: Response) => {
    const user = getRequestUser(req);
    const hpc = param(req, 'hpc');
    const ide = param(req, 'ide');

    // Validate IDE type
    if (!ides[ide as keyof typeof ides]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    const session = stateManager.getSession(user, hpc, ide);

    if (!session || session.status !== 'running') {
      return res.status(400).json({ error: `No running ${ide} session on ${hpc}` });
    }

    // Stop current active tunnel if switching to different session
    const activeSession = stateManager.getActiveSession();
    if (activeSession) {
      const { user: activeUser, hpc: activeHpc, ide: activeIde } = activeSession;
      if (activeHpc !== hpc || activeIde !== ide) {
        tunnelService.stop(activeHpc, activeIde, activeUser);
      }
    }

    // Start tunnel to the requested HPC/IDE
    try {
      if (!session.tunnelProcess) {
        session.tunnelProcess = await startTunnelWithPortDiscovery(hpc, session.node!, ide, (_code) => {
          if (session.status === 'running') {
            session.status = 'idle';
          }
          session.tunnelProcess = null;
        }, user);
      }

      await stateManager.setActiveSession(user, hpc, ide);
      log.api(`Switched to ${hpc} ${ide}`, { hpc, ide });
      res.json({ status: 'switched', hpc, ide });
    } catch (error) {
      log.error('Switch error', { hpc, ide, error: (error as Error).message });
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Stop session for specific HPC/IDE
  // When cancelJob=true, also refreshes cluster status cache so UI sees freed slot
  router.post('/stop/:hpc/:ide', async (req: Request, res: Response) => {
    const user = getRequestUser(req);
    const { cancelJob = false } = req.body;
    const hpc = param(req, 'hpc');
    const ide = param(req, 'ide');

    // Validate IDE type
    if (!ides[ide as keyof typeof ides]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    const session = stateManager.getSession(user, hpc, ide);

    // Stop tunnel if exists
    tunnelService.stop(hpc, ide, user);

    // Cancel SLURM job if requested
    let jobCancelled = false;
    if (cancelJob) {
      try {
        const hpcService = new HpcService(hpc, user);

        // Get job ID from session or query SLURM directly
        let jobId = session?.jobId;
        if (!jobId) {
          // No session tracked - check SLURM directly for running job
          const jobInfo = await hpcService.getJobInfo(ide);
          if (jobInfo) {
            jobId = jobInfo.jobId;
          }
        }

        if (jobId) {
          await hpcService.cancelJob(jobId);
          log.job(`Cancelled`, { hpc, ide, jobId });
          log.audit('Session stopped', { user, hpc, ide, jobId, cancelled: true });
          jobCancelled = true;
        }
      } catch (e) {
        log.error('Failed to cancel job', { hpc, ide, error: (e as Error).message });
      }
    } else {
      log.audit('Session stopped', { user, hpc, ide, jobId: session?.jobId, cancelled: false });
    }

    // Clear session and active session if needed
    await stateManager.clearSession(user, hpc, ide, { endReason: 'cancelled' });

    // If we cancelled a job, invalidate cache for this cluster and fetch fresh status
    // This ensures ALL users (multi-user environment) immediately see the freed slot
    let clusterStatus: Record<string, unknown> | null = null;
    if (jobCancelled) {
      invalidateStatusCache(hpc);
      try {
        // Small delay to let SLURM process the cancellation
        await new Promise(resolve => setTimeout(resolve, SLURM_CANCEL_DELAY_MS));
        clusterStatus = await fetchClusterStatus(stateManager);
      } catch (e) {
        log.error('Failed to refresh cluster status after cancel', { error: (e as Error).message });
      }
    }

    res.json({
      status: 'stopped',
      hpc,
      ide,
      clusterStatus,  // Include fresh status if job was cancelled
    });
  });

  // Stop session with SSE progress streaming (indeterminate progress)
  // Due to high variance in cancel times (CV 74%), uses indeterminate animation
  router.get('/stop/:hpc/:ide/stream', async (req: Request, res: Response) => {
    const user = getRequestUser(req);
    const hpc = param(req, 'hpc');
    const ide = param(req, 'ide');

    // Validate IDE type
    if (!ides[ide as keyof typeof ides]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    // Set up SSE response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Helper to send progress events (indeterminate - no percentage)
    const sendProgress = (step: string, message: string) => {
      res.write(`data: ${JSON.stringify({ type: 'progress', step, message })}\n\n`);
    };

    // Helper to send completion event
    const sendComplete = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify({ type: 'complete', ...data })}\n\n`);
      res.end();
    };

    // Helper to send error event
    const sendError = (message: string) => {
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    };

    try {
      const session = stateManager.getSession(user, hpc, ide);

      sendProgress('cancelling', 'Stopping...');

      // Stop tunnel if exists
      tunnelService.stop(hpc, ide, user);

      // Cancel SLURM job
      let jobCancelled = false;
      const hpcService = new HpcService(hpc, user);

      // Get job ID from session or query SLURM directly
      let jobId = session?.jobId;
      if (!jobId) {
        const jobInfo = await hpcService.getJobInfo(ide);
        if (jobInfo) {
          jobId = jobInfo.jobId;
        }
      }

      if (jobId) {
        await hpcService.cancelJob(jobId);
        log.job(`Cancelled`, { hpc, ide, jobId });
        jobCancelled = true;
      }

      // Clear session and active session if needed
      await stateManager.clearSession(user, hpc, ide, { endReason: 'cancelled' });

      // Invalidate cache and fetch fresh status
      if (jobCancelled) {
        invalidateStatusCache(hpc);
        await new Promise(resolve => setTimeout(resolve, SLURM_CANCEL_DELAY_MS));
      }

      sendComplete({
        status: 'stopped',
        hpc,
        ide,
        jobCancelled,
      });

    } catch (error) {
      log.error('Stop stream error', { hpc, ide, error: (error as Error).message });
      sendError((error as Error).message);
    }
  });

  /**
   * POST /api/stop-all/:hpc
   * Stop all user's jobs on a cluster (batch operation)
   * More efficient than individual stops when user has multiple jobs
   */
  router.post('/stop-all/:hpc', asyncHandler(async (req: Request, res: Response) => {
    const hpc = param(req, 'hpc');
    validateHpcName(hpc);

    const user = getRequestUser(req);
    const sessions = stateManager.getSessionsForUser(user);

    // Collect running/pending jobs on this cluster
    // Map jobId -> sessionKey so we can clear only successfully cancelled sessions
    const jobsToCancel: string[] = [];
    const jobIdToSessionKey = new Map<string, string>();

    for (const [sessionKey, session] of Object.entries(sessions)) {
      if (!session?.jobId) continue;
      const parsed = parseSessionKey(sessionKey);
      if (!parsed || parsed.hpc !== hpc) continue;
      if (session.status !== 'running' && session.status !== 'pending') continue;

      jobsToCancel.push(session.jobId);
      jobIdToSessionKey.set(session.jobId, sessionKey);
    }

    if (jobsToCancel.length === 0) {
      return res.json({ status: 'ok', cancelled: 0, failed: [], message: 'No jobs to cancel' });
    }

    // Batch cancel
    const hpcService = new HpcService(hpc, user);
    const result = await hpcService.cancelJobs(jobsToCancel);

    // Clear sessions only for successfully cancelled jobs (stop tunnels too)
    // Jobs that failed to cancel keep their sessions so they can be retried
    // Run in parallel for efficiency when multiple jobs cancelled
    await Promise.all(result.cancelled.map((jobId: string) => {
      const sessionKey = jobIdToSessionKey.get(jobId);
      if (!sessionKey) return;

      const parsed = parseSessionKey(sessionKey);
      if (parsed) {
        const { hpc: sessionHpc, ide } = parsed;
        // Stop tunnel if exists
        tunnelService.stop(sessionHpc, ide, user);
        return stateManager.clearSession(user, sessionHpc, ide, { endReason: 'cancelled' });
      }
    }));

    // Invalidate cache and wait for SLURM to process
    if (result.cancelled.length > 0) {
      invalidateStatusCache(hpc);
      await new Promise(resolve => setTimeout(resolve, SLURM_CANCEL_DELAY_MS));
    }

    log.job('Batch stop completed', { user, hpc, count: result.cancelled.length, failed: result.failed.length });
    log.audit('Batch session stop', { user, hpc, cancelled: result.cancelled.length, failed: result.failed.length });

    res.json({
      status: 'ok',
      cancelled: result.cancelled.length,
      failed: result.failed,
      jobIds: result.cancelled,
    });
  }));

  return router;
}

export default createApiRouter;

// CommonJS compatibility for existing require() calls
module.exports = createApiRouter;
