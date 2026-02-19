import express, { Request, Response, Router } from 'express';
import HpcService from '../../services/hpc';
import { config, ides, gpuConfig, releases, defaultReleaseVersion, partitionLimits, clusters } from '../../config';
import { log } from '../../lib/logger';
import { errorMessage, errorDetails } from '../../lib/errors';

import {
  getRequestUser, statusCache, STATUS_CACHE_TTL,
  fetchSingleClusterStatus,
  parseSessionKey,
} from './helpers';
import type { StateManager, IdeConfig } from './helpers';
import { asyncHandler } from '../../lib/asyncHandler';

export function createStatusRouter(stateManager: StateManager): Router {
  const router = express.Router();

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
  router.get('/dev-servers', asyncHandler(async (req: Request, res: Response) => {
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
      log.debugFor('api', 'dev-servers check failed', errorDetails(e));
      res.json({ activePorts: [] });
    }
  }));

  // Get session status
  // Returns cached state from StateManager background polling
  // No SSH calls - instant response from cached data
  router.get('/status', asyncHandler(async (req: Request, res: Response) => {
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
        lastPollTime: pollingInfo.jobPolling.lastPollTime,
        nextPollTime: pollingInfo.jobPolling.nextPollTime,
        intervalMs: pollingInfo.jobPolling.currentInterval,
      },
    });
  }));

  // Get job status for both clusters (checks SLURM directly)
  // Cached to reduce SSH load - use ?refresh=true to force update
  // Returns jobs grouped by cluster then IDE
  router.get('/cluster-status', asyncHandler(async (req: Request, res: Response) => {
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
            // Fall back to session-stored values if squeue returns null (e.g. pending jobs)
            cpus: job.cpus ?? session?.cpus ?? null,
            memory: job.memory ?? session?.memory ?? null,
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
            const release = v as { name: string; ides: string[]; paths: Record<string, unknown> };
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
      log.error('Failed to fetch cluster status', errorDetails(e));
      res.status(500).json({ error: errorMessage(e) });
    }
  }));

  return router;
}
