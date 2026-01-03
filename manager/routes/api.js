/**
 * API Routes
 * Handles all /api/* endpoints using extracted services
 */

const express = require('express');
const router = express.Router();

// Parse JSON bodies only for API routes (not globally, which breaks http-proxy)
router.use(express.json());
const HpcService = require('../services/hpc');
const TunnelService = require('../services/tunnel');
const { validateSbatchInputs } = require('../lib/validation');
const { parseTimeToSeconds, formatHumanTime } = require('../lib/helpers');
const { config, ides } = require('../config');
const { log } = require('../lib/logger');
const { createClusterCache } = require('../lib/cache');

// Shared tunnel service instance
const tunnelService = new TunnelService();

// Status cache - reduces SSH calls to HPC clusters
// Long TTL (30min) since we invalidate on user actions (launch/kill)
// Client uses time-aware adaptive polling (15s-1hr) with exponential backoff
// This ensures multi-user environments see updates immediately via cache invalidation
// while dramatically reducing SSH load for stable long-running jobs (6-24+ hours)
const STATUS_CACHE_TTL = parseInt(process.env.STATUS_CACHE_TTL) || 1800000; // 30 minutes default

// Per-cluster cache to avoid invalidating both clusters on single job change
const statusCache = createClusterCache(STATUS_CACHE_TTL);

// Progress weights (cumulative percentages) based on observed timing
// See plan for timing analysis: submit ~3s, wait ~3.5s, IDE startup 5s (hardcoded)
const LAUNCH_PROGRESS = {
  connecting: 3,      // Quick SSH connect check
  submitting: 28,     // 2-4s SSH + sbatch
  submitted: 33,      // Instant milestone (shows job ID)
  waiting: 58,        // 3-4s SLURM scheduling (CV 22%)
  starting: 63,       // Instant milestone (shows node name)
  startingIde: 95,    // 5s hardcoded wait for IDE startup
  establishing: 100,  // Tunnel setup complete
};

/**
 * Invalidate the cluster status cache
 * Call after job state changes (cancel, submit) to force fresh poll
 * @param {string} cluster - Optional cluster name ('gemini' or 'apollo'). If not provided, invalidates all.
 */
function invalidateStatusCache(cluster = null) {
  statusCache.invalidate(cluster);
}

/**
 * Fetch fresh status for a single cluster and update its cache
 * @param {string} clusterName - Cluster name ('gemini' or 'apollo')
 * @returns {Promise<Object>} Fresh cluster status data
 */
