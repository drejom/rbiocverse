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
let walltimes = { gemini: null, apollo: null };  // Total walltime for pie calculation
let lastStatusUpdate = null;  // Timestamp of last status fetch
let statusCacheTtl = 120;     // Cache TTL in seconds (from server)

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
 * Generate SVG pie chart for time remaining
 * Solid filled pie that "opens up" (gap grows) as time passes
 * @param {number} remaining - Seconds remaining
 * @param {number} total - Total walltime in seconds
 * @param {string} hpc - Cluster name for IDs
 */
function renderTimePie(remaining, total, hpc) {
  const percent = total > 0 ? Math.max(0, remaining / total) : 1;
  const radius = 16;
  const cx = 20, cy = 20;

  let colorClass = '';
  if (remaining < 600) colorClass = 'critical';
  else if (remaining < 1800) colorClass = 'warning';

  // Calculate pie wedge path
  // Starts from top (12 o'clock), goes clockwise for remaining percent
  let piePath = '';
  if (percent >= 1) {
    // Full circle
    piePath = `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.001} ${cy - radius} Z`;
  } else if (percent > 0) {
    const angle = percent * 2 * Math.PI;
    const endX = cx + radius * Math.sin(angle);
    const endY = cy - radius * Math.cos(angle);
    const largeArc = percent > 0.5 ? 1 : 0;
    piePath = `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
  }

  return `
    <div class="time-pie">
      <svg viewBox="0 0 40 40">
        <circle class="time-pie-bg" cx="${cx}" cy="${cy}" r="${radius}"/>
        <path class="time-pie-fill ${colorClass}" id="${hpc}-pie-fill" d="${piePath}"
          data-cx="${cx}" data-cy="${cy}" data-radius="${radius}"/>
      </svg>
      <span class="time-pie-text ${colorClass}" id="${hpc}-countdown-value">${formatTime(remaining)}</span>
    </div>
  `;
}

/**
 * Render idle state with launch form
 */
function renderIdleContent(hpc) {
  return `
    <div class="cluster-info">No active session</div>
    <div class="launch-form">
      <div class="form-input">
        <label><i data-lucide="cpu" class="icon-sm"></i>CPUs</label>
        <input type="number" id="${hpc}-cpus" value="${defaultConfig.cpus}" min="1" max="64">
      </div>
      <div class="form-input">
        <label><i data-lucide="memory-stick" class="icon-sm"></i>Memory</label>
        <input type="text" id="${hpc}-mem" value="${defaultConfig.mem}">
      </div>
      <div class="form-input">
        <label><i data-lucide="timer" class="icon-sm"></i>Time</label>
        <input type="text" id="${hpc}-time" value="${defaultConfig.time}">
      </div>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="launch('${hpc}')"><i data-lucide="play" class="lucide"></i> Launch Session</button>
    </div>
  `;
}

/**
 * Render running state with countdown
 */
function renderRunningContent(hpc, status) {
  const seconds = countdowns[hpc] || status.timeLeftSeconds || 0;
  const total = walltimes[hpc] || seconds;  // Use stored walltime or current as fallback

  return `
    <div class="cluster-info"><i data-lucide="server" class="icon-sm"></i> ${status.node || 'compute node'}</div>
    ${renderTimePie(seconds, total, hpc)}
    <div class="resources">
      <span><i data-lucide="cpu" class="icon-sm"></i>${status.cpus || '?'} CPUs</span>
      <span><i data-lucide="memory-stick" class="icon-sm"></i>${status.memory || '?'}</span>
    </div>
    <div class="btn-group">
      <button class="btn btn-success" onclick="connect('${hpc}')"><i data-lucide="plug" class="lucide"></i> Connect</button>
      <button class="btn btn-danger" onclick="killJob('${hpc}')"><i data-lucide="square" class="lucide"></i> Kill Job</button>
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
      <button class="btn btn-danger" onclick="killJob('${hpc}')"><i data-lucide="x" class="lucide"></i> Cancel</button>
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
    walltimes[hpc] = null;
  } else if (status.status === 'running') {
    card.classList.add('running');
    dot.classList.add('running');
    statusText.textContent = 'Running';
    // Initialize countdown and walltime if not set
    if (!countdowns[hpc] && status.timeLeftSeconds) {
      countdowns[hpc] = status.timeLeftSeconds;
      // Use walltime from SLURM (timeLimitSeconds), fallback to remaining time
      walltimes[hpc] = status.timeLimitSeconds || status.timeLeftSeconds;
    }
    content.innerHTML = renderRunningContent(hpc, status);
  } else if (status.status === 'pending') {
    card.classList.add('pending');
    dot.classList.add('pending');
    statusText.textContent = 'Pending';
    content.innerHTML = renderPendingContent(hpc, status);
    countdowns[hpc] = null;
    walltimes[hpc] = null;
  }

  // Render Lucide icons after DOM update
  lucide.createIcons();
}

/**
 * Fetch status from server
 * @param {boolean} forceRefresh - Force cache refresh
 */
