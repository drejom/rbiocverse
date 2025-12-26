const express = require('express');
const { spawn, exec } = require('child_process');
const httpProxy = require('http-proxy');

const app = express();
app.use(express.json());

// Configuration from environment
const config = {
  hpcUser: process.env.HPC_SSH_USER || 'domeally',
  defaultHpc: process.env.DEFAULT_HPC || 'gemini',
  codeServerPort: parseInt(process.env.CODE_SERVER_PORT) || 8000,
  defaultCpus: process.env.DEFAULT_CPUS || '2',
  defaultMem: process.env.DEFAULT_MEM || '40G',
  defaultTime: process.env.DEFAULT_TIME || '12:00:00',
};

// Per-cluster configuration
const clusters = {
  gemini: {
    host: process.env.GEMINI_SSH_HOST || 'gemini-login2.coh.org',
    partition: 'compute',
    singularityBin: '/packages/easy-build/software/singularity/3.7.0/bin/singularity',
    singularityImage: '/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.19.sif',
    rLibsSite: '/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.19',
    bindPaths: '/packages,/run,/scratch,/ref_genomes',
  },
  apollo: {
    host: process.env.APOLLO_SSH_HOST || 'ppxhpcacc01.coh.org',
    partition: 'fast,all',
    singularityBin: '/opt/singularity/3.7.0/bin/singularity',
    singularityImage: '/opt/singularity-images/rbioc/vscode-rbioc_3.19.sif',
    rLibsSite: '/opt/singularity-images/rbioc/rlibs/bioc-3.19',
    bindPaths: '/opt,/run,/labs',
  },
};

// Multi-session state - track sessions per HPC
let state = {
  sessions: {
    gemini: null,  // { status, jobId, node, tunnelProcess, startedAt, cpus, memory, walltime, error }
    apollo: null,
  },
  activeHpc: null,  // Which HPC is currently being proxied
};

// Create a session object
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