async function fetchSingleClusterStatus(clusterName) {
  log.info(`Fetching fresh status for ${clusterName}`);

  const hpcService = new HpcService(clusterName);
  const jobs = await hpcService.getAllJobs();

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

  const formatClusterStatus = (jobs) => {
    const result = {};
    for (const [ide, job] of Object.entries(jobs)) {
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
 * @param {Object} state - Current state object
 * @returns {Promise<Object>} Fresh cluster status data for all clusters
 */
async function fetchClusterStatus(state) {
  log.info('Fetching fresh cluster status for all clusters');

  // Fetch both clusters in parallel
  const [geminiData, apolloData] = await Promise.all([
    fetchSingleClusterStatus('gemini'),
    fetchSingleClusterStatus('apollo'),
  ]);

  return {
    gemini: geminiData,
    apollo: apolloData,
    activeSession: state.activeSession,
    ides: Object.fromEntries(
      Object.entries(ides).map(([k, v]) => [k, { name: v.name, icon: v.icon, proxyPath: v.proxyPath }])
    ),
    updatedAt: new Date().toISOString(),
  };
}

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

  // Health check - returns 503 if state manager not ready
  router.get('/health', (req, res) => {
    if (!stateManager.isReady()) {
      return res.status(503).json({ status: 'starting', ready: false });
    }
    res.json({ status: 'ok', ready: true });
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

    try {
      // Check cache status for each cluster
      const geminiCache = statusCache.get('gemini');
      const apolloCache = statusCache.get('apollo');

      const geminiFetchNeeded = !geminiCache.valid || forceRefresh;
      const apolloFetchNeeded = !apolloCache.valid || forceRefresh;

      // Fetch stale clusters in parallel for better performance
      const promises = [];
      if (geminiFetchNeeded) {
        promises.push(fetchSingleClusterStatus('gemini'));
      } else {
        log.debug('Using cached gemini status', { ageMs: geminiCache.age });
        promises.push(Promise.resolve(geminiCache.data));
      }

      if (apolloFetchNeeded) {
        promises.push(fetchSingleClusterStatus('apollo'));
      } else {
        log.debug('Using cached apollo status', { ageMs: apolloCache.age });
        promises.push(Promise.resolve(apolloCache.data));
      }

      const [geminiData, apolloData] = await Promise.all(promises);

      const anyFresh = geminiFetchNeeded || apolloFetchNeeded;
      const geminiCacheAge = geminiFetchNeeded ? 0 : geminiCache.age;
      const apolloCacheAge = apolloFetchNeeded ? 0 : apolloCache.age;
      const maxCacheAge = Math.max(geminiCacheAge, apolloCacheAge);

      res.json({
        gemini: geminiData,
        apollo: apolloData,
        activeSession: state.activeSession,  // Always use current activeSession, not cached
        ides: Object.fromEntries(
          Object.entries(ides).map(([k, v]) => [k, { name: v.name, icon: v.icon, proxyPath: v.proxyPath }])
        ),
        updatedAt: new Date().toISOString(),
        cached: !anyFresh,
        cacheAge: Math.floor(maxCacheAge / 1000),
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
        const result = await hpcService.submitJob(cpus, mem, time, ide);
        session.jobId = result.jobId;
        log.job(`Submitted`, { hpc, ide, jobId: session.jobId });
      } else {
        session.jobId = jobInfo.jobId;
        session.node = jobInfo.node;
        log.job(`Found existing job`, { hpc, ide, jobId: session.jobId });
      }

      // Wait for job to get a node
      log.job('Waiting for node assignment...', { hpc, ide, jobId: session.jobId });
      const waitResult = await hpcService.waitForNode(session.jobId, ide);
      if (waitResult.pending) {
        throw new Error('Timeout waiting for node assignment');
      }
      session.node = waitResult.node;
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

      // Invalidate cache for this cluster and fetch fresh status after successful launch
      // This ensures ALL users (multi-user environment) see the new job on their next poll
      invalidateStatusCache(hpc);
      let clusterStatus = null;
      try {
        clusterStatus = await fetchClusterStatus(state);
      } catch (e) {
        log.error('Failed to refresh cluster status after launch', { error: e.message });
      }

      res.json({
        status: 'running',
        jobId: session.jobId,
        node: session.node,
        hpc,
        ide,
        clusterStatus,
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

  // Launch session with SSE progress streaming
  // Returns real-time progress events during job submission and startup
  router.get('/launch/:hpc/:ide/stream', async (req, res) => {
    const { hpc, ide } = req.params;
    const cpus = req.query.cpus || config.defaultCpus;
    const mem = req.query.mem || config.defaultMem;
    const time = req.query.time || config.defaultTime;

    // Validate IDE type
    if (!ides[ide]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    // Set up SSE response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Helper to send progress events
    const sendProgress = (step, message, extra = {}) => {
      const progress = LAUNCH_PROGRESS[step] || 0;
      const data = JSON.stringify({ type: 'progress', step, progress, message, ...extra });
      res.write(`data: ${data}\n\n`);
    };

    // Helper to send error event
    const sendError = (message) => {
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    };

    // Helper to send completion event
    const sendComplete = (data) => {
      res.write(`data: ${JSON.stringify({ type: 'complete', ...data })}\n\n`);
      res.end();
    };

    const sessionKey = getSessionKey(hpc, ide);
    const lockName = `launch:${sessionKey}`;

    // Acquire lock to prevent concurrent launches
    try {
      stateManager.acquireLock(lockName);
    } catch (e) {
      return sendError(e.message);
    }

    try {
      // Initialize session if needed
      if (!state.sessions[sessionKey]) {
        state.sessions[sessionKey] = createSession(ide);
      }

      const session = state.sessions[sessionKey];

      // If already running, just switch to this session (reconnect)
      if (session.status === 'running') {
        sendProgress('connecting', 'Reconnecting to existing session...');

        // Ensure tunnel is running for this session
        if (!session.tunnelProcess) {
          try {
            session.tunnelProcess = await tunnelService.start(hpc, session.node, ide, (code) => {
              if (session.status === 'running') {
                session.status = 'idle';
              }
              session.tunnelProcess = null;
            });
          } catch (error) {
            stateManager.releaseLock(lockName);
            return sendError(error.message);
          }
        }

        state.activeSession = { hpc, ide };
        await stateManager.save();
        stateManager.releaseLock(lockName);

        const ideConfig = ides[ide];
        return sendComplete({
          status: 'connected',
          hpc,
          ide,
          jobId: session.jobId,
          node: session.node,
          redirectUrl: ideConfig?.proxyPath || '/code/',
        });
      }

      // Reject if starting/pending (in progress)
      if (session.status !== 'idle') {
        stateManager.releaseLock(lockName);
        return sendError(`${hpc} ${ide} is already ${session.status}`);
      }

      // SECURITY: Validate inputs before using in shell command
      try {
        validateSbatchInputs(cpus, mem, time);
      } catch (e) {
        stateManager.releaseLock(lockName);
        return sendError(e.message);
      }

      session.status = 'starting';
      session.ide = ide;
      session.error = null;
      session.cpus = cpus;
      session.memory = mem;
      session.walltime = time;
      await stateManager.save();

      // Step 1: Connecting
      sendProgress('connecting', `Connecting to ${hpc}...`);

      const hpcService = new HpcService(hpc);

      // Check for existing job for this IDE
      let jobInfo = await hpcService.getJobInfo(ide);

      if (!jobInfo) {
        // Step 2: Submitting
        sendProgress('submitting', 'Submitting job...');
        log.job(`Submitting new job`, { hpc, ide, cpus, mem, time });

        const result = await hpcService.submitJob(cpus, mem, time, ide);
        session.jobId = result.jobId;

        // Step 3: Submitted (milestone)
        sendProgress('submitted', `Job submitted (ID: ${session.jobId})`, { jobId: session.jobId });
        log.job(`Submitted`, { hpc, ide, jobId: session.jobId });
      } else {
        session.jobId = jobInfo.jobId;
        session.node = jobInfo.node;
        sendProgress('submitted', `Found existing job (ID: ${session.jobId})`, { jobId: session.jobId });
        log.job(`Found existing job`, { hpc, ide, jobId: session.jobId });
      }

      // Step 4: Waiting for node
      sendProgress('waiting', 'Waiting for node...');
      log.job('Waiting for node assignment...', { hpc, ide, jobId: session.jobId });

      // Wait for job to get a node (30s timeout for pending handling)
      const waitResult = await hpcService.waitForNode(session.jobId, ide, 6); // 6 attempts * 5s = 30s

      if (waitResult.pending) {
        // Job still pending after 30s - return to launcher with pending state
        session.status = 'pending';
        await stateManager.save();
        stateManager.releaseLock(lockName);

        res.write(`data: ${JSON.stringify({
          type: 'pending-timeout',
          jobId: session.jobId,
          message: 'Job queued, check back soon',
        })}\n\n`);
        return res.end();
      }

      session.node = waitResult.node;

      // Step 5: Starting on node (milestone)
      sendProgress('starting', `Starting on ${session.node}...`, { node: session.node });
      log.job(`Running on node`, { hpc, ide, node: session.node });

      // Step 6: Starting IDE (5s hardcoded wait)
      const ideName = ides[ide]?.name || ide;
      sendProgress('startingIde', `Starting ${ideName}...`);
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Step 7: Establishing connection
      sendProgress('establishing', 'Establishing connection...');

      // Start tunnel and wait for it to establish
      session.tunnelProcess = await tunnelService.start(hpc, session.node, ide, (code) => {
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

      // Invalidate cache for this cluster
      invalidateStatusCache(hpc);

      const ideConfig = ides[ide];
      sendComplete({
        status: 'running',
        jobId: session.jobId,
        node: session.node,
        hpc,
        ide,
        redirectUrl: ideConfig?.proxyPath || '/code/',
      });

    } catch (error) {
      log.error('Launch stream error', { hpc, ide, error: error.message });
      const session = state.sessions[sessionKey];
      if (session) {
        session.status = 'idle';
        session.error = error.message;
        await stateManager.save();
      }
      sendError(error.message);
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
  // When cancelJob=true, also refreshes cluster status cache so UI sees freed slot
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
    let jobCancelled = false;
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
          jobCancelled = true;
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

    // If we cancelled a job, invalidate cache for this cluster and fetch fresh status
    // This ensures ALL users (multi-user environment) immediately see the freed slot
    let clusterStatus = null;
    if (jobCancelled) {
      invalidateStatusCache(hpc);
      try {
        // Small delay to let SLURM process the cancellation
        await new Promise(resolve => setTimeout(resolve, 1000));
        clusterStatus = await fetchClusterStatus(state);
      } catch (e) {
        log.error('Failed to refresh cluster status after cancel', { error: e.message });
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
  router.get('/stop/:hpc/:ide/stream', async (req, res) => {
    const { hpc, ide } = req.params;

    // Validate IDE type
    if (!ides[ide]) {
      return res.status(400).json({ error: `Unknown IDE: ${ide}` });
    }

    // Set up SSE response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Helper to send progress events (indeterminate - no percentage)
    const sendProgress = (step, message) => {
      res.write(`data: ${JSON.stringify({ type: 'progress', step, message })}\n\n`);
    };

    // Helper to send completion event
    const sendComplete = (data) => {
      res.write(`data: ${JSON.stringify({ type: 'complete', ...data })}\n\n`);
      res.end();
    };

    // Helper to send error event
    const sendError = (message) => {
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    };

    try {
      const sessionKey = getSessionKey(hpc, ide);
      const session = state.sessions[sessionKey];

      sendProgress('cancelling', 'Cancelling job...');

      // Stop tunnel if exists
      tunnelService.stop(hpc, ide);

      // Cancel SLURM job
      let jobCancelled = false;
      const hpcService = new HpcService(hpc);

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

      // Reset session
      state.sessions[sessionKey] = createSession(ide);

      // Clear active session if this was it
      if (state.activeSession?.hpc === hpc && state.activeSession?.ide === ide) {
        state.activeSession = null;
      }

      await stateManager.save();

      // Invalidate cache and fetch fresh status
      if (jobCancelled) {
        invalidateStatusCache(hpc);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      sendComplete({
        status: 'stopped',
        hpc,
        ide,
        jobCancelled,
      });

    } catch (error) {
      log.error('Stop stream error', { hpc, ide, error: error.message });
      sendError(error.message);
    }
  });

  return router;
}

module.exports = createApiRouter;
