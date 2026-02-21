import express, { Request, Response, Router } from 'express';
import HpcService from '../../services/hpc';
import { validateSbatchInputs, validateHpcName } from '../../lib/validation';
import { asyncHandler } from '../../lib/asyncHandler';
import { config, ides } from '../../config';
import { log } from '../../lib/logger';
import { errorMessage, errorDetails } from '../../lib/errors';
import { sleep } from '../../lib/time';
import {
  param, getRequestUser, tunnelService, SLURM_CANCEL_DELAY_MS,
  invalidateStatusCache, fetchClusterStatus,
  startTunnelWithPortDiscovery, ensureTunnelStarted, makeTunnelOnExit, verifyJobExists,
  buildSessionKey, parseSessionKey,
} from './helpers';
import type { StateManager } from './helpers';

export function createSessionsRouter(stateManager: StateManager): Router {
  const router = express.Router();

  // Launch session for a specific IDE
  router.post('/launch', asyncHandler(async (req: Request, res: Response) => {
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
      return res.status(429).json({ error: errorMessage(e) });
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
          const reconnect = await ensureTunnelStarted(session, stateManager, hpc, ide, user);
          if (!reconnect.ok) {
            stateManager.releaseLock(lockName);
            return res.status(500).json({ error: reconnect.message });
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
        return res.status(400).json({ error: errorMessage(e) });
      }

      await stateManager.updateSession(user, hpc, ide, {
        status: 'starting',
        error: null,
        cpus: parseInt(String(cpus), 10),
        memory: mem,
        walltime: time,
      });

      const hpcService = new HpcService(hpc, user);

      // Use local variables to collect job data (avoid mutating session directly)
      let jobId: string, token: string | undefined;

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
        log.job(`Found existing job`, { hpc, ide, jobId });
      }

      // Wait for job to get a node
      log.job('Waiting for node assignment...', { hpc, ide, jobId });
      const waitResult = await hpcService.waitForNode(jobId, ide);
      if (waitResult.pending) {
        throw new Error('Timeout waiting for node assignment');
      }
      const node = waitResult.node!;
      log.job(`Running on node`, { hpc, ide, node });

      // Start tunnel - it will verify IDE is responding before returning
      // Uses port discovery to handle dynamic ports from multi-user scenarios
      const tunnelProcess = await startTunnelWithPortDiscovery(hpc, node, ide, makeTunnelOnExit(stateManager, user, hpc, ide), user);

      await stateManager.updateSession(user, hpc, ide, {
        status: 'running',
        jobId,
        token,
        node,
        tunnelProcess,
        startedAt: new Date().toISOString(),
      });
      await stateManager.setActiveSession(user, hpc, ide);
      log.audit('Session started', { user, hpc, ide, jobId, node });

      // Invalidate cache for this cluster and fetch fresh status after successful launch
      // This ensures ALL users (multi-user environment) see the new job on their next poll
      invalidateStatusCache(hpc);
      let clusterStatus: Record<string, unknown> | null = null;
      try {
        clusterStatus = await fetchClusterStatus(stateManager);
      } catch (e) {
        log.error('Failed to refresh cluster status after launch', errorDetails(e));
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
      log.error('Launch error', { hpc, ide, ...errorDetails(error) });
      const session = stateManager.getSession(user, hpc, ide);
      if (session) {
        await stateManager.updateSession(user, hpc, ide, {
          status: 'idle',
          error: errorMessage(error),
        });
      }

      if (!res.headersSent) {
        res.status(500).json({ error: errorMessage(error) });
      }
    } finally {
      stateManager.releaseLock(lockName);
    }
  }));

  // Switch active session (connect to different HPC/IDE)
  router.post('/switch/:hpc/:ide', asyncHandler(async (req: Request, res: Response) => {
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
    const switched = await ensureTunnelStarted(session, stateManager, hpc, ide, user);
    if (!switched.ok) {
      log.error('Switch error', { hpc, ide, error: switched.message });
      return res.status(500).json({ error: switched.message });
    }

    try {
      await stateManager.setActiveSession(user, hpc, ide);
      log.api(`Switched to ${hpc} ${ide}`, { hpc, ide });
      res.json({ status: 'switched', hpc, ide });
    } catch (error) {
      log.error('Switch error', { hpc, ide, ...errorDetails(error) });
      res.status(500).json({ error: errorMessage(error) });
    }
  }));

  // Stop session for specific HPC/IDE
  // When cancelJob=true, also refreshes cluster status cache so UI sees freed slot
  router.post('/stop/:hpc/:ide', asyncHandler(async (req: Request, res: Response) => {
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
        log.error('Failed to cancel job', { hpc, ide, ...errorDetails(e) });
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
        await sleep(SLURM_CANCEL_DELAY_MS);
        clusterStatus = await fetchClusterStatus(stateManager);
      } catch (e) {
        log.error('Failed to refresh cluster status after cancel', errorDetails(e));
      }
    }

    res.json({
      status: 'stopped',
      hpc,
      ide,
      clusterStatus,  // Include fresh status if job was cancelled
    });
  }));

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
      await sleep(SLURM_CANCEL_DELAY_MS);
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