// Proxy for forwarding to code-server when tunnel is active
const proxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${config.codeServerPort}`,
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  // Check if headers already sent (from response wrapper)
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>Code server not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Helper: run SSH command
function sshExec(hpc, command) {
  const cluster = clusters[hpc] || clusters.gemini;
  return new Promise((resolve, reject) => {
    exec(`ssh -o StrictHostKeyChecking=no ${config.hpcUser}@${cluster.host} "${command}"`,
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout.trim());
      }
    );
  });
}

// Helper: get job info with timing data
async function getJobInfo(hpc) {
  try {
    const output = await sshExec(hpc,
      `squeue --user=${config.hpcUser} --name=code-server --states=R,PD -h -O JobID,State,NodeList,TimeLeft,NumCPUs,MinMemory,StartTime 2>/dev/null | head -1`
    );
    if (!output) return null;

    const parts = output.split(/\s+/);
    const [jobId, jobState, node, timeLeft, cpus, memory, ...startTimeParts] = parts;
    const startTime = startTimeParts.join(' '); // StartTime may have spaces

    return {
      jobId,
      state: jobState,
      node: node === '(null)' ? null : node,
      timeLeft: timeLeft === 'INVALID' ? null : timeLeft,
      cpus: cpus || null,
      memory: memory || null,
      startTime: startTime === 'N/A' ? null : startTime,
    };
  } catch (e) {
    return null;
  }
}

// Helper: parse time string (HH:MM:SS or D-HH:MM:SS) to seconds
function parseTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length === 3) {
    // Check for days (D-HH:MM:SS)
    const [h, m, s] = parts;
    if (h.includes('-')) {
      const [days, hours] = h.split('-');
      return parseInt(days) * 86400 + parseInt(hours) * 3600 + parseInt(m) * 60 + parseInt(s);
    }
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
  }
  return null;
}

// Helper: format seconds to human readable (11h 45m)
function formatHumanTime(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Helper: check if port is open
function checkPort(port, timeout = 1000) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

// Helper: start SSH tunnel and wait for it to establish
async function startTunnel(hpc, node) {
  const cluster = clusters[hpc] || clusters.gemini;
  const port = config.codeServerPort;

  console.log(`Starting tunnel: localhost:${port} -> ${node}:${port} via ${cluster.host}`);

  const tunnel = spawn('ssh', [
    '-v',  // Verbose for debugging
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-N',
    '-L', `${port}:${node}:${port}`,
    `${config.hpcUser}@${cluster.host}`
  ]);

  // Log stderr for debugging
  tunnel.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`SSH: ${line}`);
  });

  tunnel.on('error', (err) => {
    console.error('Tunnel spawn error:', err);
    const session = state.sessions[hpc];
    if (session) {
      session.status = 'idle';
      session.tunnelProcess = null;
    }
  });

  tunnel.on('exit', (code) => {
    console.log(`Tunnel for ${hpc} exited with code ${code}`);
    const session = state.sessions[hpc];
    if (session && session.status === 'running') {
      session.status = 'idle';
    }
    if (session) session.tunnelProcess = null;
  });

  // Wait for tunnel to establish (check port becomes available)
  console.log('Waiting for tunnel to establish...');
  for (let i = 0; i < 30; i++) {  // 30 seconds max
    await new Promise(r => setTimeout(r, 1000));

    // Check if tunnel process died
    if (tunnel.exitCode !== null) {
      throw new Error(`Tunnel exited with code ${tunnel.exitCode}`);
    }

    // Check if port is open
    if (await checkPort(port)) {
      console.log(`Tunnel established on port ${port}`);
      return tunnel;
    }
  }

  // Timeout - kill tunnel and throw
  tunnel.kill();
  throw new Error('Tunnel failed to establish after 30 seconds');
}

// Helper: stop tunnel for an HPC
function stopTunnel(hpc) {
  const session = state.sessions[hpc];
  if (session && session.tunnelProcess) {
    session.tunnelProcess.kill();
    session.tunnelProcess = null;
  }
}

// Helper: calculate remaining walltime
function calculateRemainingTime(startedAt, walltime) {
  if (!startedAt || !walltime) return null;

  // Parse walltime (HH:MM:SS)
  const parts = walltime.split(':').map(Number);
  const walltimeMs = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;

  const elapsed = Date.now() - new Date(startedAt).getTime();
  const remaining = walltimeMs - elapsed;

  if (remaining <= 0) return '00:00:00';

  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Check if any session is running
function hasRunningSession() {
  return Object.values(state.sessions).some(s => s && s.status === 'running');
}

// Get all session info for API
function getSessionsInfo() {
  const sessions = {};
  for (const [hpc, session] of Object.entries(state.sessions)) {
    if (session) {
      sessions[hpc] = {
        status: session.status,
        jobId: session.jobId,
        node: session.node,
        startedAt: session.startedAt,
        cpus: session.cpus,
        memory: session.memory,
        walltime: session.walltime,
        remainingTime: calculateRemainingTime(session.startedAt, session.walltime),
        error: session.error,
      };
    }
  }
  return sessions;
}

// API Routes

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/status', async (req, res) => {
  // Check actual job status for running sessions
  for (const [hpc, session] of Object.entries(state.sessions)) {
    if (session && session.status === 'running' && session.jobId) {
      const jobInfo = await getJobInfo(hpc);
      if (!jobInfo || jobInfo.jobId !== session.jobId) {
        // Job disappeared
        stopTunnel(hpc);
        session.status = 'idle';
        session.jobId = null;
        session.node = null;
        if (state.activeHpc === hpc) {
          state.activeHpc = null;
        }
      }
    }
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
app.get('/api/cluster-status', async (req, res) => {
  try {
    const [geminiJob, apolloJob] = await Promise.all([
      getJobInfo('gemini'),
      getJobInfo('apollo'),
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

app.post('/api/launch', async (req, res) => {
  const { hpc = config.defaultHpc, cpus = config.defaultCpus, mem = config.defaultMem, time = config.defaultTime } = req.body;

  // Initialize session if needed
  if (!state.sessions[hpc]) {
    state.sessions[hpc] = createSession();
  }

  const session = state.sessions[hpc];

  if (session.status !== 'idle') {
    return res.status(400).json({ error: `${hpc} is already ${session.status}` });
  }

  session.status = 'starting';
  session.error = null;
  session.cpus = cpus;
  session.memory = mem;
  session.walltime = time;

  try {
    // Check for existing job
    let jobInfo = await getJobInfo(hpc);

    if (!jobInfo) {
      // Submit new job
      console.log(`Submitting new job on ${hpc}...`);
      const cluster = clusters[hpc] || clusters.gemini;

      const logDir = `/home/${config.hpcUser}/vscode-slurm-logs`;
      const submitCmd = `sbatch --job-name=code-server --nodes=1 --cpus-per-task=${cpus} --mem=${mem} --partition=${cluster.partition} --time=${time} --output=${logDir}/code-server_%j.log --error=${logDir}/code-server_%j.err --wrap='mkdir -p ${logDir} && ${cluster.singularityBin} exec --env TERM=xterm-256color --env R_LIBS_SITE=${cluster.rLibsSite} -B ${cluster.bindPaths} ${cluster.singularityImage} code serve-web --host 0.0.0.0 --port ${config.codeServerPort} --without-connection-token --accept-server-license-terms --server-base-path /code --server-data-dir ~/.vscode-slurm/.vscode-server --extensions-dir ~/.vscode-slurm/.vscode-server/extensions'`;

      const output = await sshExec(hpc, submitCmd);
      const match = output.match(/Submitted batch job (\d+)/);
      if (!match) throw new Error('Failed to parse job ID from: ' + output);

      session.jobId = match[1];
      console.log(`Submitted job ${session.jobId}`);
    } else {
      session.jobId = jobInfo.jobId;
      console.log(`Found existing job ${session.jobId}`);
    }

    // Wait for job to get a node
    console.log('Waiting for node assignment...');
    let attempts = 0;
    while (attempts < 60) { // 5 minutes max
      jobInfo = await getJobInfo(hpc);

      if (!jobInfo) {
        throw new Error('Job disappeared from queue');
      }

      if (jobInfo.state === 'RUNNING' && jobInfo.node) {
        session.node = jobInfo.node;
        break;
      }

      await new Promise(r => setTimeout(r, 5000));
      attempts++;
    }

    if (!session.node) {
      throw new Error('Timeout waiting for node assignment');
    }

    console.log(`Job running on ${session.node}`);

    // Wait a moment for code-server to start
    await new Promise(r => setTimeout(r, 5000));

    // Stop any existing tunnel first
    if (state.activeHpc && state.activeHpc !== hpc) {
      stopTunnel(state.activeHpc);
    }

    // Start tunnel and wait for it to establish
    session.tunnelProcess = await startTunnel(hpc, session.node);
    session.status = 'running';
    session.startedAt = new Date().toISOString();
    state.activeHpc = hpc;

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
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.post('/api/switch/:hpc', async (req, res) => {
  const { hpc } = req.params;
  const session = state.sessions[hpc];

  if (!session || session.status !== 'running') {
    return res.status(400).json({ error: `No running session on ${hpc}` });
  }

  // Stop current tunnel if different
  if (state.activeHpc && state.activeHpc !== hpc) {
    stopTunnel(state.activeHpc);
  }

  // Start tunnel to the requested HPC
  try {
    if (!session.tunnelProcess) {
      session.tunnelProcess = await startTunnel(hpc, session.node);
    }

    state.activeHpc = hpc;
    res.json({ status: 'switched', hpc });
  } catch (error) {
    console.error('Switch error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop/:hpc?', async (req, res) => {
  const { cancelJob = false } = req.body;
  const hpc = req.params.hpc || state.activeHpc;

  if (!hpc) {
    return res.status(400).json({ error: 'No HPC specified' });
  }

  const session = state.sessions[hpc];
  if (!session) {
    return res.status(400).json({ error: `No session for ${hpc}` });
  }

  stopTunnel(hpc);

  if (cancelJob && session.jobId) {
    try {
      await sshExec(hpc, `scancel ${session.jobId}`);
      console.log(`Cancelled job ${session.jobId} on ${hpc}`);
    } catch (e) {
      console.error('Failed to cancel job:', e);
    }
  }

  state.sessions[hpc] = createSession();

  if (state.activeHpc === hpc) {
    // Switch to another running session if available
    state.activeHpc = Object.entries(state.sessions)
      .find(([h, s]) => s && s.status === 'running')?.[0] || null;
  }

  res.json({ status: 'stopped', hpc });
});

// Full-screen launcher page
function renderLauncherPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>HPC Code Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      padding: 20px;
    }
    .launcher {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 30px;
      max-width: 600px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 8px;
      text-align: center;
    }
    .subtitle {
      color: rgba(255,255,255,0.6);
      margin-bottom: 25px;
      text-align: center;
    }
    .cluster-card {
      background: rgba(255,255,255,0.05);
      border: 2px solid rgba(255,255,255,0.15);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 15px;
      transition: all 0.2s;
    }
    .cluster-card.running {
      border-color: #4ade80;
      background: rgba(74,222,128,0.1);
    }
    .cluster-card.pending {
      border-color: #fbbf24;
      background: rgba(251,191,36,0.1);
    }
    .cluster-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .cluster-name {
      font-size: 1.3rem;
      font-weight: 600;
    }
    .cluster-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.9rem;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(255,255,255,0.3);
    }
    .status-dot.running { background: #4ade80; }
    .status-dot.pending { background: #fbbf24; animation: pulse 1.5s infinite; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .cluster-info {
      color: rgba(255,255,255,0.7);
      font-size: 0.9rem;
      margin-bottom: 12px;
    }
    .countdown {
      font-size: 1.4rem;
      font-weight: 600;
      color: #4ade80;
    }
    .countdown.warning { color: #fbbf24; }
    .countdown.critical { color: #ef4444; }
    .resources {
      display: flex;
      gap: 15px;
      color: rgba(255,255,255,0.6);
      font-size: 0.85rem;
      margin-top: 8px;
    }
    .launch-form {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .form-input {
      flex: 1;
      min-width: 70px;
    }
    .form-input label {
      display: block;
      font-size: 0.75rem;
      color: rgba(255,255,255,0.5);
      margin-bottom: 4px;
    }
    .form-input input {
      width: 100%;
      padding: 8px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 6px;
      background: rgba(255,255,255,0.1);
      color: #fff;
      font-size: 0.9rem;
    }
    .form-input input:focus {
      outline: none;
      border-color: #3b82f6;
    }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      color: #fff;
    }
    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 15px rgba(59,130,246,0.4);
    }
    .btn-success {
      background: #4ade80;
      color: #000;
    }
    .btn-success:hover:not(:disabled) {
      background: #22c55e;
    }
    .btn-danger {
      background: transparent;
      border: 1px solid rgba(239,68,68,0.5);
      color: #fca5a5;
    }
    .btn-danger:hover {
      background: rgba(239,68,68,0.2);
    }
    .btn-group {
      display: flex;
      gap: 10px;
      margin-top: 12px;
    }
    .error {
      background: rgba(239,68,68,0.2);
      border: 1px solid rgba(239,68,68,0.5);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 15px;
      color: #fca5a5;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .loading-content {
      text-align: center;
      color: #fff;
    }
    .loading-content .spinner {
      width: 40px;
      height: 40px;
      margin-bottom: 15px;
    }
    .estimated-start {
      color: rgba(255,255,255,0.6);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="launcher">
    <h1>HPC Code Server</h1>
    <p class="subtitle">VS Code on SLURM compute nodes</p>

    <div id="error" class="error" style="display:none;"></div>

    <div id="gemini-card" class="cluster-card">
      <div class="cluster-header">
        <span class="cluster-name">Gemini</span>
        <div class="cluster-status">
          <span class="status-dot" id="gemini-dot"></span>
          <span id="gemini-status-text">Loading...</span>
        </div>
      </div>
      <div id="gemini-content"></div>
    </div>

    <div id="apollo-card" class="cluster-card">
      <div class="cluster-header">
        <span class="cluster-name">Apollo</span>
        <div class="cluster-status">
          <span class="status-dot" id="apollo-dot"></span>
          <span id="apollo-status-text">Loading...</span>
        </div>
      </div>
      <div id="apollo-content"></div>
    </div>
  </div>

  <div id="loading-overlay" class="loading-overlay" style="display:none;">
    <div class="loading-content">
      <div class="spinner"></div>
      <div id="loading-text">Connecting...</div>
    </div>
  </div>

  <script>
    const defaultConfig = {
      cpus: '${config.defaultCpus}',
      mem: '${config.defaultMem}',
      time: '${config.defaultTime}',
    };

    let clusterStatus = { gemini: null, apollo: null };
    let countdowns = { gemini: null, apollo: null };

    // Format seconds to human readable
    function formatTime(seconds) {
      if (!seconds || seconds <= 0) return '0m';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      if (h > 0) return h + 'h ' + m + 'm';
      return m + 'm';
    }

    // Render idle state with launch form
    function renderIdleContent(hpc) {
      return \`
        <div class="cluster-info">No active session</div>
        <div class="launch-form">
          <div class="form-input">
            <label>CPUs</label>
            <input type="number" id="\${hpc}-cpus" value="\${defaultConfig.cpus}" min="1" max="64">
          </div>
          <div class="form-input">
            <label>Memory</label>
            <input type="text" id="\${hpc}-mem" value="\${defaultConfig.mem}">
          </div>
          <div class="form-input">
            <label>Time</label>
            <input type="text" id="\${hpc}-time" value="\${defaultConfig.time}">
          </div>
        </div>
        <div class="btn-group">
          <button class="btn btn-primary" onclick="launch('\${hpc}')">Launch Session</button>
        </div>
      \`;
    }

    // Render running state with countdown
    function renderRunningContent(hpc, status) {
      const seconds = countdowns[hpc] || status.timeLeftSeconds || 0;
      let countdownClass = 'countdown';
      if (seconds < 600) countdownClass += ' critical';
      else if (seconds < 1800) countdownClass += ' warning';

      return \`
        <div class="cluster-info">Running on \${status.node || 'compute node'}</div>
        <div class="\${countdownClass}" id="\${hpc}-countdown">\${formatTime(seconds)}</div>
        <div class="resources">
          <span>\${status.cpus || '?'} CPUs</span>
          <span>\${status.memory || '?'} RAM</span>
        </div>
        <div class="btn-group">
          <button class="btn btn-success" onclick="connect('\${hpc}')">Connect</button>
          <button class="btn btn-danger" onclick="killJob('\${hpc}')">Kill Job</button>
        </div>
      \`;
    }

    // Render pending state
    function renderPendingContent(hpc, status) {
      let estStart = '';
      if (status.startTime) {
        estStart = '<div class="estimated-start">Est. start: ' + status.startTime + '</div>';
      }
      return \`
        <div class="cluster-info">
          <span class="spinner"></span> Waiting for resources...
        </div>
        \${estStart}
        <div class="btn-group">
          <button class="btn btn-danger" onclick="killJob('\${hpc}')">Cancel</button>
        </div>
      \`;
    }

    // Update a single cluster card
    function updateClusterCard(hpc, status) {
      const card = document.getElementById(hpc + '-card');
      const dot = document.getElementById(hpc + '-dot');
      const statusText = document.getElementById(hpc + '-status-text');
      const content = document.getElementById(hpc + '-content');

      card.className = 'cluster-card';
      dot.className = 'status-dot';

      if (!status || status.status === 'idle') {
        statusText.textContent = 'No session';
        content.innerHTML = renderIdleContent(hpc);
        countdowns[hpc] = null;
      } else if (status.status === 'running') {
        card.classList.add('running');
        dot.classList.add('running');
        statusText.textContent = 'Running';
        // Initialize countdown if not set
        if (!countdowns[hpc] && status.timeLeftSeconds) {
          countdowns[hpc] = status.timeLeftSeconds;
        }
        content.innerHTML = renderRunningContent(hpc, status);
      } else if (status.status === 'pending') {
        card.classList.add('pending');
        dot.classList.add('pending');
        statusText.textContent = 'Pending';
        content.innerHTML = renderPendingContent(hpc, status);
        countdowns[hpc] = null;
      }
    }

    // Fetch status from server
    async function fetchStatus() {
      try {
        const res = await fetch('/api/cluster-status');
        const data = await res.json();
        clusterStatus = data;

        updateClusterCard('gemini', data.gemini);
        updateClusterCard('apollo', data.apollo);
      } catch (e) {
        console.error('Status fetch error:', e);
      }
    }

    // Client-side countdown tick
    function tickCountdowns() {
      ['gemini', 'apollo'].forEach(hpc => {
        if (countdowns[hpc] && countdowns[hpc] > 0) {
          countdowns[hpc]--;
          const el = document.getElementById(hpc + '-countdown');
          if (el) {
            el.textContent = formatTime(countdowns[hpc]);
            // Update warning class
            el.className = 'countdown';
            if (countdowns[hpc] < 600) el.classList.add('critical');
            else if (countdowns[hpc] < 1800) el.classList.add('warning');
          }
        }
      });
    }

    // Launch session
    async function launch(hpc) {
      const overlay = document.getElementById('loading-overlay');
      const loadingText = document.getElementById('loading-text');
      const errorEl = document.getElementById('error');

      errorEl.style.display = 'none';
      overlay.style.display = 'flex';
      loadingText.textContent = 'Submitting job to ' + hpc + '...';

      try {
        const cpus = document.getElementById(hpc + '-cpus').value;
        const mem = document.getElementById(hpc + '-mem').value;
        const time = document.getElementById(hpc + '-time').value;

        const res = await fetch('/api/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hpc, cpus, mem, time })
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Launch failed');
        }

        window.location.href = '/code/';
      } catch (e) {
        overlay.style.display = 'none';
        errorEl.textContent = e.message;
        errorEl.style.display = 'block';
      }
    }

    // Connect to existing session
    async function connect(hpc) {
      const overlay = document.getElementById('loading-overlay');
      overlay.style.display = 'flex';
      document.getElementById('loading-text').textContent = 'Connecting to ' + hpc + '...';

      try {
        // Launch will reconnect to existing job
        const res = await fetch('/api/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hpc })
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Connect failed');
        }

        window.location.href = '/code/';
      } catch (e) {
        overlay.style.display = 'none';
        document.getElementById('error').textContent = e.message;
        document.getElementById('error').style.display = 'block';
      }
    }

    // Kill job
    async function killJob(hpc) {
      if (!confirm('Kill the ' + hpc + ' job?')) return;

      try {
        await fetch('/api/stop/' + hpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cancelJob: true })
        });
        fetchStatus();
      } catch (e) {
        console.error('Kill error:', e);
      }
    }

    // Initialize
    fetchStatus();
    setInterval(fetchStatus, 30000);  // Sync with server every 30s
    setInterval(tickCountdowns, 1000); // Client-side countdown every second
  </script>
</body>
</html>`;
}

