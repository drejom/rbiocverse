/**
 * HPC Code Server - Launcher Page JavaScript
 * Handles cluster status display, launch form, and session management
 * Supports multiple IDEs (VS Code, RStudio) per cluster
 */

// Supported HPC clusters - add new clusters here
const CLUSTER_NAMES = ['gemini', 'apollo'];

// Health bar color thresholds
const HEALTH_THRESHOLD_HIGH = 85;
const HEALTH_THRESHOLD_MEDIUM = 60;

/**
 * Escape HTML special characters for safe attribute values
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
let defaultReleaseVersion = null;  // Set from server in fetchStatus()

// GPU config from server (which clusters support GPUs)
let gpuConfig = {};

// Cluster health data from server
let clusterHealth = {};

// Selected options per cluster (for launch form)
// Initialized dynamically from CLUSTER_NAMES
let selectedIde = Object.fromEntries(CLUSTER_NAMES.map(c => [c, 'vscode']));
let selectedReleaseVersion = Object.fromEntries(CLUSTER_NAMES.map(c => [c, null]));  // Set from server
let selectedGpu = Object.fromEntries(CLUSTER_NAMES.map(c => [c, '']));  // '' = no GPU

// User-edited form values (preserved across re-renders)
// null = use defaults, otherwise { cpus, mem, time }
let formValues = Object.fromEntries(CLUSTER_NAMES.map(c => [c, null]));

// Partition limits from server (static config)
let partitionLimits = {};

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

// Track which IDE sessions are being stopped (to prevent UI updates)
let stoppingJobs = {};

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

// ============================================
// Form Value Persistence & Validation
// ============================================

/**
 * Save current form values before re-render
 * @param {string} hpc - Cluster name
 */
function saveFormValues(hpc) {
  const cpusEl = document.getElementById(hpc + '-cpus');
  const memEl = document.getElementById(hpc + '-mem');
  const timeEl = document.getElementById(hpc + '-time');
  if (cpusEl || memEl || timeEl) {
    formValues[hpc] = {
      cpus: cpusEl?.value || defaultConfig.cpus,
      mem: memEl?.value || defaultConfig.mem,
      time: timeEl?.value || defaultConfig.time,
    };
  }
}

/**
 * Restore saved form values after re-render
 * @param {string} hpc - Cluster name
 */
function restoreFormValues(hpc) {
  const saved = formValues[hpc];
  if (!saved) return;
  const cpusEl = document.getElementById(hpc + '-cpus');
  const memEl = document.getElementById(hpc + '-mem');
  const timeEl = document.getElementById(hpc + '-time');
  if (cpusEl) cpusEl.value = saved.cpus;
  if (memEl) memEl.value = saved.mem;
  if (timeEl) timeEl.value = saved.time;
}

/**
 * Get form values for a cluster (saved or defaults)
 * @param {string} hpc - Cluster name
 * @returns {Object} { cpus, mem, time }
 */
function getFormValues(hpc) {
  return formValues[hpc] || {
    cpus: defaultConfig.cpus,
    mem: defaultConfig.mem,
    time: defaultConfig.time,
  };
}

/**
 * Get effective partition limits for a cluster based on GPU selection
 * @param {string} hpc - Cluster name
 * @returns {Object|null} { maxCpus, maxMemMB, maxTime } or null if no limits
 */
function getEffectiveLimits(hpc) {
  const gpu = selectedGpu[hpc] || '';
  const clusterLimits = partitionLimits[hpc];
  if (!clusterLimits) return null;

  // Get partition based on GPU selection
  let partition;
  if (gpu && gpuConfig[hpc]?.[gpu]) {
    partition = gpuConfig[hpc][gpu].partition;
  } else {
    // Default partition per cluster
    partition = hpc === 'gemini' ? 'compute' : 'fast,all';
  }
  return clusterLimits[partition] || null;
}

/**
 * Parse memory string to MB
 * @param {string} mem - Memory like "40G" or "100M"
 * @returns {number} Memory in MB, or 0 if invalid
 */