async function fetchStatus(forceRefresh = false) {
  try {
    const url = forceRefresh ? '/api/cluster-status?refresh=true' : '/api/cluster-status';
    const res = await fetch(url);
    const data = await res.json();
    clusterStatus = data;

    // Track cache info - use client time minus server's reported cache age
    // This avoids client/server time drift issues
    if (data.cacheAge !== undefined) {
      // Server tells us how old the cache is, so subtract that from now
      lastStatusUpdate = new Date(Date.now() - (data.cacheAge * 1000));
    } else {
      // Fresh data, set to now
      lastStatusUpdate = new Date();
    }
    if (data.cacheTtl) {
      statusCacheTtl = data.cacheTtl;
    }

    updateClusterCard('gemini', data.gemini);
    updateClusterCard('apollo', data.apollo);
    updateCacheIndicator();
  } catch (e) {
    console.error('Status fetch error:', e);
  }
}

/**
 * Force refresh status (called by refresh button)
 */
let isRefreshing = false;

async function refreshStatus() {
  if (isRefreshing) return;
  isRefreshing = true;

  const btn = document.getElementById('refresh-btn');
  const ageSpan = document.querySelector('.cache-age');

  if (btn) {
    btn.classList.add('spinning');
    btn.disabled = true;
  }
  if (ageSpan) {
    ageSpan.innerHTML = '<em>Updating...</em>';
  }

  await fetchStatus(true);

  isRefreshing = false;
  if (btn) {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

/**
 * Update cache age indicator
 */
function updateCacheIndicator() {
  if (isRefreshing) return;  // Don't overwrite "Updating..." message

  const indicator = document.getElementById('cache-indicator');
  if (!indicator || !lastStatusUpdate) return;

  const ageSeconds = Math.floor((Date.now() - lastStatusUpdate.getTime()) / 1000);
  const ageText = ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m ${ageSeconds % 60}s`;
  const stale = ageSeconds > statusCacheTtl;

  indicator.innerHTML = `
    <span class="cache-age ${stale ? 'stale' : ''}">Updated ${ageText} ago</span>
    <button id="refresh-btn" class="refresh-btn" onclick="refreshStatus()" title="Refresh status">
      <i data-lucide="refresh-cw" class="icon-sm"></i>
    </button>
  `;
  lucide.createIcons();
}

/**
 * Calculate SVG path for pie wedge
 */
function calcPiePath(percent, cx, cy, radius) {
  if (percent >= 1) {
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.001} ${cy - radius} Z`;
  } else if (percent > 0) {
    const angle = percent * 2 * Math.PI;
    const endX = cx + radius * Math.sin(angle);
    const endY = cy - radius * Math.cos(angle);
    const largeArc = percent > 0.5 ? 1 : 0;
    return `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
  }
  return '';
}

/**
 * Client-side countdown tick
 */
function tickCountdowns() {
  ['gemini', 'apollo'].forEach(hpc => {
    if (countdowns[hpc] && countdowns[hpc] > 0) {
      countdowns[hpc]--;
      const remaining = countdowns[hpc];
      const total = walltimes[hpc] || remaining;

      // Determine color state
      let colorClass = '';
      if (remaining < 600) colorClass = 'critical';
      else if (remaining < 1800) colorClass = 'warning';

      // Update pie chart fill
      const pieEl = document.getElementById(hpc + '-pie-fill');
      if (pieEl) {
        const percent = total > 0 ? Math.max(0, remaining / total) : 0;
        const cx = parseFloat(pieEl.dataset.cx) || 20;
        const cy = parseFloat(pieEl.dataset.cy) || 20;
        const radius = parseFloat(pieEl.dataset.radius) || 16;
        pieEl.setAttribute('d', calcPiePath(percent, cx, cy, radius));
        pieEl.className.baseVal = 'time-pie-fill' + (colorClass ? ' ' + colorClass : '');
      }

      // Update time text
      const valueEl = document.getElementById(hpc + '-countdown-value');
      if (valueEl) {
        valueEl.textContent = formatTime(remaining);
        valueEl.className = 'time-pie-text' + (colorClass ? ' ' + colorClass : '');
      }
    }
  });
}

/**
 * Launch session
 */
async function launch(hpc) {
  console.log('[Launcher] Launch requested for', hpc);
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
  console.log('[Launcher] Connect requested for', hpc);
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
  console.log('[Launcher] Kill job requested for', hpc);

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

/**
 * Tick every second - countdowns and cache age
 */
function tick() {
  tickCountdowns();
  updateCacheIndicator();
}

// Interval handles for pause/resume
let statusInterval = null;
let tickInterval = null;

/**
 * Start polling intervals
 */
function startPolling() {
  if (!statusInterval) {
    statusInterval = setInterval(fetchStatus, 60000);
  }
  if (!tickInterval) {
    tickInterval = setInterval(tick, 1000);
  }
}

/**
 * Stop polling intervals (when tab is hidden)
 */
function stopPolling() {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

/**
 * Handle visibility change - pause polling when hidden
 */
function handleVisibilityChange() {
  if (document.hidden) {
    stopPolling();
  } else {
    // Tab became visible - fetch status (uses cache) and resume polling
    fetchStatus();
    startPolling();
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  fetchStatus();  // Use cached data for fast load
  startPolling();

  // Pause polling when tab is hidden
  document.addEventListener('visibilitychange', handleVisibilityChange);
});
