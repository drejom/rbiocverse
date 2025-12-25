const express = require('express');
const { spawn, exec } = require('child_process');
const httpProxy = require('http-proxy');

const app = express();
app.use(express.json());

// Configuration from environment
const config = {
  hpcUser: process.env.HPC_SSH_USER || 'domeally',
  geminiHost: process.env.GEMINI_SSH_HOST || 'gemini-login1',
  apolloHost: process.env.APOLLO_SSH_HOST || 'apollo.coh.org',
  defaultHpc: process.env.DEFAULT_HPC || 'gemini',
  codeServerPort: parseInt(process.env.CODE_SERVER_PORT) || 8000,
  defaultCpus: process.env.DEFAULT_CPUS || '4',
  defaultMem: process.env.DEFAULT_MEM || '40G',
  defaultTime: process.env.DEFAULT_TIME || '12:00:00',
};

// State
let state = {
  status: 'idle', // idle, starting, running, stopping
  jobId: null,
  node: null,
  hpc: null,
  tunnelProcess: null,
  startedAt: null,
  error: null,
};

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
    state.status = 'idle';
    state.tunnelProcess = null;
  });

  tunnel.on('exit', (code) => {
    console.log(`Tunnel exited with code ${code}`);
    if (state.status === 'running') {
      state.status = 'idle';
    }
    state.tunnelProcess = null;
  });

  return tunnel;
}

// Helper: stop tunnel
function stopTunnel() {
  if (state.tunnelProcess) {
    state.tunnelProcess.kill();
    state.tunnelProcess = null;
  }
}

// API Routes

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/status', async (req, res) => {
  // Check actual job status if we think we're running
  if (state.status === 'running' && state.jobId) {
    const jobInfo = await getJobInfo(state.hpc);
    if (!jobInfo || jobInfo.jobId !== state.jobId) {
      // Job disappeared
      stopTunnel();
      state = { ...state, status: 'idle', jobId: null, node: null };
    }
  }

  res.json({
    status: state.status,
    jobId: state.jobId,
    node: state.node,
    hpc: state.hpc,
    startedAt: state.startedAt,
    error: state.error,
    config: {
      defaultHpc: config.defaultHpc,
      defaultCpus: config.defaultCpus,
      defaultMem: config.defaultMem,
      defaultTime: config.defaultTime,
    }
  });
});

app.post('/api/launch', async (req, res) => {
  if (state.status !== 'idle') {
    return res.status(400).json({ error: 'Already running or starting' });
  }

  const { hpc = config.defaultHpc, cpus = config.defaultCpus, mem = config.defaultMem, time = config.defaultTime } = req.body;

  state.status = 'starting';
  state.hpc = hpc;
  state.error = null;

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
        $SINGULARITY_BIN exec --env TERM=xterm-256color --env R_LIBS_SITE=$R_LIBS_SITE -B $BIND_PATHS $SINGULARITY_IMAGE code serve-web --host 0.0.0.0 --port ${config.codeServerPort} --without-connection-token --accept-server-license-terms --server-data-dir $HOME/.vscode-server --extensions-dir $HOME/.vscode-server/extensions
      '`;

      const output = await sshExec(hpc, submitCmd);
      const match = output.match(/Submitted batch job (\d+)/);
      if (!match) throw new Error('Failed to parse job ID from: ' + output);

      state.jobId = match[1];
      console.log(`Submitted job ${state.jobId}`);
    } else {
      state.jobId = jobInfo.jobId;
      console.log(`Found existing job ${state.jobId}`);
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
        state.node = jobInfo.node;
        break;
      }

      await new Promise(r => setTimeout(r, 5000));
      attempts++;
    }

    if (!state.node) {
      throw new Error('Timeout waiting for node assignment');
    }

    console.log(`Job running on ${state.node}`);

    // Wait a moment for code-server to start
    await new Promise(r => setTimeout(r, 5000));

    // Start tunnel
    state.tunnelProcess = startTunnel(hpc, state.node);
    state.status = 'running';
    state.startedAt = new Date().toISOString();

    res.json({
      status: 'running',
      jobId: state.jobId,
      node: state.node,
    });

  } catch (error) {
    console.error('Launch error:', error);
    state.status = 'idle';
    state.error = error.message;
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop', async (req, res) => {
  const { cancelJob = false } = req.body;

  stopTunnel();

  if (cancelJob && state.jobId && state.hpc) {
    try {
      await sshExec(state.hpc, `scancel ${state.jobId}`);
      console.log(`Cancelled job ${state.jobId}`);
    } catch (e) {
      console.error('Failed to cancel job:', e);
    }
  }

  state = {
    status: 'idle',
    jobId: null,
    node: null,
    hpc: null,
    tunnelProcess: null,
    startedAt: null,
    error: null,
  };

  res.json({ status: 'stopped' });
});

