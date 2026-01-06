/**
 * Shared pie chart utilities for time remaining visualization
 * Used by both launcher.js (main menu) and menu-frame.html (floating menu)
 */

/**
 * Calculate SVG path for pie wedge (clockwise from 12 o'clock)
 * @param {number} percent - Fill percentage (0-1)
 * @param {number} cx - Center X coordinate
 * @param {number} cy - Center Y coordinate
 * @param {number} radius - Circle radius
 * @returns {string} SVG path data
 */
function calcPiePath(percent, cx, cy, radius) {
  if (percent >= 1) {
    // Full circle - use two arcs to complete the circle
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.001} ${cy - radius} Z`;
  } else if (percent > 0) {
    // Arc fills counter-clockwise from 12 o'clock, so empty space grows clockwise (to the right)
    // Endpoint is where the consumed (empty) portion ends, going clockwise from 12
    const consumed = 1 - percent;
    const angle = consumed * 2 * Math.PI;
    const endX = cx + radius * Math.sin(angle);
    const endY = cy - radius * Math.cos(angle);
    const largeArc = percent > 0.5 ? 1 : 0;
    const sweepFlag = 0;  // Counter-clockwise
    return `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${endX} ${endY} Z`;
  }
  return '';
}

/**
 * Get color class based on time remaining
 * @param {number} remaining - Seconds remaining
 * @returns {string} CSS class name ('', 'warning', or 'critical')
 */
function getTimeColorClass(remaining) {
  if (remaining < 600) return 'critical';   // < 10 minutes
  if (remaining < 1800) return 'warning';   // < 30 minutes
  return '';
}

/**
 * Format seconds to human readable time string
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time (e.g., "11h 45m", "45m", "5m")
 */
function formatTimeForPie(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

/**
 * Render a pie chart HTML element
 * @param {number} remaining - Seconds remaining
 * @param {number} total - Total seconds (walltime)
 * @param {string} id - Unique ID prefix for elements
 * @param {Object} options - Optional settings
 * @param {number} options.radius - Circle radius (default 14)
 * @param {number} options.size - Viewbox size (default 36)
 * @param {string} options.sizeClass - Additional CSS class (e.g., 'time-pie-sm')
 * @returns {string} HTML string for pie chart
 */
function renderPieChart(remaining, total, id, options = {}) {
  const radius = options.radius || 14;
  const size = options.size || 36;
  const sizeClass = options.sizeClass || '';
  const cx = size / 2;
  const cy = size / 2;

  const percent = total > 0 ? Math.max(0, remaining / total) : 1;
  const colorClass = getTimeColorClass(remaining);
  const piePath = calcPiePath(percent, cx, cy, radius);

  return `
    <div class="time-pie ${sizeClass}">
      <svg viewBox="0 0 ${size} ${size}">
        <circle class="time-pie-bg" cx="${cx}" cy="${cy}" r="${radius}"/>
        <path class="time-pie-fill ${colorClass}" id="${id}-pie-fill" d="${piePath}"
          data-cx="${cx}" data-cy="${cy}" data-radius="${radius}"/>
      </svg>
      <span class="time-pie-text ${colorClass}" id="${id}-countdown-value">${formatTimeForPie(remaining)}</span>
    </div>
  `;
}

/**
 * Update an existing pie chart element
 * @param {string} id - ID prefix used when rendering
 * @param {number} remaining - Seconds remaining
 * @param {number} total - Total seconds (walltime)
 */
function updatePieChart(id, remaining, total) {
  const pieEl = document.getElementById(id + '-pie-fill');
  const valueEl = document.getElementById(id + '-countdown-value');

  if (!pieEl || !valueEl) return;

  const percent = total > 0 ? Math.max(0, remaining / total) : 0;
  const colorClass = getTimeColorClass(remaining);

  const cx = parseFloat(pieEl.dataset.cx) || 18;
  const cy = parseFloat(pieEl.dataset.cy) || 18;
  const radius = parseFloat(pieEl.dataset.radius) || 14;

  pieEl.setAttribute('d', calcPiePath(percent, cx, cy, radius));
  pieEl.className.baseVal = 'time-pie-fill' + (colorClass ? ' ' + colorClass : '');

  valueEl.textContent = formatTimeForPie(remaining);
  valueEl.className = 'time-pie-text' + (colorClass ? ' ' + colorClass : '');
}

// Export for module usage (if using modules) or attach to window for scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calcPiePath, getTimeColorClass, formatTimeForPie, renderPieChart, updatePieChart };
} else if (typeof window !== 'undefined') {
  window.PieChart = { calcPiePath, getTimeColorClass, formatTimeForPie, renderPieChart, updatePieChart };
}
