const express = require('express');
const { spawn, exec } = require('child_process');
const httpProxy = require('http-proxy');

const app = express();
app.use(express.json());

// Configuration from environment
const config = {
  hpcUser: process.env.HPC_SSH_USER || 'domeally',
  geminiHost: process.env.GEMINI_SSH_HOST || 'gemini-login2.coh.org',
  apolloHost: process.env.APOLLO_SSH_HOST || 'ppxhpcacc01.coh.org',
  defaultHpc: process.env.DEFAULT_HPC || 'gemini',
  codeServerPort: parseInt(process.env.CODE_SERVER_PORT) || 8000,
  defaultCpus: process.env.DEFAULT_CPUS || '4',
  defaultMem: process.env.DEFAULT_MEM || '40G',
  defaultTime: process.env.DEFAULT_TIME || '12:00:00',
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
  if (res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>Code server not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Helper: run SSH command
function sshExec(hpc, command) {
  const host = hpc === 'apollo' ? config.apolloHost : config.geminiHost;
  return new Promise((resolve, reject) => {
    exec(`ssh -o StrictHostKeyChecking=no ${config.hpcUser}@${host} "${command}"`,
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout.trim());
      }
    );
  });
}

// Helper: get job info
async function getJobInfo(hpc) {
  try {
    const output = await sshExec(hpc,
      `squeue --user=${config.hpcUser} --name=code-server --states=R,PD -h -O JobID,State,NodeList 2>/dev/null | head -1`
    );
    if (!output) return null;

    const [jobId, jobState, node] = output.split(/\s+/);
    return { jobId, state: jobState, node: node === '(null)' ? null : node };
  } catch (e) {
    return null;
  }
}

