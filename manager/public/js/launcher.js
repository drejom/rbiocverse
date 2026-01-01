/**
 * HPC Code Server - Launcher Page JavaScript
 * Handles cluster status display, launch form, and session management
 * Supports multiple IDEs (VS Code, RStudio) per cluster
 */

// Default configuration - will be overwritten by server config
let defaultConfig = {
  cpus: '2',
  mem: '40G',
  time: '12:00:00',
};

// Available IDEs from server
let availableIdes = {};

// Selected IDE per cluster (for launch form)
let selectedIde = {
  gemini: 'vscode',
  apollo: 'vscode',
};

// Cluster status keyed by hpc (contains ides)
let clusterStatus = { gemini: {}, apollo: {} };

// Countdowns and walltimes keyed by hpc-ide
let countdowns = {};
let walltimes = {};

let lastStatusUpdate = null;
let statusCacheTtl = 120;

/**
 * Get session key for countdown/walltime tracking
 */
function getSessionKey(hpc, ide) {
  return `${hpc}-${ide}`;
}

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
 */
function renderTimePie(remaining, total, hpc, ide) {
  const percent = total > 0 ? Math.max(0, remaining / total) : 1;
  const radius = 14;
  const cx = 18, cy = 18;
  const key = getSessionKey(hpc, ide);

  let colorClass = '';
  if (remaining < 600) colorClass = 'critical';
  else if (remaining < 1800) colorClass = 'warning';

  let piePath = '';
  if (percent >= 1) {
    piePath = `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.001} ${cy - radius} Z`;
  } else if (percent > 0) {
    const angle = percent * 2 * Math.PI;
    const endX = cx + radius * Math.sin(angle);
    const endY = cy - radius * Math.cos(angle);
    const largeArc = percent > 0.5 ? 1 : 0;
    piePath = `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
  }

  return `
    <div class="time-pie time-pie-sm">
      <svg viewBox="0 0 36 36">
        <circle class="time-pie-bg" cx="${cx}" cy="${cy}" r="${radius}"/>
        <path class="time-pie-fill ${colorClass}" id="${key}-pie-fill" d="${piePath}"
          data-cx="${cx}" data-cy="${cy}" data-radius="${radius}"/>
      </svg>
      <span class="time-pie-text ${colorClass}" id="${key}-countdown-value">${formatTime(remaining)}</span>
    </div>
  `;
}

/**
 * Render IDE selector buttons
 * @param {string} hpc - Cluster name
 * @param {string[]} runningIdeNames - List of IDE names that are already running
 */
function renderIdeSelector(hpc, runningIdeNames = []) {
  const buttons = Object.entries(availableIdes).map(([ide, info]) => {
    const isRunning = runningIdeNames.includes(ide);
    const selected = selectedIde[hpc] === ide ? 'selected' : '';
    const disabled = isRunning ? 'disabled' : '';
    const title = isRunning ? `${info.name} is already running` : `Launch ${info.name}`;

    return `
      <button class="ide-btn ${selected} ${disabled}" data-ide="${ide}"
        onclick="${isRunning ? '' : `selectIde('${hpc}', '${ide}')`}"
        ${disabled} title="${title}">
        <i class="${info.icon} icon-sm"></i>
        <span>${info.name}</span>
      </button>
    `;
  }).join('');

  return `<div class="ide-selector">${buttons}</div>`;
}

/**
 * Render idle state with IDE selector and launch form
 */
function renderIdleContent(hpc, runningIdes) {
  // If there are running IDEs, show them first, then offer to launch another
  let runningSection = '';
  if (runningIdes.length > 0) {
    runningSection = runningIdes.map(({ ide, status }) => renderRunningIdeSection(hpc, ide, status)).join('');
  }

  // Determine which IDEs are available to launch
  const runningIdeNames = runningIdes.map(r => r.ide);
  const idleIdes = Object.keys(availableIdes).filter(ide => !runningIdeNames.includes(ide));

  let launchSection = '';
  if (idleIdes.length > 0) {
    // Auto-select first idle IDE if current selection is running
    if (runningIdeNames.includes(selectedIde[hpc])) {
      selectedIde[hpc] = idleIdes[0];
    }

    launchSection = `
      <div class="launch-section">
        ${runningIdes.length > 0 ? '<div class="section-divider">Launch another IDE</div>' : ''}
        ${renderIdeSelector(hpc, runningIdeNames)}
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
          <button class="btn btn-primary" onclick="launch('${hpc}')">
            <i data-lucide="play" class="lucide"></i> Launch ${availableIdes[selectedIde[hpc]]?.name || 'IDE'}
          </button>
        </div>
      </div>
    `;
  }

  if (runningIdes.length === 0) {
    return `
      <div class="cluster-info">No active sessions</div>
      ${renderIdeSelector(hpc)}
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
        <button class="btn btn-primary" onclick="launch('${hpc}')">
          <i data-lucide="play" class="lucide"></i> Launch ${availableIdes[selectedIde[hpc]]?.name || 'IDE'}
        </button>
      </div>
    `;
  }

  return runningSection + launchSection;
}

/**
 * Render a single running IDE section within a cluster card
 */
function renderRunningIdeSection(hpc, ide, status) {
  const key = getSessionKey(hpc, ide);
  const seconds = countdowns[key] || status.timeLeftSeconds || 0;
  const total = walltimes[key] || seconds;
  const ideInfo = availableIdes[ide] || { name: ide, icon: 'box' };

  return `
    <div class="ide-session running">
      <div class="ide-session-header">
        <span class="ide-name"><i class="${ideInfo.icon} icon-sm"></i> ${ideInfo.name}</span>
        <span class="ide-node"><i data-lucide="server" class="icon-xs"></i> ${status.node || 'node'}</span>
      </div>
      <div class="ide-session-info">
        ${renderTimePie(seconds, total, hpc, ide)}
        <div class="resources-inline">
          <span><i data-lucide="cpu" class="icon-xs"></i>${status.cpus || '?'}</span>
          <span><i data-lucide="memory-stick" class="icon-xs"></i>${status.memory || '?'}</span>
        </div>
      </div>
      <div class="btn-group btn-group-sm">
        <button class="btn btn-success btn-sm" onclick="connect('${hpc}', '${ide}')">
          <i data-lucide="plug" class="icon-sm"></i> Connect
        </button>
        <button class="btn btn-danger btn-sm" onclick="killJob('${hpc}', '${ide}')">
          <i data-lucide="square" class="icon-sm"></i> Kill
        </button>
      </div>
    </div>
  `;
}

/**
 * Render pending IDE section
 */
function renderPendingIdeSection(hpc, ide, status) {
  const ideInfo = availableIdes[ide] || { name: ide, icon: 'box' };
  let estStart = '';
  if (status.startTime) {
    estStart = `<div class="estimated-start">Est: ${status.startTime}</div>`;
  }

  return `
    <div class="ide-session pending">
      <div class="ide-session-header">
        <span class="ide-name"><i class="${ideInfo.icon} icon-sm"></i> ${ideInfo.name}</span>
        <span class="spinner"></span>
      </div>
      <div class="cluster-info">Waiting for resources...</div>
      ${estStart}
      <div class="btn-group btn-group-sm">
        <button class="btn btn-danger btn-sm" onclick="killJob('${hpc}', '${ide}')">
          <i data-lucide="x" class="icon-sm"></i> Cancel
        </button>
      </div>
    </div>
  `;
}

/**
 * Select IDE for launching
 */
function selectIde(hpc, ide) {
  selectedIde[hpc] = ide;
  // Re-render just the launch button text and selector
  const card = document.getElementById(hpc + '-content');
  if (card) {
    // Update selector buttons
    card.querySelectorAll('.ide-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.ide === ide);
    });
    // Update launch button text
    const launchBtn = card.querySelector('.btn-primary');
    if (launchBtn) {
      const ideInfo = availableIdes[ide] || { name: 'IDE' };
      launchBtn.innerHTML = `<i data-lucide="play" class="lucide"></i> Launch ${ideInfo.name}`;
      lucide.createIcons();
    }
  }
}

/**
 * Update a single cluster card
 */
function updateClusterCard(hpc, ideStatuses) {
  const card = document.getElementById(hpc + '-card');
  const dot = document.getElementById(hpc + '-dot');
  const statusText = document.getElementById(hpc + '-status-text');
  const content = document.getElementById(hpc + '-content');

  card.className = 'cluster-card';
  dot.className = 'status-dot';

  // Categorize IDEs by status
  const runningIdes = [];
  const pendingIdes = [];

  for (const [ide, status] of Object.entries(ideStatuses || {})) {
    if (status.status === 'running') {
      runningIdes.push({ ide, status });
      // Initialize countdown/walltime if not set
      const key = getSessionKey(hpc, ide);
      if (!countdowns[key] && status.timeLeftSeconds) {
        countdowns[key] = status.timeLeftSeconds;
        walltimes[key] = status.timeLimitSeconds || status.timeLeftSeconds;
      }
    } else if (status.status === 'pending') {
      pendingIdes.push({ ide, status });
    }
  }

  // Determine overall card state
  if (runningIdes.length > 0) {
    card.classList.add('running');
    dot.classList.add('running');
    statusText.textContent = runningIdes.length === 1
      ? `${availableIdes[runningIdes[0].ide]?.name || 'IDE'} running`
      : `${runningIdes.length} IDEs running`;
  } else if (pendingIdes.length > 0) {
    card.classList.add('pending');
    dot.classList.add('pending');
    statusText.textContent = 'Pending';
  } else {
    statusText.textContent = 'No session';
  }

  // Render content
  let html = '';

  // Render pending IDEs first
  pendingIdes.forEach(({ ide, status }) => {
    html += renderPendingIdeSection(hpc, ide, status);
  });

  // Render running IDEs and launch form
  html += renderIdleContent(hpc, runningIdes);

  // Clear stale countdowns for IDEs no longer running
  const activeKeys = [...runningIdes, ...pendingIdes].map(r => getSessionKey(hpc, r.ide));
  Object.keys(countdowns).forEach(key => {
    if (key.startsWith(hpc + '-') && !activeKeys.includes(key)) {
      delete countdowns[key];
      delete walltimes[key];
    }
  });

  content.innerHTML = html;
  lucide.createIcons();
}

/**
 * Fetch status from server
 */
async function fetchStatus(forceRefresh = false) {
  try {
    const url = forceRefresh ? '/api/cluster-status?refresh=true' : '/api/cluster-status';
    const res = await fetch(url);
    const data = await res.json();

    // Store available IDEs
    if (data.ides) {
      availableIdes = data.ides;
    }

    // Track cache info
    if (data.cacheAge !== undefined) {
      lastStatusUpdate = new Date(Date.now() - (data.cacheAge * 1000));
    } else {
      lastStatusUpdate = new Date();
    }
    if (data.cacheTtl) {
      statusCacheTtl = data.cacheTtl;
    }

    // Update cluster cards with per-IDE status
    updateClusterCard('gemini', data.gemini);
    updateClusterCard('apollo', data.apollo);
    updateCacheIndicator();
  } catch (e) {
    console.error('Status fetch error:', e);
  }
}

/**
 * Force refresh status
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
  if (isRefreshing) return;

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
 * Client-side countdown tick for all active sessions
 */
function tickCountdowns() {
  Object.keys(countdowns).forEach(key => {
    if (countdowns[key] && countdowns[key] > 0) {
      countdowns[key]--;
      const remaining = countdowns[key];
      const total = walltimes[key] || remaining;

      let colorClass = '';
      if (remaining < 600) colorClass = 'critical';
      else if (remaining < 1800) colorClass = 'warning';

      const pieEl = document.getElementById(key + '-pie-fill');
      if (pieEl) {
        const percent = total > 0 ? Math.max(0, remaining / total) : 0;
        const cx = parseFloat(pieEl.dataset.cx) || 18;
        const cy = parseFloat(pieEl.dataset.cy) || 18;
        const radius = parseFloat(pieEl.dataset.radius) || 14;
        pieEl.setAttribute('d', calcPiePath(percent, cx, cy, radius));
        pieEl.className.baseVal = 'time-pie-fill' + (colorClass ? ' ' + colorClass : '');
      }

      const valueEl = document.getElementById(key + '-countdown-value');
      if (valueEl) {
        valueEl.textContent = formatTime(remaining);
        valueEl.className = 'time-pie-text' + (colorClass ? ' ' + colorClass : '');
      }
    }
  });
}

/**
 * Launch session with selected IDE
 */
async function launch(hpc) {
  const ide = selectedIde[hpc];
  console.log('[Launcher] Launch requested:', hpc, ide);

  const overlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  const errorEl = document.getElementById('error');

  errorEl.style.display = 'none';
  overlay.style.display = 'flex';
  const ideName = availableIdes[ide]?.name || ide;
  loadingText.textContent = `Submitting ${ideName} job to ${hpc}...`;

  try {
    const cpus = document.getElementById(hpc + '-cpus').value;
    const mem = document.getElementById(hpc + '-mem').value;
    const time = document.getElementById(hpc + '-time').value;

    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hpc, ide, cpus, mem, time })
    });

    if (!res.ok) {
      const data = await res.json();
      if (data.error && data.error.includes('already')) {
        overlay.style.display = 'none';
        if (confirm(`${hpc} already has ${ideName} running. Connect to it?`)) {
          connect(hpc, ide);
        }
        return;
      }
      throw new Error(data.error || 'Launch failed');
    }

    // Redirect to IDE
    const ideConfig = availableIdes[ide];
    window.location.href = ideConfig?.proxyPath || '/code/';
  } catch (e) {
    overlay.style.display = 'none';
    errorEl.textContent = e.message;
    errorEl.style.display = 'block';
  }
}

/**
 * Connect to existing session
 */
async function connect(hpc, ide) {
  console.log('[Launcher] Connect requested:', hpc, ide);
  const overlay = document.getElementById('loading-overlay');
  overlay.style.display = 'flex';
  const ideName = availableIdes[ide]?.name || ide;
  document.getElementById('loading-text').textContent = `Connecting to ${ideName} on ${hpc}...`;

  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hpc, ide })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Connect failed');
    }

    const ideConfig = availableIdes[ide];
    window.location.href = ideConfig?.proxyPath || '/code/';
  } catch (e) {
    overlay.style.display = 'none';
    document.getElementById('error').textContent = e.message;
    document.getElementById('error').style.display = 'block';
  }
}

/**
 * Kill job for specific IDE
 */
async function killJob(hpc, ide) {
  const ideName = availableIdes[ide]?.name || ide;
  if (!confirm(`Kill ${ideName} on ${hpc}?`)) return;
  console.log('[Launcher] Kill job requested:', hpc, ide);

  // Show killing state on IDE section
  const key = getSessionKey(hpc, ide);
  const dot = document.getElementById(hpc + '-dot');
  const statusText = document.getElementById(hpc + '-status-text');

  if (dot) dot.className = 'status-dot killing';
  if (statusText) statusText.textContent = 'Killing job...';

  try {
    const resp = await fetch(`/api/stop/${hpc}/${ide}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancelJob: true })
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert('Failed to kill job: ' + (data.error || 'Unknown error'));
    }
    // Clean up countdown
    delete countdowns[key];
    delete walltimes[key];
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
  if (config.defaultIde) {
    selectedIde.gemini = config.defaultIde;
    selectedIde.apollo = config.defaultIde;
  }
}

/**
 * Tick every second
 */
function tick() {
  tickCountdowns();
  updateCacheIndicator();
}

let statusInterval = null;
let tickInterval = null;

function startPolling() {
  if (!statusInterval) {
    statusInterval = setInterval(fetchStatus, 60000);
  }
  if (!tickInterval) {
    tickInterval = setInterval(tick, 1000);
  }
}

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

function handleVisibilityChange() {
  if (document.hidden) {
    stopPolling();
  } else {
    fetchStatus();
    startPolling();
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  fetchStatus();
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);
});
