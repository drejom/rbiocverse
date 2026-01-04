/**
 * HPC Code Server - Launcher Page JavaScript
 * Handles cluster status display, launch form, and session management
 * Supports multiple IDEs (VS Code, RStudio) per cluster
 */

// Supported HPC clusters - add new clusters here
const CLUSTER_NAMES = ['gemini', 'apollo'];

// Default configuration - will be overwritten by server config
let defaultConfig = {
  cpus: '2',
  mem: '40G',
  time: '12:00:00',
};

// Available IDEs from server
let availableIdes = {};

// Available releases from server
let availableReleases = {};
let defaultReleaseVersion = '3.22';

// Selected options per cluster (for launch form)
// Initialized dynamically from CLUSTER_NAMES
let selectedIde = Object.fromEntries(CLUSTER_NAMES.map(c => [c, 'vscode']));
let selectedReleaseVersion = Object.fromEntries(CLUSTER_NAMES.map(c => [c, '3.22']));
let selectedGpu = Object.fromEntries(CLUSTER_NAMES.map(c => [c, '']));  // '' = no GPU

// Cluster status keyed by hpc (contains ides)
// Initialized dynamically from CLUSTER_NAMES
let clusterStatus = Object.fromEntries(CLUSTER_NAMES.map(c => [c, {}]));

// Countdowns and walltimes keyed by hpc-ide
let countdowns = {};
let walltimes = {};

let lastStatusUpdate = null;
let statusCacheTtl = 120;

// Launch cancellation tracking
let currentLaunch = null; // { hpc, ide, eventSource }
let launchCancelled = false;

// Cached DOM elements for progress UI (initialized after DOMContentLoaded)
let progressElements = null;

// Step estimate widths (slightly ahead of fill to show uncertainty band)
// Based on timing analysis: CV ~22-24% for submit/wait steps
const STEP_ESTIMATES = {
  connecting: 10,    // 5% fill + buffer
  submitting: 40,    // 30% fill + buffer
  submitted: 45,     // 35% fill + buffer
  waiting: 70,       // 60% fill + buffer
  starting: 75,      // 65% fill + buffer
  establishing: 100, // Tunnel + IDE ready (dynamic ~2-5s)
};

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
 * Get releases available for a specific cluster
 * Filters out releases that don't have paths for the cluster
 * @param {string} hpc - Cluster name (e.g., 'gemini', 'apollo')
 * @returns {Object} Filtered releases object
 */
function getReleasesForCluster(hpc) {
  const filtered = {};
  for (const [version, info] of Object.entries(availableReleases)) {
    // Only include releases that have paths for this cluster
    if (info.clusters && info.clusters.includes(hpc)) {
      filtered[version] = info;
    }
  }
  return filtered;
}

/**
 * Get IDEs available for the selected release
 * @param {string} releaseVersion - Release version (e.g., '3.22')
 * @returns {string[]} List of IDE names available for this release
 */
function getIdesForRelease(releaseVersion) {
  const releaseConfig = availableReleases[releaseVersion];
  return releaseConfig ? releaseConfig.ides : Object.keys(availableIdes);
}

/**
 * Render release selector dropdown
 * Only shows releases available for the current cluster
 * @param {string} hpc - Cluster name
 */
function renderReleaseSelector(hpc) {
  const clusterReleases = getReleasesForCluster(hpc);
  const options = Object.entries(clusterReleases).map(([version, info]) => {
    const selected = selectedReleaseVersion[hpc] === version ? 'selected' : '';
    return `<option value="${version}" ${selected}>${info.name}</option>`;
  }).join('');

  return `
    <div class="form-input form-input-release">
      <label><i data-lucide="package" class="icon-sm"></i>Release</label>
      <select id="${hpc}-release" onchange="onReleaseChange('${hpc}')">
        ${options}
      </select>
    </div>
  `;
}

/**
 * Render GPU selector dropdown (Gemini only)
 * @param {string} hpc - Cluster name
 */