// Helper: start SSH tunnel
function startTunnel(hpc, node) {
  const host = hpc === 'apollo' ? config.apolloHost : config.geminiHost;
  const port = config.codeServerPort;

  console.log(`Starting tunnel: localhost:${port} -> ${node}:${port} via ${host}`);

  const tunnel = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-N',
    '-L', `${port}:${node}:${port}`,
    `${config.hpcUser}@${host}`
  ]);

  tunnel.on('error', (err) => {
    console.error('Tunnel error:', err);
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

  return tunnel;
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

      const submitCmd = `sbatch --job-name=code-server --nodes=1 --cpus-per-task=${cpus} --mem=${mem} --partition=compute --time=${time} --output=$HOME/code-server_%j.log --error=$HOME/code-server_%j.err --wrap='
        if [[ -d "/packages/singularity" ]]; then
          SINGULARITY_BIN=/packages/easy-build/software/singularity/3.7.0/bin/singularity
          SINGULARITY_IMAGE=/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.19.sif
          R_LIBS_SITE=/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.19
          BIND_PATHS=/packages,/run,/scratch,/ref_genomes
        else
          SINGULARITY_BIN=/opt/singularity-images/singularity/bin/singularity
          SINGULARITY_IMAGE=/opt/singularity-images/rbioc/rbioc_3.18.sif
          R_LIBS_SITE=/opt/singularity-images/rbioc/rlibs/bioc-3.18
          BIND_PATHS=/opt,/labs,/run,/ref_genome
        fi
        $SINGULARITY_BIN exec --env TERM=xterm-256color --env R_LIBS_SITE=$R_LIBS_SITE -B $BIND_PATHS $SINGULARITY_IMAGE code serve-web --host 0.0.0.0 --port ${config.codeServerPort} --without-connection-token --accept-server-license-terms --server-data-dir $HOME/.vscode-slurm/.vscode-server --extensions-dir $HOME/.vscode-slurm/.vscode-server/extensions
      '`;

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

    // Start tunnel
    session.tunnelProcess = startTunnel(hpc, session.node);
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
    res.status(500).json({ error: error.message });
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
  if (!session.tunnelProcess) {
    session.tunnelProcess = startTunnel(hpc, session.node);
  }

  state.activeHpc = hpc;

  res.json({ status: 'switched', hpc });
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
    }
    .launcher {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 40px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 {
      font-size: 2rem;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .subtitle {
      color: rgba(255,255,255,0.6);
      margin-bottom: 30px;
    }
    .hpc-selector {
      display: flex;
      gap: 10px;
      margin-bottom: 25px;
    }
    .hpc-btn {
      flex: 1;
      padding: 20px;
      border: 2px solid rgba(255,255,255,0.2);
      border-radius: 12px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
    }
    .hpc-btn:hover {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.3);
    }
    .hpc-btn.selected {
      background: rgba(59,130,246,0.3);
      border-color: #3b82f6;
    }
    .hpc-btn .name {
      font-size: 1.2rem;
      font-weight: 600;
    }
    .hpc-btn .status {
      font-size: 0.8rem;
      color: rgba(255,255,255,0.5);
      margin-top: 5px;
    }
    .hpc-btn .status.running {
      color: #4ade80;
    }
    .form-row {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
    }
    .form-group {
      flex: 1;
    }
    label {
      display: block;
      font-size: 0.85rem;
      color: rgba(255,255,255,0.7);
      margin-bottom: 5px;
    }
    input, select {
      width: 100%;
      padding: 12px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.1);
      color: #fff;
      font-size: 1rem;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #3b82f6;
    }
    .launch-btn {
      width: 100%;
      padding: 16px;
      border: none;
      border-radius: 12px;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      color: #fff;
      font-size: 1.1rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      margin-top: 10px;
    }
    .launch-btn:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(59,130,246,0.4);
    }
    .launch-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .error {
      background: rgba(239,68,68,0.2);
      border: 1px solid rgba(239,68,68,0.5);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 15px;
      color: #fca5a5;
    }
    .status-msg {
      text-align: center;
      padding: 20px;
      color: rgba(255,255,255,0.8);
    }
    .spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s linear infinite;
      margin-right: 10px;
      vertical-align: middle;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="launcher">
    <h1>🖥️ HPC Code Server</h1>
    <p class="subtitle">Launch VS Code on SLURM compute nodes</p>

    <div id="error" class="error" style="display:none;"></div>

    <div id="launcher-form">
      <div class="hpc-selector">
        <button type="button" class="hpc-btn selected" data-hpc="gemini" onclick="selectHpc('gemini')">
          <div class="name">Gemini</div>
          <div class="status" id="gemini-status">Idle</div>
        </button>
        <button type="button" class="hpc-btn" data-hpc="apollo" onclick="selectHpc('apollo')">
          <div class="name">Apollo</div>
          <div class="status" id="apollo-status">Idle</div>
        </button>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>🖥️ CPUs</label>
          <input type="number" id="cpus" value="${config.defaultCpus}" min="1" max="64">
        </div>
        <div class="form-group">
          <label>🧠 Memory</label>
          <input type="text" id="mem" value="${config.defaultMem}" placeholder="e.g., 40G">
        </div>
        <div class="form-group">
          <label>⏱️ Time</label>
          <input type="text" id="time" value="${config.defaultTime}" placeholder="HH:MM:SS">
        </div>
      </div>

      <button id="launchBtn" class="launch-btn" onclick="launch()">🚀 Launch Session</button>
    </div>

    <div id="status-msg" class="status-msg" style="display:none;">
      <span class="spinner"></span>
      <span id="status-text">Starting...</span>
    </div>
  </div>

  <script>
    let selectedHpc = '${config.defaultHpc}';
    let sessions = {};

    function selectHpc(hpc) {
      selectedHpc = hpc;
      document.querySelectorAll('.hpc-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.hpc === hpc);
      });
    }

    async function updateStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        sessions = data.sessions || {};

        // Update HPC status indicators
        for (const [hpc, session] of Object.entries(sessions)) {
          const el = document.getElementById(hpc + '-status');
          if (el) {
            if (session.status === 'running') {
              el.textContent = 'Running on ' + session.node;
              el.className = 'status running';
            } else if (session.status === 'starting') {
              el.textContent = 'Starting...';
              el.className = 'status';
            } else {
              el.textContent = 'Idle';
              el.className = 'status';
            }
          }
        }

        // If any session is running, redirect to /code/
        if (Object.values(sessions).some(s => s && s.status === 'running')) {
          window.location.href = '/code/';
        }
      } catch (e) {
        console.error('Status error:', e);
      }
    }

    async function launch() {
      const btn = document.getElementById('launchBtn');
      const form = document.getElementById('launcher-form');
      const statusMsg = document.getElementById('status-msg');
      const statusText = document.getElementById('status-text');
      const errorEl = document.getElementById('error');

      btn.disabled = true;
      errorEl.style.display = 'none';

      try {
        statusText.textContent = 'Submitting job to ' + selectedHpc + '...';
        statusMsg.style.display = 'block';

        const res = await fetch('/api/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hpc: selectedHpc,
            cpus: document.getElementById('cpus').value,
            mem: document.getElementById('mem').value,
            time: document.getElementById('time').value,
          })
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Launch failed');
        }

        // Redirect to code server
        window.location.href = '/code/';

      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = 'block';
        statusMsg.style.display = 'none';
        btn.disabled = false;
      }
    }

    // Initial status check
    updateStatus();
    setInterval(updateStatus, 5000);
  </script>
