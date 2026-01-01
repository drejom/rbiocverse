/**
 * API Routes
 * Handles all /api/* endpoints using extracted services
 */

const express = require('express');
const router = express.Router();
const HpcService = require('../services/hpc');
const TunnelService = require('../services/tunnel');
const { validateSbatchInputs } = require('../lib/validation');
const { parseTimeToSeconds, formatHumanTime } = require('../lib/helpers');
const { config, ides } = require('../config');
const { log } = require('../lib/logger');

// Shared tunnel service instance
const tunnelService = new TunnelService();

// Status cache - reduces SSH calls to HPC clusters
const STATUS_CACHE_TTL = parseInt(process.env.STATUS_CACHE_TTL) || 120000; // 120 seconds default
let statusCache = {
  data: null,
  timestamp: 0,
};

/**
 * Initialize router with state manager dependency
 * @param {StateManager} stateManager - State manager instance
 * @returns {express.Router} Configured router
 */
function createApiRouter(stateManager) {
  const state = stateManager.state;

  // Helper: get session key
  function getSessionKey(hpc, ide) {
    return `${hpc}-${ide}`;
  }

  // Helper: parse session key
  function parseSessionKey(key) {
    const [hpc, ide] = key.split('-');
    return { hpc, ide };
  }

  // Helper: create session object
  function createSession(ide = 'vscode') {
    return {
      status: 'idle',
      ide,
      jobId: null,
      node: null,
      tunnelProcess: null,
      startedAt: null,
      cpus: null,
      memory: null,
      walltime: null,
      error: null,
    };
  }

  // Helper: get sessions info for status endpoint (grouped by hpc then ide)
  function getSessionsInfo() {
    const sessions = {};
    for (const [key, session] of Object.entries(state.sessions)) {
      if (!session) continue;

      const { hpc, ide } = parseSessionKey(key);
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
      };
    }
    return sessions;
  }

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Logging middleware for user actions
  router.use((req, res, next) => {
    if (req.method !== 'GET') {
      log.api(`${req.method} ${req.path}`, req.body || {});
    }
    next();
  });

  // Get session status
  router.get('/status', async (req, res) => {
    // Check actual job status for running sessions
    let stateChanged = false;

    for (const [key, session] of Object.entries(state.sessions)) {
      if (session && session.status === 'running' && session.jobId) {
        const { hpc, ide } = parseSessionKey(key);
        try {
          const hpcService = new HpcService(hpc);
          const jobInfo = await hpcService.getJobInfo(ide);

          if (!jobInfo || jobInfo.jobId !== session.jobId) {
            // Job disappeared
            tunnelService.stop(hpc, ide);
            session.status = 'idle';
            session.jobId = null;
            session.node = null;
            if (state.activeSession?.hpc === hpc && state.activeSession?.ide === ide) {
              state.activeSession = null;
            }
            stateChanged = true;
          }
        } catch (e) {
          log.error(`Error checking job status for ${key}`, { error: e.message });
        }
      }
    }

    if (stateChanged) {
      await stateManager.save();
    }

    res.json({
      sessions: getSessionsInfo(),
      activeSession: state.activeSession,  // { hpc, ide } or null
      ides: Object.keys(ides),  // Available IDE types
      config: {
        defaultHpc: config.defaultHpc,
        defaultIde: config.defaultIde,
        defaultCpus: config.defaultCpus,
        defaultMem: config.defaultMem,
        defaultTime: config.defaultTime,
      }
    });
  });

  // Get job status for both clusters (checks SLURM directly)
  // Cached to reduce SSH load - use ?refresh=true to force update
  // Returns jobs grouped by cluster then IDE
  router.get('/cluster-status', async (req, res) => {
    const forceRefresh = req.query.refresh === 'true';
    const now = Date.now();
    const cacheAge = now - statusCache.timestamp;
    const cacheValid = statusCache.data && cacheAge < STATUS_CACHE_TTL;

    // Return cached data if valid and not forcing refresh
    if (cacheValid && !forceRefresh) {
      log.debug('Returning cached cluster status', { ageMs: cacheAge });
      return res.json({
        ...statusCache.data,
        activeSession: state.activeSession,  // Always use current activeSession, not cached
        cached: true,
        cacheAge: Math.floor(cacheAge / 1000),
        cacheTtl: Math.floor(STATUS_CACHE_TTL / 1000),
      });
    }

    try {
      log.info('Fetching fresh cluster status', { forceRefresh, cacheAge: cacheAge ? Math.floor(cacheAge / 1000) : null });

      const geminiService = new HpcService('gemini');
      const apolloService = new HpcService('apollo');

      // Get all IDE jobs for both clusters in parallel
      const [geminiJobs, apolloJobs] = await Promise.all([
        geminiService.getAllJobs(),
        apolloService.getAllJobs(),
      ]);

      const formatJobStatus = (job) => {
        if (!job) return { status: 'idle' };

        const timeLeftSeconds = parseTimeToSeconds(job.timeLeft);
        const timeLimitSeconds = parseTimeToSeconds(job.timeLimit);

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

      // Format cluster status grouped by IDE
      const formatClusterStatus = (jobs) => {
        const result = {};
        for (const [ide, job] of Object.entries(jobs)) {
          result[ide] = formatJobStatus(job);
        }
        return result;
      };

      const freshData = {
        gemini: formatClusterStatus(geminiJobs),
        apollo: formatClusterStatus(apolloJobs),
        activeSession: state.activeSession,  // { hpc, ide } or null
        ides: Object.fromEntries(
          Object.entries(ides).map(([k, v]) => [k, { name: v.name, icon: v.icon }])
        ),
        updatedAt: new Date().toISOString(),
      };

      // Update cache
      statusCache = {
        data: freshData,
        timestamp: now,
      };

      res.json({
        ...freshData,
        cached: false,
        cacheAge: 0,
        cacheTtl: Math.floor(STATUS_CACHE_TTL / 1000),
      });
    } catch (e) {
      log.error('Failed to fetch cluster status', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // Launch session for a specific IDE
  router.post('/launch', async (req, res) => {
    const {
      hpc = config.defaultHpc,
      ide = config.defaultIde,
      cpus = config.defaultCpus,
      mem = config.defaultMem,
      time = config.defaultTime
    } = req.body;

    // Validate IDE type
    if (!ides[ide]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    const sessionKey = getSessionKey(hpc, ide);
    const lockName = `launch:${sessionKey}`;

    // Acquire lock to prevent concurrent launches
    try {
      stateManager.acquireLock(lockName);
    } catch (e) {
      return res.status(429).json({ error: e.message });
    }

    try {
      // Initialize session if needed
      if (!state.sessions[sessionKey]) {
        state.sessions[sessionKey] = createSession(ide);
      }

      const session = state.sessions[sessionKey];

      // If already running, just switch to this session (reconnect)
      if (session.status === 'running') {
        // Ensure tunnel is running for this session
        if (!session.tunnelProcess) {
          try {
            session.tunnelProcess = await tunnelService.start(hpc, session.node, ide, (code) => {
              // Tunnel exit callback
              if (session.status === 'running') {
                session.status = 'idle';
              }
              session.tunnelProcess = null;
            });
          } catch (error) {
            stateManager.releaseLock(lockName);
            return res.status(500).json({ error: error.message });
          }
        }

        state.activeSession = { hpc, ide };
        await stateManager.save();
        stateManager.releaseLock(lockName);
        return res.json({ status: 'connected', hpc, ide, jobId: session.jobId, node: session.node });
      }

      // Reject if starting/pending (in progress)
      if (session.status !== 'idle') {
        stateManager.releaseLock(lockName);
        return res.status(400).json({ error: `${hpc} ${ide} is already ${session.status}` });
      }

      // SECURITY: Validate inputs before using in shell command
      try {
        validateSbatchInputs(cpus, mem, time);
      } catch (e) {
        stateManager.releaseLock(lockName);
        return res.status(400).json({ error: e.message });
      }

      session.status = 'starting';
      session.ide = ide;
      session.error = null;
      session.cpus = cpus;
      session.memory = mem;
      session.walltime = time;
      await stateManager.save();

      const hpcService = new HpcService(hpc);

      // Check for existing job for this IDE
      let jobInfo = await hpcService.getJobInfo(ide);

      if (!jobInfo) {
        // Submit new job
        log.job(`Submitting new job`, { hpc, ide, cpus, mem, time });
        session.jobId = await hpcService.submitJob(cpus, mem, time, ide);
        log.job(`Submitted`, { hpc, ide, jobId: session.jobId });
      } else {
        session.jobId = jobInfo.jobId;
        session.node = jobInfo.node;
        log.job(`Found existing job`, { hpc, ide, jobId: session.jobId });
      }

      // Wait for job to get a node
      log.job('Waiting for node assignment...', { hpc, ide, jobId: session.jobId });
      session.node = await hpcService.waitForNode(session.jobId, ide);
      log.job(`Running on node`, { hpc, ide, node: session.node });

      // Wait a moment for IDE to start
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Start tunnel and wait for it to establish
      session.tunnelProcess = await tunnelService.start(hpc, session.node, ide, (code) => {
        // Tunnel exit callback
        log.tunnel(`Exit callback`, { hpc, ide, code });
        if (session.status === 'running') {
          session.status = 'idle';
        }
        session.tunnelProcess = null;
      });

      session.status = 'running';
      session.startedAt = new Date().toISOString();
      state.activeSession = { hpc, ide };
      await stateManager.save();

      res.json({
        status: 'running',
        jobId: session.jobId,
        node: session.node,
        hpc,
        ide,
      });

    } catch (error) {
      log.error('Launch error', { hpc, ide, error: error.message });
      // Access session via state (session variable is scoped inside try block)
      const session = state.sessions[sessionKey];
      if (session) {
        session.status = 'idle';
        session.error = error.message;
        await stateManager.save();
      }

      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    } finally {
      stateManager.releaseLock(lockName);
    }
  });

  // Switch active session (connect to different HPC/IDE)
  router.post('/switch/:hpc/:ide', async (req, res) => {
    const { hpc, ide } = req.params;

    // Validate IDE type
    if (!ides[ide]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    const sessionKey = getSessionKey(hpc, ide);
    const session = state.sessions[sessionKey];

    if (!session || session.status !== 'running') {
      return res.status(400).json({ error: `No running ${ide} session on ${hpc}` });
    }

    // Stop current active tunnel if switching to different session
    if (state.activeSession) {
      const { hpc: activeHpc, ide: activeIde } = state.activeSession;
      if (activeHpc !== hpc || activeIde !== ide) {
        tunnelService.stop(activeHpc, activeIde);
      }
    }

    // Start tunnel to the requested HPC/IDE
    try {
      if (!session.tunnelProcess) {
        session.tunnelProcess = await tunnelService.start(hpc, session.node, ide, (code) => {
          if (session.status === 'running') {
            session.status = 'idle';
          }
          session.tunnelProcess = null;
        });
      }

      state.activeSession = { hpc, ide };
      await stateManager.save();
      log.api(`Switched to ${hpc} ${ide}`, { hpc, ide });
      res.json({ status: 'switched', hpc, ide });
    } catch (error) {
      log.error('Switch error', { hpc, ide, error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Stop session for specific HPC/IDE
  router.post('/stop/:hpc/:ide', async (req, res) => {
    const { cancelJob = false } = req.body;
    const { hpc, ide } = req.params;

    // Validate IDE type
    if (!ides[ide]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    const sessionKey = getSessionKey(hpc, ide);
    const session = state.sessions[sessionKey];

    // Stop tunnel if exists
    tunnelService.stop(hpc, ide);

    // Cancel SLURM job if requested
    if (cancelJob) {
      try {
        const hpcService = new HpcService(hpc);

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
        }
      } catch (e) {
        log.error('Failed to cancel job', { hpc, ide, error: e.message });
      }
    }

    // Reset session
    state.sessions[sessionKey] = createSession(ide);

    // Clear active session if this was it
    if (state.activeSession?.hpc === hpc && state.activeSession?.ide === ide) {
      state.activeSession = null;
    }

    await stateManager.save();

    res.json({ status: 'stopped', hpc, ide });
  });

  return router;
}

module.exports = createApiRouter;