// Floating menu - use iframe to isolate from VS Code's event handling
function renderFloatingMenu() {
  return `
    <iframe id="hpc-menu-frame" src="/hpc-menu-frame" style="
      position: fixed !important;
      top: 10px !important;
      right: 10px !important;
      width: 320px !important;
      height: 400px !important;
      border: none !important;
      z-index: 2147483647 !important;
      pointer-events: auto !important;
      background: transparent !important;
    "></iframe>
  `;
}

// External menu script (bypasses CSP inline restrictions)
function getMenuScript() {
  return `
(function() {
  // Wait for DOM to be ready
  setTimeout(function initHpcMenu() {
    const overlay = document.getElementById('hpc-menu-overlay');
    const toggle = document.getElementById('hpc-menu-toggle');
    const panel = document.getElementById('hpc-menu-panel');

    if (!overlay || !toggle || !panel) {
      setTimeout(initHpcMenu, 500);
      return;
    }

    // DEBUG: Visual indicator that JS loaded
    toggle.textContent = '✓';
    toggle.style.fontSize = '24px';

    let menuOpen = false;

    function handleInteraction(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      menuOpen = !menuOpen;
      panel.classList.toggle('open', menuOpen);
      toggle.style.background = menuOpen ? 'rgba(74,222,128,0.8)' : 'rgba(30,30,40,0.95)';
    }

    toggle.addEventListener('click', handleInteraction, true);
    toggle.addEventListener('touchend', handleInteraction, true);
    toggle.addEventListener('pointerup', handleInteraction, true);

    document.addEventListener('click', function(e) {
      if (menuOpen && !overlay.contains(e.target)) {
        menuOpen = false;
        panel.classList.remove('open');
        toggle.style.background = 'rgba(30,30,40,0.95)';
      }
    }, true);

    window.hpcMenuState = { menuOpen: false, sessions: {}, activeHpc: null };
  }, 100);
})();

let sessions = {};
let activeHpc = null;

async function updateMenu() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    sessions = data.sessions || {};
    activeHpc = data.activeHpc;

    const container = document.getElementById('sessions-container');
    if (!container) return;
    container.innerHTML = '';

    let hasRunning = false;

    for (const [hpc, session] of Object.entries(sessions)) {
      if (session && (session.status === 'running' || session.status === 'starting')) {
        hasRunning = true;
        const isActive = hpc === activeHpc;

        const card = document.createElement('div');
        card.className = 'session-card' + (isActive ? ' active' : '');
        card.innerHTML = '<div class="session-header"><div class="session-name"><span class="dot"></span>' +
          hpc.charAt(0).toUpperCase() + hpc.slice(1) +
          '</div><div class="session-node">' + (session.node || 'pending...') + '</div></div>' +
          '<div class="session-stats">' +
          '<div class="stat">⏱️ <span class="stat-value">' + (session.remainingTime || session.walltime || '--') + '</span></div>' +
          '<div class="stat">🖥️ <span class="stat-value">' + (session.cpus || '--') + ' cores</span></div>' +
          '<div class="stat">🧠 <span class="stat-value">' + (session.memory || '--') + '</span></div></div>' +
          '<div class="session-actions">' +
          (!isActive ? '<button onclick="switchSession(\\'' + hpc + '\\')">Switch</button>' : '') +
          '<button onclick="stopSession(\\'' + hpc + '\\', false)">Disconnect</button>' +
          '<button class="danger" onclick="stopSession(\\'' + hpc + '\\', true)">Kill Job</button></div>';
        container.appendChild(card);
      }
    }

    const toggle = document.getElementById('hpc-menu-toggle');
    if (toggle) toggle.className = hasRunning ? 'running' : '';

    if (!hasRunning) {
      window.location.href = '/';
    }
  } catch (e) {
    console.error('Menu update error:', e);
  }
}

async function switchSession(hpc) {
  await fetch('/api/switch/' + hpc, { method: 'POST' });
  window.location.reload();
}

async function stopSession(hpc, cancelJob) {
  if (cancelJob && !confirm('Cancel SLURM job on ' + hpc + '?')) return;
  await fetch('/api/stop/' + hpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancelJob })
  });
  updateMenu();
}

updateMenu();
setInterval(updateMenu, 30000);
`;
}