</body>
</html>`;
}

// Floating menu overlay for code-server
function renderFloatingMenu() {
  return `
    <div id="hpc-menu-overlay">
      <style>
        #hpc-menu-overlay {
          position: fixed;
          top: 10px;
          right: 10px;
          z-index: 999999;
          font-family: system-ui, -apple-system, sans-serif;
        }
        #hpc-menu-toggle {
          width: 44px;
          height: 44px;
          border-radius: 10px;
          background: rgba(30,30,40,0.95);
          border: 1px solid rgba(255,255,255,0.1);
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          transition: transform 0.2s;
        }
        #hpc-menu-toggle:hover {
          transform: scale(1.05);
        }
        #hpc-menu-toggle.running { border-color: #4ade80; }
        #hpc-menu-toggle.starting { border-color: #fbbf24; }

        #hpc-menu-panel {
          display: none;
          position: absolute;
          top: 50px;
          right: 0;
          background: rgba(30,30,40,0.98);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          padding: 15px;
          min-width: 260px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.4);
          color: #fff;
        }
        #hpc-menu-panel.open { display: block; }

        .session-card {
          background: rgba(255,255,255,0.05);
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 10px;
        }
        .session-card.active {
          border: 1px solid #3b82f6;
          background: rgba(59,130,246,0.1);
        }
        .session-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .session-name {
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .session-name .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #4ade80;
        }
        .session-node {
          font-size: 0.8rem;
          color: rgba(255,255,255,0.5);
        }
        .session-stats {
          display: flex;
          gap: 12px;
          font-size: 0.9rem;
          margin-bottom: 10px;
        }
        .stat {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .stat-value {
          color: rgba(255,255,255,0.8);
        }
        .session-actions {
          display: flex;
          gap: 6px;
        }
        .session-actions button {
          flex: 1;
          padding: 8px;
          border: 1px solid rgba(255,255,255,0.2);
          border-radius: 6px;
          background: rgba(255,255,255,0.05);
          color: #fff;
          cursor: pointer;
          font-size: 0.85rem;
          transition: background 0.2s;
        }
        .session-actions button:hover {
          background: rgba(255,255,255,0.1);
        }
        .session-actions button.danger:hover {
          background: rgba(239,68,68,0.3);
          border-color: rgba(239,68,68,0.5);
        }

        .menu-footer {
          border-top: 1px solid rgba(255,255,255,0.1);
          padding-top: 10px;
          margin-top: 5px;
        }
        .menu-footer button {
          width: 100%;
          padding: 10px;
          border: 1px solid rgba(255,255,255,0.2);
          border-radius: 8px;
          background: rgba(255,255,255,0.05);
          color: #fff;
          cursor: pointer;
          font-size: 0.9rem;
        }
        .menu-footer button:hover {
          background: rgba(255,255,255,0.1);
        }
      </style>

      <button id="hpc-menu-toggle" class="running" onclick="toggleMenu()">🖥️</button>

      <div id="hpc-menu-panel">
        <div id="sessions-container"></div>
        <div class="menu-footer">
          <button onclick="window.location.href='/'">➕ New Session</button>
        </div>
      </div>
    </div>

    <script>
      let menuOpen = false;
      let activeHpc = null;
      let sessions = {};

      function toggleMenu() {
        menuOpen = !menuOpen;
        document.getElementById('hpc-menu-panel').classList.toggle('open', menuOpen);
      }

      // Close menu when clicking outside
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#hpc-menu-overlay')) {
          menuOpen = false;
          document.getElementById('hpc-menu-panel').classList.remove('open');
        }
      });

      async function updateMenu() {
        try {
          const res = await fetch('/api/status');
          const data = await res.json();
          sessions = data.sessions || {};
          activeHpc = data.activeHpc;

          const container = document.getElementById('sessions-container');
          container.innerHTML = '';

          let hasRunning = false;

          for (const [hpc, session] of Object.entries(sessions)) {
            if (session && (session.status === 'running' || session.status === 'starting')) {
              hasRunning = true;
              const isActive = hpc === activeHpc;

              const card = document.createElement('div');
              card.className = 'session-card' + (isActive ? ' active' : '');
              card.innerHTML = \`
                <div class="session-header">
                  <div class="session-name">
                    <span class="dot"></span>
                    \${hpc.charAt(0).toUpperCase() + hpc.slice(1)}
                  </div>
                  <div class="session-node">\${session.node || 'pending...'}</div>
                </div>
                <div class="session-stats">
                  <div class="stat">⏱️ <span class="stat-value">\${session.remainingTime || session.walltime || '--'}</span></div>
                  <div class="stat">🖥️ <span class="stat-value">\${session.cpus || '--'} cores</span></div>
                  <div class="stat">🧠 <span class="stat-value">\${session.memory || '--'}</span></div>
                </div>
                <div class="session-actions">
                  \${!isActive ? '<button onclick="switchSession(\\'' + hpc + '\\')">Switch</button>' : ''}
                  <button onclick="stopSession(\\'\${hpc}\\', false)">Disconnect</button>
                  <button class="danger" onclick="stopSession(\\'\${hpc}\\', true)">Kill Job</button>
                </div>
              \`;
              container.appendChild(card);
            }
          }

          // Update toggle button status
          const toggle = document.getElementById('hpc-menu-toggle');
          toggle.className = hasRunning ? 'running' : '';

          // If no running sessions, redirect to launcher
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

      // Poll for updates
      updateMenu();
      setInterval(updateMenu, 30000); // Update every 30 seconds
    </script>
  `;
}

// Landing page / UI
app.get('/', (req, res) => {
  // If there's an active running session, redirect to code
  if (hasRunningSession()) {
    return res.redirect('/code/');
  }

  res.send(renderLauncherPage());
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
      if (chunk) body.push(chunk);

      let html = Buffer.concat(body.map(b => Buffer.isBuffer(b) ? b : Buffer.from(b))).toString('utf8');

      // Inject floating menu before </body>
      if (html.includes('</body>')) {
        html = html.replace('</body>', renderFloatingMenu() + '</body>');
      }

      res.setHeader('Content-Length', Buffer.byteLength(html));
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
  if (hasRunningSession() && req.url.startsWith('/code')) {
    proxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});