function parseMemToMB(mem) {
  const match = mem.match(/^(\d+)([gGmM])$/);
  if (!match) return 0;
  const [, value, unit] = match;
  return unit.toLowerCase() === 'g' ? parseInt(value) * 1024 : parseInt(value);
}

/**
 * Validate form inputs against partition limits
 * @param {string} hpc - Cluster name
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateForm(hpc) {
  const limits = getEffectiveLimits(hpc);
  const cpusEl = document.getElementById(hpc + '-cpus');
  const memEl = document.getElementById(hpc + '-mem');
  const timeEl = document.getElementById(hpc + '-time');

  const cpus = cpusEl?.value || '';
  const mem = memEl?.value || '';
  const time = timeEl?.value || '';

  const errors = [];

  // CPU validation
  const cpuVal = parseInt(cpus);
  if (isNaN(cpuVal) || cpuVal < 1) {
    errors.push('CPUs must be at least 1');
  } else if (limits && cpuVal > limits.maxCpus) {
    errors.push(`CPUs: max ${limits.maxCpus} for this partition`);
  }

  // Memory validation
  const memMatch = mem.match(/^(\d+)([gGmM])$/);
  if (!memMatch) {
    errors.push('Memory: use format like "40G" or "100M"');
  } else if (limits) {
    const memMB = parseMemToMB(mem);
    if (memMB > limits.maxMemMB) {
      const maxMemG = Math.floor(limits.maxMemMB / 1024);
      errors.push(`Memory: max ${maxMemG}G for this partition`);
    }
  }

  // Time validation
  if (!/^(\d{1,2}-)?\d{1,2}:\d{2}:\d{2}$/.test(time)) {
    errors.push('Time: use format like "12:00:00" or "1-00:00:00"');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Update input field attributes based on partition limits
 * @param {string} hpc - Cluster name
 */