// Serve menu JavaScript as external file (bypasses CSP)
app.get('/hpc-menu.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(getMenuScript());
});

// Serve the menu iframe content
app.get('/hpc-menu-frame', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: transparent;
      overflow: hidden;
    }
    #toggle {
      width: 44px;
      height: 44px;
      border-radius: 10px;
      background: rgba(30,30,40,0.95);
      border: 2px solid #4ade80;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      position: absolute;
      top: 0;
      right: 0;
    }
    #toggle:hover { transform: scale(1.05); }
    #toggle.open { background: rgba(74,222,128,0.8); }
    #toggle.warning { border-color: #fbbf24; }
    #toggle.critical { border-color: #ef4444; animation: pulse 1s infinite; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    #panel {
      display: none;
      position: absolute;
      top: 50px;
      right: 0;
      width: 220px;
      background: rgba(30,30,40,0.98);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 12px;
      padding: 15px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      color: #fff;
    }
    #panel.open { display: block; }
    .cluster-name {
      font-weight: 600;
      font-size: 1.1rem;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cluster-name .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4ade80;
    }
    .countdown {
      font-size: 1.5rem;
      font-weight: 700;
      color: #4ade80;
      margin-bottom: 6px;
    }
    .countdown.warning { color: #fbbf24; }
    .countdown.critical { color: #ef4444; }
    .resources {
      font-size: 0.85rem;
      color: rgba(255,255,255,0.6);
      margin-bottom: 12px;
    }
    .node {
      font-size: 0.8rem;
      color: rgba(255,255,255,0.5);
      margin-bottom: 12px;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .actions button {
      width: 100%;
      padding: 10px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .actions button:hover { background: rgba(255,255,255,0.1); }
    .actions button.danger {
      border-color: rgba(239,68,68,0.5);
      color: #fca5a5;
    }
    .actions button.danger:hover { background: rgba(239,68,68,0.2); }
  </style>
</head>
<body>
  <button id="toggle">✓</button>
  <div id="panel">
    <div id="content">Loading...</div>
  </div>

  <script>
    const toggle = document.getElementById('toggle');
    const panel = document.getElementById('panel');
    let open = false;
    let countdown = null;
    let activeHpc = null;

    toggle.addEventListener('click', () => {
      open = !open;
      toggle.classList.toggle('open', open);
      panel.classList.toggle('open', open);
    });

    function formatTime(seconds) {
      if (!seconds || seconds <= 0) return '0m';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      if (h > 0) return h + 'h ' + m + 'm';
      return m + 'm';
    }

    function render() {
      const content = document.getElementById('content');
      if (!activeHpc) {
        content.innerHTML = '<div style="color:rgba(255,255,255,0.5)">No active session</div>';
        return;
      }

      let countdownClass = 'countdown';
      if (countdown < 600) countdownClass += ' critical';
      else if (countdown < 1800) countdownClass += ' warning';

      // Update toggle button appearance
      toggle.className = '';
      if (countdown < 600) toggle.classList.add('critical');
      else if (countdown < 1800) toggle.classList.add('warning');
      if (open) toggle.classList.add('open');

      content.innerHTML =
        '<div class="cluster-name"><span class="dot"></span>' + activeHpc.charAt(0).toUpperCase() + activeHpc.slice(1) + '</div>' +
        '<div class="' + countdownClass + '" id="countdown">' + formatTime(countdown) + '</div>' +
        '<div class="resources" id="resources"></div>' +
        '<div class="node" id="node"></div>' +
        '<div class="actions">' +
        '<button onclick="parent.location.href=\\'/\\'">← Main Menu</button>' +
        '<button class="danger" onclick="killJob()">Kill Job</button>' +
        '</div>';
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/cluster-status');
        const data = await res.json();
        activeHpc = data.activeHpc;

        if (activeHpc && data[activeHpc] && data[activeHpc].status === 'running') {
          const status = data[activeHpc];
          // Only update countdown from server if not already set (to avoid jumps)
          if (countdown === null && status.timeLeftSeconds) {
            countdown = status.timeLeftSeconds;
          }
          render();
          // Update resources and node
          const resourcesEl = document.getElementById('resources');
          const nodeEl = document.getElementById('node');
          if (resourcesEl) resourcesEl.textContent = (status.cpus || '?') + ' CPUs • ' + (status.memory || '?');
          if (nodeEl) nodeEl.textContent = status.node || '';
        } else {
          countdown = null;
          render();
        }
      } catch(e) {
        console.error('Status error:', e);
      }
    }

    function tickCountdown() {
      if (countdown !== null && countdown > 0) {
        countdown--;
        const el = document.getElementById('countdown');
        if (el) {
          el.textContent = formatTime(countdown);
          el.className = 'countdown';
          if (countdown < 600) el.classList.add('critical');
          else if (countdown < 1800) el.classList.add('warning');
        }
        // Update toggle button
        toggle.className = open ? 'open' : '';
        if (countdown < 600) toggle.classList.add('critical');
        else if (countdown < 1800) toggle.classList.add('warning');
      }
    }

    async function killJob() {
      if (!activeHpc || !confirm('Kill the ' + activeHpc + ' job?')) return;
      await fetch('/api/stop/' + activeHpc, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({cancelJob: true})
      });
      parent.location.href = '/';
    }

    fetchStatus();
    setInterval(fetchStatus, 60000);  // Sync every 60s
    setInterval(tickCountdown, 1000); // Tick every second
  </script>
</body>
</html>`);
});

// Landing page / UI
app.get('/', (req, res) => {
  // If there's an active running session, redirect to code
  if (hasRunningSession()) {
    return res.redirect('/code/');
  }

  res.send(renderLauncherPage());
});

// Proxy VS Code asset paths directly (stable-xxx, vscode-xxx, etc.)
app.use((req, res, next) => {
  // Match paths starting with /stable-, /vscode-, /oss-dev
  if (req.path.match(/^\/(stable-|vscode-|oss-dev)/)) {
    console.log(`Asset path: ${req.path}`);
    if (!hasRunningSession()) {
      return res.redirect('/');
    }
    return proxy.web(req, res);
  }
  next();
});

// Proxy /code/* to code-server when running, with floating menu
app.use('/code', (req, res, next) => {
  if (!hasRunningSession()) {
    return res.redirect('/');
  }

  // For the main /code/ request, inject floating menu
  if (req.path === '/' || req.path === '') {
    // Modify the response to inject our floating menu
    const originalWrite = res.write;
    const originalEnd = res.end;
    let body = [];

    res.write = function(chunk) {
      body.push(chunk);
      return true;
    };

    res.end = function(chunk) {
      // If headers already sent (e.g., proxy error), just call original end
      if (res.headersSent) {
        return originalEnd.call(res, chunk);
      }

      if (chunk) body.push(chunk);

      let html = Buffer.concat(body.map(b => Buffer.isBuffer(b) ? b : Buffer.from(b))).toString('utf8');

      // Inject floating menu before </body>
      if (html.includes('</body>')) {
        html = html.replace('</body>', renderFloatingMenu() + '</body>');
      }

      if (!res.headersSent) {
        res.setHeader('Content-Length', Buffer.byteLength(html));
      }
      originalWrite.call(res, html);
      originalEnd.call(res);
    };
  }

  proxy.web(req, res);
});

// Start server
const PORT = 3000;
const server = app.listen(PORT, () => {
  console.log(`HPC Code Server Manager listening on port ${PORT}`);
  console.log(`Default HPC: ${config.defaultHpc}`);
});

// Handle WebSocket upgrades for code-server
server.on('upgrade', (req, socket, head) => {
  console.log(`WebSocket upgrade request: url=${req.url} headers=${JSON.stringify(req.headers)}`);

  if (hasRunningSession()) {
    // Proxy WebSocket for /code, /stable-, /vscode-, /oss-dev, or root paths
    if (req.url.startsWith('/code') ||
        req.url.startsWith('/stable-') ||
        req.url.startsWith('/vscode-') ||
        req.url.startsWith('/oss-dev') ||
        req.url === '/' ||
        req.url.startsWith('/?')) {
      console.log(`WebSocket proxying: ${req.url}`);
      proxy.ws(req, socket, head);
    } else {
      console.log(`WebSocket rejected (no match): ${req.url}`);
      socket.destroy();
    }
  } else {
    console.log(`WebSocket rejected (no session): ${req.url}`);
    socket.destroy();
  }
});