// Landing page / UI
app.get('/', (req, res) => {
  if (state.status === 'running') {
    // Redirect to code-server or proxy
    return res.redirect('/code/');
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>HPC Code Server</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    .status { padding: 10px; border-radius: 4px; margin: 20px 0; }
    .status.idle { background: #f0f0f0; }
    .status.starting { background: #fff3cd; }
    .status.running { background: #d4edda; }
    button { padding: 10px 20px; font-size: 16px; cursor: pointer; margin: 5px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    select, input { padding: 8px; margin: 5px; }
    .form-group { margin: 10px 0; }
    label { display: inline-block; width: 80px; }
    .error { color: red; margin: 10px 0; }
  </style>
</head>
<body>
  <h1>🖥️ HPC Code Server</h1>

  <div id="status" class="status idle">
    Checking status...
  </div>

  <div id="error" class="error" style="display:none;"></div>

  <div id="controls">
    <div class="form-group">
      <label>HPC:</label>
      <select id="hpc">
        <option value="gemini">Gemini</option>
        <option value="apollo">Apollo</option>
      </select>
    </div>
    <div class="form-group">
      <label>CPUs:</label>
      <input type="number" id="cpus" value="4" min="1" max="32">
    </div>
    <div class="form-group">
      <label>Memory:</label>
      <input type="text" id="mem" value="40G">
    </div>
    <div class="form-group">
      <label>Time:</label>
      <input type="text" id="time" value="12:00:00">
    </div>

    <button id="launchBtn" onclick="launch()">🚀 Launch</button>
    <button id="stopBtn" onclick="stop(false)" style="display:none;">⏹️ Disconnect</button>
    <button id="killBtn" onclick="stop(true)" style="display:none;">🗑️ Stop Job</button>
  </div>

  <script>
    async function updateStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        const statusEl = document.getElementById('status');
        const launchBtn = document.getElementById('launchBtn');
        const stopBtn = document.getElementById('stopBtn');
        const killBtn = document.getElementById('killBtn');
        const errorEl = document.getElementById('error');

        statusEl.className = 'status ' + data.status;

        if (data.status === 'idle') {
          statusEl.textContent = 'No active session';
          launchBtn.style.display = 'inline';
          launchBtn.disabled = false;
          stopBtn.style.display = 'none';
          killBtn.style.display = 'none';
        } else if (data.status === 'starting') {
          statusEl.textContent = 'Starting... (this may take a few minutes)';
          launchBtn.style.display = 'inline';
          launchBtn.disabled = true;
          stopBtn.style.display = 'none';
          killBtn.style.display = 'none';
        } else if (data.status === 'running') {
          statusEl.innerHTML = 'Running on <strong>' + data.node + '</strong> (' + data.hpc + ')<br>' +
            '<a href="/code/" target="_blank">Open VS Code →</a>';
          launchBtn.style.display = 'none';
          stopBtn.style.display = 'inline';
          killBtn.style.display = 'inline';
        }

        if (data.error) {
          errorEl.textContent = data.error;
          errorEl.style.display = 'block';
        } else {
          errorEl.style.display = 'none';
        }

        // Set defaults
        document.getElementById('hpc').value = data.config.defaultHpc;
        document.getElementById('cpus').value = parseInt(data.config.defaultCpus);
        document.getElementById('mem').value = data.config.defaultMem;
        document.getElementById('time').value = data.config.defaultTime;

      } catch (e) {
        console.error('Status error:', e);
      }
    }

    async function launch() {
      document.getElementById('launchBtn').disabled = true;
      document.getElementById('error').style.display = 'none';

      try {
        const res = await fetch('/api/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hpc: document.getElementById('hpc').value,
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
        setTimeout(() => { window.location.href = '/code/'; }, 1000);

      } catch (e) {
        document.getElementById('error').textContent = e.message;
        document.getElementById('error').style.display = 'block';
        document.getElementById('launchBtn').disabled = false;
      }
    }

    async function stop(cancelJob) {
      if (cancelJob && !confirm('This will cancel the SLURM job. Continue?')) return;

      await fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelJob })
      });

      updateStatus();
    }

    // Poll status
    updateStatus();
    setInterval(updateStatus, 10000);
  </script>
</body>
</html>`);
});

// Proxy /code/* to code-server when running
app.use('/code', (req, res, next) => {
  if (state.status !== 'running') {
    return res.redirect('/');
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
  if (state.status === 'running' && req.url.startsWith('/code')) {
    proxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});
