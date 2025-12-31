/**
 * HPC Code Server - Launcher Page JavaScript
 * Handles cluster status display, launch form, and session management
 */

// Default configuration - will be overwritten by server config
let defaultConfig = {
  cpus: '2',
  mem: '40G',
  time: '12:00:00',
};

let clusterStatus = { gemini: null, apollo: null };
let countdowns = { gemini: null, apollo: null };

/**
 * Format seconds to human readable (e.g., "11h 45m")
 */
function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

/**
 * Render idle state with launch form
 */
function renderIdleContent(hpc) {
  return `
    <div class="cluster-info">No active session</div>
    <div class="launch-form">
      <div class="form-input">
        <label>CPUs</label>
        <input type="number" id="${hpc}-cpus" value="${defaultConfig.cpus}" min="1" max="64">
      </div>
      <div class="form-input">
        <label>Memory</label>
        <input type="text" id="${hpc}-mem" value="${defaultConfig.mem}">
      </div>
      <div class="form-input">
        <label>Time</label>
        <input type="text" id="${hpc}-time" value="${defaultConfig.time}">
      </div>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="launch('${hpc}')">Launch Session</button>
    </div>
  `;
}

/**
 * Render running state with countdown
 */
function renderRunningContent(hpc, status) {
  const seconds = countdowns[hpc] || status.timeLeftSeconds || 0;
  let countdownClass = 'countdown';
  if (seconds < 600) countdownClass += ' critical';
  else if (seconds < 1800) countdownClass += ' warning';

  return `
    <div class="cluster-info">Running on ${status.node || 'compute node'}</div>
    <div class="${countdownClass}" id="${hpc}-countdown">${formatTime(seconds)}</div>
    <div class="resources">
      <span>${status.cpus || '?'} CPUs</span>
      <span>${status.memory || '?'} RAM</span>
    </div>
    <div class="btn-group">
      <button class="btn btn-success" onclick="connect('${hpc}')">Connect</button>
      <button class="btn btn-danger" onclick="killJob('${hpc}')">Kill Job</button>
    </div>
  `;
}

/**
 * Render pending state
 */
function renderPendingContent(hpc, status) {
  let estStart = '';
  if (status.startTime) {
    estStart = '<div class="estimated-start">Est. start: ' + status.startTime + '</div>';
  }
  return `
    <div class="cluster-info">
      <span class="spinner"></span> Waiting for resources...
    </div>
    ${estStart}
    <div class="btn-group">
      <button class="btn btn-danger" onclick="killJob('${hpc}')">Cancel</button>
    </div>
  `;
}

/**
 * Update a single cluster card
 */
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

/**
 * Fetch status from server
 */
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

/**
 * Client-side countdown tick
 */
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

/**
 * Launch session
 */
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
      // If already running, offer to connect
      if (data.error && data.error.includes('already')) {
        overlay.style.display = 'none';
        if (confirm(hpc + ' already has a running session. Connect to it?')) {
          connect(hpc);
        }
        return;
      }
      throw new Error(data.error || 'Launch failed');
    }

    window.location.href = '/code/';
  } catch (e) {
    overlay.style.display = 'none';
    errorEl.textContent = e.message;
    errorEl.style.display = 'block';
  }
}

/**
 * Connect to existing session
 */
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

/**
 * Kill job with visual feedback
 */
async function killJob(hpc) {
  if (!confirm('Kill the ' + hpc + ' job?')) return;

  // Show killing state
  const dot = document.getElementById(hpc + '-dot');
  const statusText = document.getElementById(hpc + '-status-text');
  if (dot) {
    dot.className = 'status-dot killing';
  }
  if (statusText) {
    statusText.textContent = 'Killing job...';
  }
  const card = document.getElementById(hpc + '-card');
  if (card) {
    const btns = card.querySelectorAll('button');
    btns.forEach(b => b.disabled = true);
  }

  try {
    const resp = await fetch('/api/stop/' + hpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancelJob: true })
    });
    const data = await resp.json();
    if (resp.ok) {
      if (dot) dot.className = 'status-dot';
      if (statusText) statusText.textContent = 'Job killed';
    } else {
      alert('Failed to kill job: ' + (data.error || 'Unknown error'));
    }
    setTimeout(fetchStatus, 1000);
  } catch (e) {
    console.error('Kill error:', e);
    alert('Failed to kill job: ' + e.message);
    fetchStatus();
  }
}

/**
 * Initialize default config from server
 */
function initConfig(config) {
  defaultConfig = {
    cpus: config.defaultCpus || '2',
    mem: config.defaultMem || '40G',
    time: config.defaultTime || '12:00:00',
  };
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  fetchStatus();
  setInterval(fetchStatus, 30000);  // Sync with server every 30s
  setInterval(tickCountdowns, 1000); // Client-side countdown every second
});