function renderGpuSelector(hpc) {
  // Only show GPU selector for Gemini
  if (hpc !== 'gemini') return '';

  return `
    <div class="form-input">
      <label><i data-lucide="zap" class="icon-sm"></i>GPU</label>
      <select id="${hpc}-gpu" onchange="onGpuChange('${hpc}')">
        <option value="">None (CPU only)</option>
        <option value="a100">A100 (4-day max)</option>
        <option value="v100">V100 (8-day max)</option>
      </select>
    </div>
  `;
}

/**
 * Handle release change - filter available IDEs
 * @param {string} hpc - Cluster name
 */
function onReleaseChange(hpc) {
  const select = document.getElementById(hpc + '-release');
  const newReleaseVersion = select.value;
  selectedReleaseVersion[hpc] = newReleaseVersion;

  // Check if current IDE is available in new release
  const availableForRelease = getIdesForRelease(newReleaseVersion);
  if (!availableForRelease.includes(selectedIde[hpc])) {
    // Auto-select first available IDE
    selectedIde[hpc] = availableForRelease[0] || 'vscode';
  }

  // Re-render the cluster card to update IDE buttons
  const ideStatuses = clusterStatus[hpc] || {};
  updateClusterCard(hpc, ideStatuses);
}

/**
 * Handle GPU change
 * @param {string} hpc - Cluster name
 */
function onGpuChange(hpc) {
  const select = document.getElementById(hpc + '-gpu');
  selectedGpu[hpc] = select.value;
}

/**
 * Render IDE selector buttons
 * @param {string} hpc - Cluster name
 * @param {string[]} runningIdeNames - List of IDE names that are already running
 */
