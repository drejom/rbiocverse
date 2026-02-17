/**
 * Time parsing and formatting utilities
 * Pure functions with zero dependencies
 */

/**
 * Parse time string to seconds
 * Handles: "HH:MM:SS", "D-HH:MM:SS", "MM:SS" (SLURM short format)
 * @param {string} timeStr - Time string from SLURM
 * @returns {number|null} Total seconds, or null if invalid
 */
function parseTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');

  // MM:SS format (SLURM uses this when time < 1 hour)
  if (parts.length === 2) {
    const [m, s] = parts;
    return parseInt(m) * 60 + parseInt(s);
  }

  // HH:MM:SS or D-HH:MM:SS format
  if (parts.length === 3) {
    const [h, m, s] = parts;
    // Check for days (D-HH:MM:SS)
    if (h.includes('-')) {
      const [days, hours] = h.split('-');
      return parseInt(days) * 86400 + parseInt(hours) * 3600 + parseInt(m) * 60 + parseInt(s);
    }
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
  }
  return null;
}

/**
 * Format seconds to human-readable time (11h 45m)
 * @param {number} seconds - Total seconds
 * @returns {string} Formatted time string
 */
function formatHumanTime(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Calculate remaining time for a job
 * @param {string|Date} startedAt - When job started
 * @param {string} walltime - Job walltime in HH:MM:SS format
 * @returns {string|null} Remaining time in HH:MM:SS format, or null if invalid
 */
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

module.exports = {
  parseTimeToSeconds,
  formatHumanTime,
  calculateRemainingTime,
};