function updateInputConstraints(hpc) {
  const limits = getEffectiveLimits(hpc);
  if (!limits) return;

  const cpusEl = document.getElementById(hpc + '-cpus');
  const memEl = document.getElementById(hpc + '-mem');
  const timeEl = document.getElementById(hpc + '-time');

  if (cpusEl) {
    cpusEl.max = limits.maxCpus;
    cpusEl.title = `Max: ${limits.maxCpus} CPUs`;
  }
  if (memEl) {
    const maxMemG = Math.floor(limits.maxMemMB / 1024);
    memEl.title = `Max: ${maxMemG}G`;
    memEl.placeholder = `Max ${maxMemG}G`;
  }
  if (timeEl) {
    timeEl.title = `Max: ${limits.maxTime}`;
    timeEl.placeholder = limits.maxTime;
  }
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
 * Uses shared PieChart module from pie-chart.js
 */
function renderTimePie(remaining, total, hpc, ide) {
  const key = getSessionKey(hpc, ide);
  return PieChart.renderPieChart(remaining, total, key, { sizeClass: 'time-pie-sm' });
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
  // Return empty array for unknown releases to surface config errors
  return releaseConfig && Array.isArray(releaseConfig.ides) ? releaseConfig.ides : [];
}

/**
 * Render release selector with Bioconductor logo
 * Clean Apple-like design with minimal version display
 * @param {string} hpc - Cluster name
 */
function renderReleaseSelector(hpc) {
  const clusterReleases = getReleasesForCluster(hpc);
  const options = Object.entries(clusterReleases).map(([version, info]) => {
    const selected = selectedReleaseVersion[hpc] === version ? 'selected' : '';
    // Show only version number in dropdown (e.g., "3.22" not "Bioconductor 3.22")
    return `<option value="${version}" ${selected}>${version}</option>`;
  }).join('');

  return `
    <div class="release-selector">
      <div class="release-brand">
        <img src="/images/bioconductor-logo.svg" alt="Bioconductor" class="bioc-logo" onerror="this.style.display='none'">
        <span class="release-label">Bioconductor</span>
      </div>
      <select id="${hpc}-release" class="release-dropdown" onchange="onReleaseChange('${hpc}')">
        ${options}
      </select>
    </div>
  `;
}

/**
 * Render GPU toggle selector
 * Clean toggle buttons for GPU selection (Apple-like segmented control)
 * @param {string} hpc - Cluster name
 */
function renderGpuSelector(hpc) {
  // Only show GPU selector for clusters with GPU support
  const clusterGpuConfig = gpuConfig[hpc];
  if (!clusterGpuConfig) return '';

  // Build toggle buttons (CPU, then each GPU type)
  const gpuTypes = Object.keys(clusterGpuConfig);
  const noneSelected = !selectedGpu[hpc] ? 'selected' : '';

  const buttons = [
    `<button type="button" class="gpu-btn ${noneSelected}" data-gpu="" onclick="selectGpu('${hpc}', '')">
      <i data-lucide="cpu" class="icon-xs"></i> CPU
    </button>`,
    ...gpuTypes.map(type => {
      const selected = selectedGpu[hpc] === type ? 'selected' : '';
      return `<button type="button" class="gpu-btn ${selected}" data-gpu="${type}" onclick="selectGpu('${hpc}', '${type}')">
        <i data-lucide="gpu" class="icon-xs"></i> ${type.toUpperCase()}
      </button>`;
    })
  ].join('');

  return `
    <div class="gpu-selector">
      <label class="gpu-label"><i data-lucide="zap" class="icon-sm"></i>Accelerator</label>
      <div class="gpu-toggle" id="${hpc}-gpu-toggle">
        ${buttons}
      </div>
    </div>
  `;
}

/**
 * Handle GPU selection via toggle buttons
 * @param {string} hpc - Cluster name
 * @param {string} gpu - GPU type ('' for CPU only)
 */
function selectGpu(hpc, gpu) {
  selectedGpu[hpc] = gpu;
  // Update toggle button states
  const toggle = document.getElementById(hpc + '-gpu-toggle');
  if (toggle) {
    toggle.querySelectorAll('.gpu-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.gpu === gpu);
    });
  }
  // Update input constraints for new partition limits
  updateInputConstraints(hpc);
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
  if (!availableForRelease.includes(selectedIde[hpc]) && availableForRelease.length > 0) {
    // Auto-select first available IDE for this release
    selectedIde[hpc] = availableForRelease[0];
  }

  // Re-render the cluster card to update IDE buttons
  const ideStatuses = clusterStatus[hpc] || {};
  updateClusterCard(hpc, ideStatuses);
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
  // If there are running IDEs, show them in a green-bordered container
  let runningSection = '';
  if (runningIdes.length > 0) {
    const sessions = runningIdes.map(({ ide, status }) => renderRunningIdeSection(hpc, ide, status)).join('');
    runningSection = `<div class="running-sessions">${sessions}</div>`;
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
          <div class="form-input input-cpus">
            <label><i data-lucide="cpu" class="icon-sm"></i>CPUs</label>
            <input type="number" id="${hpc}-cpus" value="${defaultConfig.cpus}" min="1" max="64">
          </div>
          <div class="form-input input-mem">
            <label><i data-lucide="memory-stick" class="icon-sm"></i>Memory</label>
            <input type="text" id="${hpc}-mem" value="${defaultConfig.mem}">
          </div>
          <div class="form-input input-time">
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
        <div class="form-input input-cpus">
          <label><i data-lucide="cpu" class="icon-sm"></i>CPUs</label>
          <input type="number" id="${hpc}-cpus" value="${defaultConfig.cpus}" min="1" max="64">
        </div>
        <div class="form-input input-mem">
          <label><i data-lucide="memory-stick" class="icon-sm"></i>Memory</label>
          <input type="text" id="${hpc}-mem" value="${defaultConfig.mem}">
        </div>
        <div class="form-input input-time">
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
          ${status.gpu ? `<span><i data-lucide="zap" class="icon-xs"></i>${status.gpu.toUpperCase()}</span>` : ''}
          ${status.releaseVersion ? `<span><i data-lucide="package" class="icon-xs"></i>${status.releaseVersion}</span>` : ''}
        </div>
      </div>
      <div class="btn-group btn-group-sm">
        <button class="btn btn-success btn-sm" onclick="connect('${hpc}', '${ide}')">
          <i data-lucide="plug" class="icon-sm"></i> Connect
        </button>
        <button class="btn btn-danger btn-sm" onclick="stopJob('${hpc}', '${ide}')">
          <i data-lucide="square" class="icon-sm"></i> Stop
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
        <button class="btn btn-danger btn-sm" onclick="stopJob('${hpc}', '${ide}')">
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

// ============================================
// Cluster Health Bar Rendering
// ============================================

/**
 * Render health indicator bars for a cluster
 * Shows CPU, Memory, Nodes, and GPU (if available) usage
 * @param {string} hpc - Cluster name
 * @returns {string} HTML for health bars
 */
function renderHealthBars(hpc) {
  const health = clusterHealth[hpc]?.current;

  // Cluster offline or no data yet
  if (!health || !health.online) {
    return `
      <div class="health-indicators offline">
        <span class="health-indicator offline" title="Cluster offline or loading...">
          <i data-lucide="wifi-off" class="icon-xs"></i>
        </span>
      </div>
    `;
  }

  const bars = [];

  // Order: CPU, GPU, Memory, Nodes

  // CPU bar
  if (health.cpus) {
    bars.push(renderSingleBar('cpu', health.cpus.percent, 'CPUs', `${health.cpus.used}/${health.cpus.total} allocated`));
  }

  // GPU bar (if available) - uses pre-calculated percentage from backend
  if (health.gpus && typeof health.gpus.percent !== 'undefined') {
    const gpuDetails = [];
    for (const [type, data] of Object.entries(health.gpus)) {
      if (type === 'percent') continue; // Skip the overall percentage property
      const typeGpuCount = data.total || ((data.idle || 0) + (data.busy || 0));
      gpuDetails.push(`${type.toUpperCase()}: ${data.busy || 0}/${typeGpuCount}`);
    }
    bars.push(renderSingleBar('gpu', health.gpus.percent, 'GPUs', gpuDetails.join(', ')));
  }

  // Memory bar
  if (health.memory) {
    bars.push(renderSingleBar('memory-stick', health.memory.percent, 'Memory', `${health.memory.used}/${health.memory.total} ${health.memory.unit}`));
  }

  // Nodes bar (show % busy) - uses 'server' icon to match floating menu
  if (health.nodes && health.nodes.total > 0) {
    const nodePercent = health.nodes.percent || 0;
    const nodeDetail = `${health.nodes.idle} idle, ${health.nodes.busy} busy, ${health.nodes.down} down`;
    bars.push(renderSingleBar('server', nodePercent, 'Nodes', nodeDetail));
  }

  // Fairshare bar (rightmost) - user's queue priority (1.0 = best, 0 = worst)
  if (typeof health.fairshare === 'number') {
    bars.push(renderFairshareBar(health.fairshare));
  }

  return `<div class="health-indicators">${bars.join('')}</div>`;
}

/**
 * Render a single health indicator bar
 * @param {string} icon - Lucide icon name
 * @param {number} percent - Usage percentage (0-100)
 * @param {string} label - Resource label
 * @param {string} detail - Tooltip detail text
 * @returns {string} HTML for single bar
 */
function renderSingleBar(icon, percent, label, detail) {
  // Normalize percent to a finite number between 0 and 100
  let safePercent = Number(percent);
  if (!Number.isFinite(safePercent)) {
    safePercent = 0;
  }
  safePercent = Math.min(100, Math.max(0, safePercent));

  // Determine color level based on usage thresholds
  let level = 'low';
  if (safePercent >= HEALTH_THRESHOLD_HIGH) {
    level = 'high';
  } else if (safePercent >= HEALTH_THRESHOLD_MEDIUM) {
    level = 'medium';
  }

  // Escape HTML for safe attribute values
  const safeLabel = escapeHtml(label);
  const safeDetail = escapeHtml(detail);
  const tooltip = `${safeLabel}: ${safePercent}% used${safeDetail ? ` (${safeDetail})` : ''}`;

  return `
    <span class="health-indicator" title="${tooltip}">
      <i data-lucide="${icon}" class="icon-xs"></i>
      <div class="health-bar">
        <div class="health-bar-fill ${level}" style="width: ${safePercent}%"></div>
      </div>
    </span>
  `;
}

/**
 * Render fairshare indicator bar
 * Shows user's queue priority: 1.0 = full green (best), 0 = empty/red (worst)
 * @param {number} fairshare - Fairshare score (0-1)
 * @returns {string} HTML for fairshare bar
 */
function renderFairshareBar(fairshare) {
  // Convert 0-1 to 0-100 percent
  let percent = Math.round(fairshare * 100);
  if (!Number.isFinite(percent)) percent = 0;
  percent = Math.min(100, Math.max(0, percent));

  // Color thresholds: high fairshare = green (good priority), low = red (bad priority)
  // This is INVERTED from usage bars (high usage = bad)
  const FAIRSHARE_THRESHOLD_POOR = 30;
  const FAIRSHARE_THRESHOLD_MODERATE = 60;
  let level = 'low';  // green - good priority
  if (percent < FAIRSHARE_THRESHOLD_POOR) {
    level = 'high';  // red - poor priority
  } else if (percent < FAIRSHARE_THRESHOLD_MODERATE) {
    level = 'medium';  // yellow - moderate priority
  }

  const tooltip = `Priority: ${percent}% fairshare (higher is better)`;

  return `
    <span class="health-indicator" title="${tooltip}">
      <i data-lucide="gauge" class="icon-xs"></i>
      <div class="health-bar">
        <div class="health-bar-fill ${level}" style="width: ${percent}%"></div>
      </div>
    </span>
  `;
}

/**
 * Update a single cluster card
 */
function updateClusterCard(hpc, ideStatuses) {
  // Skip UI updates for this cluster if any IDE is being stopped
  const hasStoppingJob = Object.keys(stoppingJobs).some(key => key.startsWith(hpc + '-'));
  if (hasStoppingJob) return;

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

  // Save form values before re-render
  saveFormValues(hpc);

  content.innerHTML = html;

  // Restore form values and update constraints after re-render
  restoreFormValues(hpc);
  updateInputConstraints(hpc);

  // Update health bars in header
  const healthContainer = document.getElementById(`${hpc}-health`);
  if (healthContainer) {
    healthContainer.innerHTML = renderHealthBars(hpc);
  }

  lucide.createIcons();
}


/**
 * Fetch status from server
 * Backend handles adaptive polling - this just reads cached state
 */
async function fetchStatus(forceRefresh = false) {
  try {
    // Build URL with query params
    // hasLimits=true tells server to skip static config (partitionLimits) we already have
    // This reduces response payload on subsequent polls - limits are static and only needed once
    const params = new URLSearchParams();
    if (forceRefresh) params.set('refresh', 'true');
    if (Object.keys(partitionLimits).length > 0) params.set('hasLimits', 'true');
    const url = '/api/cluster-status' + (params.toString() ? '?' + params.toString() : '');
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

    // Store GPU config
    if (data.gpuConfig) {
      gpuConfig = data.gpuConfig;
    }

    // Store partition limits (static config - server only sends on first request)
    if (data.partitionLimits) {
      partitionLimits = data.partitionLimits;
    }

    // Store cluster health data
    if (data.clusterHealth) {
      clusterHealth = data.clusterHealth;
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

    // Update cluster status
    for (const cluster of Object.keys(clusterStatus)) {
      clusterStatus[cluster] = data[cluster] || {};
    }

    // Update cluster cards with per-IDE status
    for (const cluster of Object.keys(clusterStatus)) {
      updateClusterCard(cluster, data[cluster]);
    }
    updateCacheIndicator();
  } catch (e) {
    console.error('Status fetch error:', e);
  }
}

/**
 * Force refresh status (bypasses cache)
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
 * Client-side countdown tick for all active sessions
 * Uses shared PieChart module for updates
 */
function tickCountdowns() {
  Object.keys(countdowns).forEach(key => {
    if (countdowns[key] && countdowns[key] > 0) {
      countdowns[key]--;
      const remaining = countdowns[key];
      const total = walltimes[key] || remaining;
      PieChart.updatePieChart(key, remaining, total);
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
  const launchActions = document.getElementById('launch-actions');
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
          launchActions.style.display = 'none';
          overlay.style.display = 'none';
          // Refresh status to show pending job
          fetchStatus(true);
          break;

        case 'complete':
          console.log('[Launcher] Launch complete, redirecting');
          eventSource.close();
          currentLaunch = null;
          launchActions.style.display = 'none';
          window.location.href = data.redirectUrl || '/code/';
          break;

        case 'error':
          console.error('[Launcher] Launch error:', data.message);
          eventSource.close();
          currentLaunch = null;
          launchActions.style.display = 'none';

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
    launchActions.style.display = 'none';
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

  const errorEl = document.getElementById('error');

  // Validate form inputs before launching
  const validation = validateForm(hpc);
  if (!validation.valid) {
    errorEl.textContent = validation.errors.join('; ');
    errorEl.style.display = 'block';
    return;
  }

  const overlay = document.getElementById('loading-overlay');
  const launchActions = document.getElementById('launch-actions');

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
  launchActions.style.display = 'flex';
  lucide.createIcons();

  // Use shared SSE handlers
  setupLaunchStreamHandlers(eventSource, hpc, ide);
}

/**
 * Go back to menu without stopping the job
 * Closes SSE connection and overlay, leaves any submitted job running
 */
function backToMenu() {
  if (!currentLaunch) {
    document.getElementById('loading-overlay').style.display = 'none';
    return;
  }

  const { eventSource } = currentLaunch;
  console.log('[Launcher] Back to menu requested, leaving job running');

  launchCancelled = true;

  // Close the SSE connection
  if (eventSource) {
    eventSource.close();
  }

  // Reset UI
  const overlay = document.getElementById('loading-overlay');
  const launchActions = document.getElementById('launch-actions');
  overlay.style.display = 'none';
  launchActions.style.display = 'none';
  currentLaunch = null;

  // Refresh status to show any submitted/pending job
  fetchStatus(true);
}

/**
 * Stop an in-progress launch and cancel any submitted job
 */
async function stopLaunch() {
  if (!currentLaunch) return;

  const { hpc, ide, eventSource } = currentLaunch;
  const ideName = availableIdes[ide]?.name || ide;
  console.log('[Launcher] Stop launch requested:', hpc, ide);

  launchCancelled = true;

  // Close the SSE connection
  if (eventSource) {
    eventSource.close();
  }

  const overlay = document.getElementById('loading-overlay');
  const launchActions = document.getElementById('launch-actions');
  const stopBtn = document.getElementById('cancel-stop-btn');

  // Show stopping progress with indeterminate bar
  updateProgress(0, 'Stopping job...', 'stopping', { header: `Stopping ${ideName}...` });
  const fill = document.getElementById('progress-fill');
  fill.classList.add('indeterminate');
  stopBtn.disabled = true;

  let stopFailed = false;
  try {
    // Stop the job on the server
    const res = await fetch(`/api/stop/${hpc}/${ide}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancelJob: true })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server returned ${res.status}`);
    }
    console.log('[Launcher] Job stopped successfully');
  } catch (e) {
    console.error('[Launcher] Stop error:', e);
    stopFailed = true;
  }

  // Reset UI
  overlay.style.display = 'none';
  launchActions.style.display = 'none';
  stopBtn.disabled = false;
  fill.classList.remove('indeterminate');
  currentLaunch = null;

  // Show error if stop failed
  if (stopFailed) {
    const errorEl = document.getElementById('error');
    errorEl.textContent = `Warning: Could not confirm stop of ${ideName} on ${hpc}. The job may still be running.`;
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
  const launchActions = document.getElementById('launch-actions');
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
  launchActions.style.display = 'flex';
  lucide.createIcons();

  // Use shared SSE handlers
  setupLaunchStreamHandlers(eventSource, hpc, ide);
}

/**
 * Stop job for specific IDE with SSE progress
 */
async function stopJob(hpc, ide) {
  const ideName = availableIdes[ide]?.name || ide;
  const key = getSessionKey(hpc, ide);

  // Guard against double-stop
  if (stoppingJobs[key]) return;
  if (!confirm(`Stop ${ideName} on ${hpc}?`)) return;

  console.log('[Launcher] Stop job requested:', hpc, ide);
  stoppingJobs[key] = true;

  // Show stopping state on cluster header
  const dot = document.getElementById(hpc + '-dot');
  const statusText = document.getElementById(hpc + '-status-text');
  if (dot) dot.className = 'status-dot stopping';
  if (statusText) statusText.textContent = 'Stopping...';

  // Replace the IDE session buttons with progress bar
  const sessionEl = document.querySelector(`.ide-session.running:has([onclick*="stopJob('${hpc}', '${ide}')"])`);
  if (sessionEl) {
    const btnGroup = sessionEl.querySelector('.btn-group');
    if (btnGroup) {
      btnGroup.innerHTML = `
        <div class="stop-progress">
          <div class="stop-progress-text">Stopping job...</div>
          <div class="stop-progress-bar"><div class="stop-progress-fill"></div></div>
        </div>
      `;
    }
  }

  // Use SSE for progress
  const eventSource = new EventSource(`/api/stop/${hpc}/${ide}/stream`);

  // Fallback timeout - if SSE hangs, clean up after 15s
  const fallbackTimeout = setTimeout(() => {
    if (stoppingJobs[key]) {
      console.log('[Launcher] Stop timeout, cleaning up');
      delete stoppingJobs[key];
      eventSource.close();
      delete countdowns[key];
      delete walltimes[key];
      fetchStatus(true);
    }
  }, 15000);

  eventSource.onmessage = function(event) {
    try {
      const data = JSON.parse(event.data);
      console.log('[Launcher] Stop SSE event:', data);

      if (data.type === 'progress') {
        const textEl = sessionEl?.querySelector('.stop-progress-text');
        if (textEl) textEl.textContent = data.message;
      }

      if (data.type === 'complete' || data.type === 'error') {
        clearTimeout(fallbackTimeout);
        delete stoppingJobs[key];
        eventSource.close();

        if (data.type === 'error') {
          alert('Failed to stop job: ' + (data.message || 'Unknown error'));
        }

        // Clean up countdown and refresh status
        delete countdowns[key];
        delete walltimes[key];
        fetchStatus(true);
      }
    } catch (e) {
      console.error('[Launcher] Stop SSE parse error:', e);
    }
  };

  eventSource.onerror = function() {
    console.error('[Launcher] Stop SSE connection error');
    clearTimeout(fallbackTimeout);
    delete stoppingJobs[key];
    eventSource.close();
    // Clean up and refresh
    delete countdowns[key];
    delete walltimes[key];
    fetchStatus(true);
  };
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

/**
 * Frontend polling configuration
 *
 * Backend handles adaptive polling with backoff - frontend just reads cached state.
 * We use a simple fixed interval since /api/status returns instantly from memory.
 */
const POLL_INTERVAL_MS = 2000; // 2 seconds - backend caches, this is cheap

// Debug logging - set to true via browser console: window.POLLING_DEBUG = true
const DEBUG = () => window.POLLING_DEBUG || false;
const debugLog = (...args) => DEBUG() && console.log('[Polling]', ...args);

function startPolling() {
  // Tick interval for countdown timers (every second)
  if (!tickInterval) {
    tickInterval = setInterval(tick, 1000);
  }

  // Status polling (reads from backend cache - instant response)
  if (!statusInterval) {
    statusInterval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    debugLog(`Started with ${POLL_INTERVAL_MS / 1000}s interval (backend handles adaptive polling)`);
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
    // Fetch immediately when tab becomes visible, then resume polling
    fetchStatus();
    startPolling();
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  fetchStatus();
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Attach launch action button listeners
  document.getElementById('back-to-menu-btn').addEventListener('click', backToMenu);
  document.getElementById('cancel-stop-btn').addEventListener('click', stopLaunch);
});