function renderIdeSelector(hpc, runningIdeNames = []) {
  const releaseVersion = selectedReleaseVersion[hpc];
  const idesForRelease = getIdesForRelease(releaseVersion);

  const buttons = Object.entries(availableIdes).map(([ide, info]) => {
    const isRunning = runningIdeNames.includes(ide);
    const isAvailable = idesForRelease.includes(ide);
    const selected = selectedIde[hpc] === ide ? 'selected' : '';
    const disabled = isRunning || !isAvailable ? 'disabled' : '';

    let title = `Launch ${info.name}`;
    if (isRunning) {
      title = `${info.name} is already running`;
    } else if (!isAvailable) {
      title = `${info.name} not available on ${availableReleases[releaseVersion]?.name || releaseVersion}`;
    }

    return `
      <button class="ide-btn ${selected} ${disabled}" data-ide="${ide}"
        onclick="${isRunning || !isAvailable ? '' : `selectIde('${hpc}', '${ide}')`}"
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

  // Determine which IDEs are available to launch (not running, available for release)
  const runningIdeNames = runningIdes.map(r => r.ide);
  const idesForRelease = getIdesForRelease(selectedReleaseVersion[hpc]);
  const idleIdes = idesForRelease.filter(ide => !runningIdeNames.includes(ide));

  let launchSection = '';
  if (idleIdes.length > 0) {
    // Auto-select first idle IDE if current selection is running or unavailable
    if (runningIdeNames.includes(selectedIde[hpc]) || !idesForRelease.includes(selectedIde[hpc])) {
      selectedIde[hpc] = idleIdes[0];
    }

    launchSection = `
      <div class="launch-section">
        ${runningIdes.length > 0 ? '<div class="section-divider">Launch another IDE</div>' : ''}
        ${renderReleaseSelector(hpc)}
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
          ${renderGpuSelector(hpc)}
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
      ${renderReleaseSelector(hpc)}
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
        ${renderGpuSelector(hpc)}
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
 * Detect if cluster status has changed (for exponential backoff reset)
 *
 * Detects the following changes:
 * - Job status changes (pending/running/idle)
 * - Job ID changes (new job started)
 * - IDE additions (new IDE appears in status)
 * - IDE removals (IDE disappears from status, e.g., job completed)
 * - Time bucket changes (remaining time crosses 5-minute boundary)
 *
 * @param {Object} newStatus - New cluster status object
 * @returns {boolean} True if status has changed
 */
function hasStatusChanged(newStatus) {
  if (!lastClusterStatusSnapshot) return true;

  // Create comparable snapshots (job IDs and states)
  const createSnapshot = (status) => {
    const snapshot = {};
    for (const [cluster, ides] of Object.entries(status)) {
      snapshot[cluster] = {};
      for (const [ide, ideStatus] of Object.entries(ides || {})) {
        snapshot[cluster][ide] = {
          status: ideStatus.status,
          jobId: ideStatus.jobId,
          // Bucket remaining time into 5-minute intervals; changes across bucket boundaries reset backoff
          timeLeftBucket: Math.floor((ideStatus.timeLeftSeconds || 0) / POLLING_CONFIG.TIME_BUCKET_SECONDS)
        };
      }
    }
    return JSON.stringify(snapshot);
  };

  const oldSnapshot = createSnapshot(lastClusterStatusSnapshot);
  const newSnapshot = createSnapshot(newStatus);

  return oldSnapshot !== newSnapshot;
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

    // Store available releases
    if (data.releases) {
      availableReleases = data.releases;
    }
    if (data.defaultReleaseVersion) {
      defaultReleaseVersion = data.defaultReleaseVersion;
      // Initialize selected release if not already set
      for (const hpc of CLUSTER_NAMES) {
        if (!selectedReleaseVersion[hpc]) {
          selectedReleaseVersion[hpc] = defaultReleaseVersion;
        }
      }
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

    // Detect state changes for exponential backoff
    // Build newClusterStatus dynamically from existing clusterStatus keys
    const newClusterStatus = {};
    for (const cluster of Object.keys(clusterStatus)) {
      newClusterStatus[cluster] = data[cluster] || {};
    }

    if (hasStatusChanged(newClusterStatus)) {
      // State changed - reset backoff
      consecutiveUnchangedPolls = 0;
      debugLog('State changed - backoff reset');
    } else {
      // No change - increment backoff counter
      consecutiveUnchangedPolls++;
      if (consecutiveUnchangedPolls >= POLLING_CONFIG.BACKOFF.START_THRESHOLD) {
        debugLog(`No changes for ${consecutiveUnchangedPolls} polls - applying backoff`);
      }
    }

    // Update cluster status for adaptive polling
    for (const cluster of Object.keys(clusterStatus)) {
      clusterStatus[cluster] = newClusterStatus[cluster];
    }
    lastClusterStatusSnapshot = newClusterStatus;

    // Update cluster cards with per-IDE status
    for (const cluster of Object.keys(clusterStatus)) {
      updateClusterCard(cluster, data[cluster]);
    }
    updateCacheIndicator();

    // Adjust polling interval based on new status
    startPolling();
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

  // Reset backoff on manual refresh
  consecutiveUnchangedPolls = 0;

  await fetchStatus(true);

  isRefreshing = false;
  if (btn) {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

/**
 * Format seconds to a compact human-readable string
 */
function formatSecondsCompact(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Update cache age indicator - shows time until next update
 */
function updateCacheIndicator() {
  if (isRefreshing) return;

  const indicator = document.getElementById('cache-indicator');
  if (!indicator || !lastStatusUpdate) return;

  const ageMs = Date.now() - lastStatusUpdate.getTime();
  const timeUntilNextPoll = Math.max(0, currentPollInterval - ageMs);
  const secondsUntilNext = Math.ceil(timeUntilNextPoll / 1000);

  const updateText = secondsUntilNext > 0
    ? `Updating in ${formatSecondsCompact(secondsUntilNext)}`
    : 'Updating...';

  indicator.innerHTML = `
    <span class="cache-age">${updateText}</span>
    <button id="refresh-btn" class="refresh-btn" onclick="refreshStatus()" title="Refresh now">
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
 * Get cached progress UI elements (lazy initialization)
 */
function getProgressElements() {
  if (!progressElements) {
    progressElements = {
      header: document.getElementById('progress-header'),
      step: document.getElementById('progress-step'),
      fill: document.getElementById('progress-fill'),
      estimate: document.getElementById('progress-estimate'),
      error: document.getElementById('progress-error'),
    };
  }
  return progressElements;
}

/**
 * Update progress UI elements
 */
function updateProgress(progress, message, step, options = {}) {
  const els = getProgressElements();

  if (options.header) {
    els.header.textContent = options.header;
  }

  els.step.textContent = message;

  // Update fill width
  els.fill.style.width = progress + '%';

  // Update estimate band (slightly ahead to show uncertainty)
  const estimateWidth = STEP_ESTIMATES[step] || progress + 5;
  els.estimate.style.width = Math.min(100, estimateWidth) + '%';

  // Handle special states
  if (options.pending) {
    els.fill.classList.add('pending');
    els.estimate.classList.add('pending');
  } else {
    els.fill.classList.remove('pending');
    els.estimate.classList.remove('pending');
  }

  if (options.error) {
    els.fill.classList.add('error');
    els.error.textContent = options.error;
    els.error.style.display = 'block';
  } else {
    els.fill.classList.remove('error');
    els.error.style.display = 'none';
  }
}

/**
 * Reset progress UI to initial state
 */
function resetProgress() {
  updateProgress(0, 'Connecting...', 'connecting', { header: 'Starting...' });
  const els = getProgressElements();
  els.fill.classList.remove('pending', 'error', 'indeterminate');
  els.estimate.classList.remove('pending');
}

/**
 * Setup SSE event handlers for launch/connect streams
 * Shared between launch() and connect() to avoid code duplication
 * @param {EventSource} eventSource - SSE connection
 * @param {string} hpc - Cluster name
 * @param {string} ide - IDE type
 */
function setupLaunchStreamHandlers(eventSource, hpc, ide) {
  const overlay = document.getElementById('loading-overlay');
  const cancelBtn = document.getElementById('cancel-launch-btn');
  const errorEl = document.getElementById('error');
  const ideName = availableIdes[ide]?.name || ide;

  eventSource.onmessage = function(event) {
    if (launchCancelled) return;

    try {
      const data = JSON.parse(event.data);
      console.log('[Launcher] SSE event:', data);

      switch (data.type) {
        case 'progress':
          updateProgress(data.progress, data.message, data.step);
          break;

        case 'pending-timeout':
          // Job is pending - return to launcher showing pending state
          console.log('[Launcher] Job pending, returning to launcher');
          eventSource.close();
          currentLaunch = null;
          cancelBtn.style.display = 'none';
          overlay.style.display = 'none';
          // Refresh status to show pending job
          fetchStatus(true);
          break;

        case 'complete':
          console.log('[Launcher] Launch complete, redirecting');
          eventSource.close();
          currentLaunch = null;
          cancelBtn.style.display = 'none';
          window.location.href = data.redirectUrl || '/code/';
          break;

        case 'error':
          console.error('[Launcher] Launch error:', data.message);
          eventSource.close();
          currentLaunch = null;
          cancelBtn.style.display = 'none';

          // Handle "already running" case
          if (data.message && data.message.includes('already')) {
            overlay.style.display = 'none';
            if (confirm(`${hpc} already has ${ideName} running. Connect to it?`)) {
              connect(hpc, ide);
            }
            return;
          }

          updateProgress(0, '', 'error', { error: data.message, header: 'Launch Failed' });
          // Auto-hide after 5 seconds
          setTimeout(() => {
            if (overlay.style.display !== 'none') {
              overlay.style.display = 'none';
              errorEl.textContent = data.message;
              errorEl.style.display = 'block';
            }
          }, 5000);
          break;
      }
    } catch (e) {
      console.error('[Launcher] Failed to parse SSE data:', e);
    }
  };

  eventSource.onerror = function(event) {
    if (launchCancelled) return;
    console.error('[Launcher] SSE connection error');
    eventSource.close();
    currentLaunch = null;
    cancelBtn.style.display = 'none';
    overlay.style.display = 'none';
    errorEl.textContent = 'Connection lost. Please try again.';
    errorEl.style.display = 'block';
  };
}

/**
 * Launch session with selected IDE using SSE for real-time progress
 */
async function launch(hpc) {
  const ide = selectedIde[hpc];
  const releaseVersion = selectedReleaseVersion[hpc];
  const gpu = selectedGpu[hpc] || '';
  console.log('[Launcher] Launch requested:', hpc, ide, 'releaseVersion:', releaseVersion, 'gpu:', gpu || 'none');

  const overlay = document.getElementById('loading-overlay');
  const cancelBtn = document.getElementById('cancel-launch-btn');
  const errorEl = document.getElementById('error');

  errorEl.style.display = 'none';
  overlay.style.display = 'flex';
  resetProgress();

  const ideName = availableIdes[ide]?.name || ide;
  updateProgress(0, 'Connecting...', 'connecting', { header: `Starting ${ideName}...` });

  // Get form values
  const cpus = document.getElementById(hpc + '-cpus').value;
  const mem = document.getElementById(hpc + '-mem').value;
  const time = document.getElementById(hpc + '-time').value;

  // Build SSE URL with query params (include releaseVersion and gpu)
  const params = new URLSearchParams({ cpus, mem, time, releaseVersion });
  if (gpu) params.set('gpu', gpu);
  const url = `/api/launch/${hpc}/${ide}/stream?${params}`;

  // Create EventSource for SSE
  const eventSource = new EventSource(url);
  currentLaunch = { hpc, ide, eventSource };
  launchCancelled = false;
  cancelBtn.style.display = 'inline-flex';
  lucide.createIcons();

  // Use shared SSE handlers
  setupLaunchStreamHandlers(eventSource, hpc, ide);
}

/**
 * Cancel an in-progress launch
 */
async function cancelLaunch() {
  if (!currentLaunch) return;

  const { hpc, ide, eventSource } = currentLaunch;
  const ideName = availableIdes[ide]?.name || ide;
  console.log('[Launcher] Cancel requested:', hpc, ide);

  launchCancelled = true;

  // Close the SSE connection
  if (eventSource) {
    eventSource.close();
  }

  const overlay = document.getElementById('loading-overlay');
  const cancelBtn = document.getElementById('cancel-launch-btn');

  // Show cancelling progress with indeterminate bar
  updateProgress(0, 'Stopping...', 'cancelling', { header: `Stopping ${ideName}...` });
  const fill = document.getElementById('progress-fill');
  fill.classList.add('indeterminate');
  cancelBtn.disabled = true;

  let cancelFailed = false;
  try {
    // Cancel the job on the server
    const res = await fetch(`/api/stop/${hpc}/${ide}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancelJob: true })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server returned ${res.status}`);
    }
    console.log('[Launcher] Job cancelled successfully');
  } catch (e) {
    console.error('[Launcher] Cancel error:', e);
    cancelFailed = true;
  }

  // Reset UI
  overlay.style.display = 'none';
  cancelBtn.style.display = 'none';
  cancelBtn.disabled = false;
  fill.classList.remove('indeterminate');
  currentLaunch = null;

  // Show error if cancellation failed
  if (cancelFailed) {
    const errorEl = document.getElementById('error');
    errorEl.textContent = `Warning: Could not confirm cancellation of ${ideName} on ${hpc}. The job may still be running.`;
    errorEl.style.display = 'block';
  }

  // Refresh status to show updated state
  await fetchStatus(true);
}

/**
 * Connect to existing session using SSE for real-time progress
 * Uses same streaming endpoint as launch() - detects existing job and establishes tunnel
 */
async function connect(hpc, ide) {
  console.log('[Launcher] Connect requested:', hpc, ide);

  const overlay = document.getElementById('loading-overlay');
  const cancelBtn = document.getElementById('cancel-launch-btn');
  const errorEl = document.getElementById('error');

  errorEl.style.display = 'none';
  overlay.style.display = 'flex';
  resetProgress();

  const ideName = availableIdes[ide]?.name || ide;
  updateProgress(0, 'Connecting...', 'connecting', { header: `Connecting to ${ideName}...` });

  // Use SSE stream for progress feedback (same endpoint as launch)
  // Server detects existing job and just establishes tunnel
  const url = `/api/launch/${hpc}/${ide}/stream`;
  const eventSource = new EventSource(url);
  currentLaunch = { hpc, ide, eventSource };
  launchCancelled = false;
  cancelBtn.style.display = 'inline-flex';
  lucide.createIcons();

  // Use shared SSE handlers
  setupLaunchStreamHandlers(eventSource, hpc, ide);
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
let currentPollInterval = 60000; // Start with 60s default
let consecutiveUnchangedPolls = 0; // Track polls with no state changes for backoff
let lastClusterStatusSnapshot = null; // Track previous state to detect changes

// Debug logging - set to true via browser console: window.POLLING_DEBUG = true
const DEBUG = () => window.POLLING_DEBUG || false;
const debugLog = (...args) => DEBUG() && console.log('[Polling]', ...args);

/**
 * Polling configuration - centralized constants for adaptive polling behavior
 */
const POLLING_CONFIG = {
  // Time thresholds (seconds) for determining polling frequency
  THRESHOLDS_SECONDS: {
    NEAR_EXPIRY: 600,       // 10 minutes - jobs about to expire
    APPROACHING_END: 1800,  // 30 minutes - jobs approaching end
    MODERATE: 3600,         // 1 hour - moderate time remaining
    STABLE: 21600,          // 6 hours - long-running stable jobs
  },
  // Polling intervals (milliseconds) for each state
  INTERVALS_MS: {
    FREQUENT: 15000,        // 15s - for pending jobs or near expiry
    MODERATE: 60000,        // 1m - for jobs approaching end (10-30min left)
    RELAXED: 300000,        // 5m - for jobs with 30min-1hr left
    INFREQUENT: 600000,     // 10m - for jobs with 1-6hr left
    IDLE: 1800000,          // 30m - for very stable jobs (>6hr) or no sessions
    MAX: 3600000,           // 1hr - absolute maximum interval
  },
  // Exponential backoff configuration
  BACKOFF: {
    START_THRESHOLD: 3,     // Apply backoff when reaching 3 unchanged polls (1.5x at 3, 2.25x at 4, 3.375x at 5+)
    MULTIPLIER: 1.5,        // Multiply interval by 1.5x each time
    MAX_EXPONENT: 3,        // Cap exponent at 3 (max multiplier: 1.5^3 = 3.375x)
  },
  // Time bucket size for change detection (seconds)
  TIME_BUCKET_SECONDS: 300, // 5-minute buckets
};

/**
 * Determine optimal polling interval based on job time remaining and exponential backoff
 *
 * Time-based ramping (uses actual timeLeft from SLURM):
 * - Pending: 15s (waiting for node assignment)
 * - Running with <10min left: 15s (about to expire)
 * - Running with 10-30min left: 60s (approaching end)
 * - Running with 30min-1hr left: 300s (5 minutes)
 * - Running with 1-6hr left: 600s (10 minutes)
 * - Running with >6hr left: 1800s (30 minutes - very stable)
 * - No sessions: 1800s (30 minutes)
 *
 * Progressive exponential backoff (when no state changes):
 * - After 3 consecutive unchanged polls, apply progressive multiplier
 * - Multiplier increases: 1.5x after 3 polls, 2.25x after 4, 3.375x after 5+
 * - Maximum interval: 3600s (1 hour) for very stable long-running jobs
 * - Reset backoff on any state change (new job, status change, time bucket change)
 */
function getOptimalPollInterval() {
  const { THRESHOLDS_SECONDS, INTERVALS_MS, BACKOFF } = POLLING_CONFIG;

  let hasPending = false;
  let minTimeLeft = Infinity; // Track shortest time remaining across all jobs
  let hasAnySessions = false;

  // Check all clusters for job status (derived dynamically)
  for (const cluster of Object.keys(clusterStatus)) {
    const ideStatuses = clusterStatus[cluster] || {};
    for (const status of Object.values(ideStatuses)) {
      if (status.status === 'pending') {
        hasPending = true;
        hasAnySessions = true;
      } else if (status.status === 'running') {
        hasAnySessions = true;
        // Track the job with least time remaining
        const timeLeft = status.timeLeftSeconds || Infinity;
        if (timeLeft < minTimeLeft) {
          minTimeLeft = timeLeft;
        }
      }
    }
  }

  // Pending jobs need frequent updates (waiting for node assignment)
  if (hasPending) {
    return INTERVALS_MS.FREQUENT;
  }

  // No sessions at all - very infrequent polling
  if (!hasAnySessions) {
    return INTERVALS_MS.IDLE;
  }

  // Determine base interval from time remaining
  let baseInterval;
  if (minTimeLeft < THRESHOLDS_SECONDS.NEAR_EXPIRY) {
    baseInterval = INTERVALS_MS.FREQUENT;
  } else if (minTimeLeft < THRESHOLDS_SECONDS.APPROACHING_END) {
    baseInterval = INTERVALS_MS.MODERATE;
  } else if (minTimeLeft < THRESHOLDS_SECONDS.MODERATE) {
    baseInterval = INTERVALS_MS.RELAXED;
  } else if (minTimeLeft < THRESHOLDS_SECONDS.STABLE) {
    baseInterval = INTERVALS_MS.INFREQUENT;
  } else {
    baseInterval = INTERVALS_MS.IDLE;
  }

  // Apply progressive exponential backoff if no changes detected
  // When reaching START_THRESHOLD unchanged polls, apply increasing multiplier:
  // - At 3 polls: 1.5x, at 4 polls: 2.25x, at 5+ polls: 3.375x (capped)
  if (consecutiveUnchangedPolls >= BACKOFF.START_THRESHOLD) {
    const exponent = Math.min(
      consecutiveUnchangedPolls - BACKOFF.START_THRESHOLD + 1,
      BACKOFF.MAX_EXPONENT
    );
    const backoffMultiplier = Math.pow(BACKOFF.MULTIPLIER, exponent);
    const backedOffInterval = baseInterval * backoffMultiplier;
    return Math.min(backedOffInterval, INTERVALS_MS.MAX);
  }

  return baseInterval;
}

function startPolling() {
  // Always start tick interval for countdowns
  if (!tickInterval) {
    tickInterval = setInterval(tick, 1000);
  }

  // Start or restart status polling with adaptive interval
  const optimalInterval = getOptimalPollInterval();

  const previousInterval = currentPollInterval;
  const intervalDecreased = optimalInterval < currentPollInterval;

  if (statusInterval && optimalInterval !== currentPollInterval) {
    // Interval changed - restart with new interval
    clearInterval(statusInterval);
    statusInterval = null;
    debugLog(`Interval adjusted: ${previousInterval}ms -> ${optimalInterval}ms`);
  }

  if (!statusInterval) {
    currentPollInterval = optimalInterval;
    statusInterval = setInterval(fetchStatus, currentPollInterval);
    debugLog(`Started with ${Math.floor(currentPollInterval / 1000)}s interval`);

    // If polling frequency increased (interval decreased), fetch immediately
    // This ensures responsive updates when jobs transition to critical states
    if (intervalDecreased) {
      debugLog('Frequency increased - fetching immediately');
      fetchStatus();
    }
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
  debugLog('Stopped');
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopPolling();
  } else {
    // Reset backoff when user returns to page
    consecutiveUnchangedPolls = 0;
    fetchStatus();
    startPolling();
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  fetchStatus();
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Attach cancel button event listener
  document.getElementById('cancel-launch-btn').addEventListener('click', cancelLaunch);
});
