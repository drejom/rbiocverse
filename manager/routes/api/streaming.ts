import express, { Request, Response, Router } from 'express';
import HpcService from '../../services/hpc';
import { validateSbatchInputs } from '../../lib/validation';
import { config, ides, gpuConfig, releases, defaultReleaseVersion } from '../../config';
import { log } from '../../lib/logger';
import { errorMessage, errorDetails } from '../../lib/errors';
import { sleep } from '../../lib/time';
import {
  param, getRequestUser, tunnelService, SLURM_CANCEL_DELAY_MS, LAUNCH_PROGRESS,
  invalidateStatusCache,
  startTunnelWithPortDiscovery, ensureTunnelStarted, makeTunnelOnExit, verifyJobExists,
  buildSessionKey,
} from './helpers';
import type { StateManager, IdeConfig } from './helpers';

import type { ReleaseConfig } from '../../config';
import { asyncHandler } from '../../lib/asyncHandler';

/**
 * Initialize streaming router with state manager dependency
 * @param stateManager - State manager instance
 * @returns Configured router
 */
export function createStreamingRouter(stateManager: StateManager): Router {
  const router = express.Router();

  // Launch session with SSE progress streaming
  // Returns real-time progress events during job submission and startup
  router.get('/launch/:hpc/:ide/stream', asyncHandler(async (req: Request, res: Response) => {
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
      return sendError(errorMessage(e));
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
          const reconnect = await ensureTunnelStarted(session, stateManager, hpc, ide, user);
          if (!reconnect.ok) {
            stateManager.releaseLock(lockName);
            return sendError(reconnect.message);
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
        return sendError(errorMessage(e));
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
            await sleep(2500);
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
      const tunnelProcess = await startTunnelWithPortDiscovery(hpc, node, ide, makeTunnelOnExit(stateManager, user, hpc, ide), user);

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
      log.error('Launch stream error', { hpc, ide, ...errorDetails(error) });
      const session = stateManager.getSession(user, hpc, ide);
      if (session) {
        await stateManager.updateSession(user, hpc, ide, {
          status: 'idle',
          error: errorMessage(error),
        });
      }
      sendError(errorMessage(error));
    } finally {
      stateManager.releaseLock(lockName);
    }
  }));

  // Stop session with SSE progress streaming (indeterminate progress)
  // Due to high variance in cancel times (CV 74%), uses indeterminate animation
  router.get('/stop/:hpc/:ide/stream', asyncHandler(async (req: Request, res: Response) => {
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
        await sleep(SLURM_CANCEL_DELAY_MS);
      }

      sendComplete({
        status: 'stopped',
        hpc,
        ide,
        jobCancelled,
      });

    } catch (error) {
      log.error('Stop stream error', { hpc, ide, ...errorDetails(error) });
      sendError(errorMessage(error));
    }
  }));

  return router;
}
