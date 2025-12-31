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
const { config } = require('../config');

// Shared tunnel service instance
const tunnelService = new TunnelService();

/**
 * Initialize router with state manager dependency
 * @param {StateManager} stateManager - State manager instance
 * @returns {express.Router} Configured router
 */
function createApiRouter(stateManager) {
  const state = stateManager.state;

  // Helper: create session object
  function createSession() {
    return {
      status: 'idle',
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

  // Helper: get sessions info for status endpoint
  function getSessionsInfo() {
    const sessions = {};
    for (const [hpc, session] of Object.entries(state.sessions)) {
      if (!session) {
        sessions[hpc] = { status: 'idle' };
        continue;
      }

      sessions[hpc] = {
        status: session.status,
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

  // Get session status
  router.get('/status', async (req, res) => {
    // Check actual job status for running sessions
    let stateChanged = false;

    for (const [hpc, session] of Object.entries(state.sessions)) {
      if (session && session.status === 'running' && session.jobId) {
        try {
          const hpcService = new HpcService(hpc);
          const jobInfo = await hpcService.getJobInfo();

          if (!jobInfo || jobInfo.jobId !== session.jobId) {
            // Job disappeared
            tunnelService.stop(hpc);
            session.status = 'idle';
            session.jobId = null;
            session.node = null;
            if (state.activeHpc === hpc) {
              state.activeHpc = null;
            }
            stateChanged = true;
          }
        } catch (e) {
          console.error(`Error checking job status for ${hpc}:`, e);
        }
      }
    }

    if (stateChanged) {
      await stateManager.save();
    }

    res.json({
      sessions: getSessionsInfo(),
      activeHpc: state.activeHpc,
      config: {
        defaultHpc: config.defaultHpc,
        defaultCpus: config.defaultCpus,
        defaultMem: config.defaultMem,
        defaultTime: config.defaultTime,
      }
    });
  });

  // Get job status for both clusters (checks SLURM directly)
  router.get('/cluster-status', async (req, res) => {
    try {
      const geminiService = new HpcService('gemini');
      const apolloService = new HpcService('apollo');

      const [geminiJob, apolloJob] = await Promise.all([
        geminiService.getJobInfo(),
        apolloService.getJobInfo(),
      ]);

      const formatClusterStatus = (job) => {
        if (!job) return { status: 'idle' };

        const timeLeftSeconds = parseTimeToSeconds(job.timeLeft);

        return {
          status: job.state === 'RUNNING' ? 'running' : 'pending',
          jobId: job.jobId,
          node: job.node,
          timeLeft: job.timeLeft,
          timeLeftSeconds,
          timeLeftHuman: formatHumanTime(timeLeftSeconds),
          cpus: job.cpus,
          memory: job.memory,
          startTime: job.startTime,
        };
      };

      res.json({
        gemini: formatClusterStatus(geminiJob),
        apollo: formatClusterStatus(apolloJob),
        activeHpc: state.activeHpc,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Launch session
  router.post('/launch', async (req, res) => {
    const {
      hpc = config.defaultHpc,
      cpus = config.defaultCpus,
      mem = config.defaultMem,
      time = config.defaultTime
    } = req.body;

    // Initialize session if needed
    if (!state.sessions[hpc]) {
      state.sessions[hpc] = createSession();
    }

    const session = state.sessions[hpc];

    // If already running, just switch to this session (reconnect)
    if (session.status === 'running') {
      // Stop any other active tunnel
      if (state.activeHpc && state.activeHpc !== hpc) {
        tunnelService.stop(state.activeHpc);
      }

      // Ensure tunnel is running for this session
      if (!session.tunnelProcess) {
        try {
          session.tunnelProcess = await tunnelService.start(hpc, session.node, (code) => {
            // Tunnel exit callback
            if (session.status === 'running') {
              session.status = 'idle';
            }
            session.tunnelProcess = null;
          });
        } catch (error) {
          return res.status(500).json({ error: error.message });
        }
      }

      state.activeHpc = hpc;
      await stateManager.save();
      return res.json({ status: 'connected', hpc, jobId: session.jobId, node: session.node });
    }

    // Reject if starting/pending (in progress)
    if (session.status !== 'idle') {
      return res.status(400).json({ error: `${hpc} is already ${session.status}` });
    }

    // SECURITY: Validate inputs before using in shell command
    try {
      validateSbatchInputs(cpus, mem, time);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    session.status = 'starting';
    session.error = null;
    session.cpus = cpus;
    session.memory = mem;
    session.walltime = time;
    await stateManager.save();

    try {
      const hpcService = new HpcService(hpc);

      // Check for existing job
      let jobInfo = await hpcService.getJobInfo();

      if (!jobInfo) {
        // Submit new job
        console.log(`Submitting new job on ${hpc}...`);
        session.jobId = await hpcService.submitJob(cpus, mem, time);
        console.log(`Submitted job ${session.jobId}`);
      } else {
        session.jobId = jobInfo.jobId;
        console.log(`Found existing job ${session.jobId}`);
      }

      // Wait for job to get a node
      console.log('Waiting for node assignment...');
      session.node = await hpcService.waitForNode(session.jobId);
      console.log(`Job running on ${session.node}`);

      // Wait a moment for code-server to start
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Stop any existing tunnel first
      if (state.activeHpc && state.activeHpc !== hpc) {
        tunnelService.stop(state.activeHpc);
      }

      // Start tunnel and wait for it to establish
      session.tunnelProcess = await tunnelService.start(hpc, session.node, (code) => {
        // Tunnel exit callback
        console.log(`Tunnel for ${hpc} exited with code ${code}`);
        if (session.status === 'running') {
          session.status = 'idle';
        }
        session.tunnelProcess = null;
      });

      session.status = 'running';
      session.startedAt = new Date().toISOString();
      state.activeHpc = hpc;
      await stateManager.save();

      res.json({
        status: 'running',
        jobId: session.jobId,
        node: session.node,
        hpc,
      });

    } catch (error) {
      console.error('Launch error:', error);
      session.status = 'idle';
      session.error = error.message;
      await stateManager.save();

      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  });

  // Switch active HPC
  router.post('/switch/:hpc', async (req, res) => {
    const { hpc } = req.params;
    const session = state.sessions[hpc];

    if (!session || session.status !== 'running') {
      return res.status(400).json({ error: `No running session on ${hpc}` });
    }

    // Stop current tunnel if different
    if (state.activeHpc && state.activeHpc !== hpc) {
      tunnelService.stop(state.activeHpc);
    }

    // Start tunnel to the requested HPC
    try {
      if (!session.tunnelProcess) {
        session.tunnelProcess = await tunnelService.start(hpc, session.node, (code) => {
          if (session.status === 'running') {
            session.status = 'idle';
          }
          session.tunnelProcess = null;
        });
      }

      state.activeHpc = hpc;
      await stateManager.save();
      res.json({ status: 'switched', hpc });
    } catch (error) {
      console.error('Switch error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Stop session
  router.post('/stop/:hpc?', async (req, res) => {
    const { cancelJob = false } = req.body;
    const hpc = req.params.hpc || state.activeHpc;

    if (!hpc) {
      return res.status(400).json({ error: 'No HPC specified' });
    }

    const session = state.sessions[hpc];
    if (!session) {
      return res.status(400).json({ error: `No session for ${hpc}` });
    }

    // Stop tunnel
    tunnelService.stop(hpc);

    // Cancel SLURM job if requested
    if (cancelJob && session.jobId) {
      try {
        const hpcService = new HpcService(hpc);
        await hpcService.cancelJob(session.jobId);
        console.log(`Cancelled job ${session.jobId} on ${hpc}`);
      } catch (e) {
        console.error('Failed to cancel job:', e);
      }
    }

    // Reset session
    state.sessions[hpc] = createSession();
    if (state.activeHpc === hpc) {
      state.activeHpc = null;
    }

    await stateManager.save();

    res.json({ status: 'stopped', hpc });
  });

  return router;
}

module.exports = createApiRouter;
