/**
 * Time parsing and formatting utilities
 * Pure functions with zero dependencies
 */

/**
 * Parse time string to seconds
 * Handles: "HH:MM:SS", "D-HH:MM:SS", "MM:SS" (SLURM short format)
 * @param timeStr - Time string from SLURM
 * @returns Total seconds, or null if invalid
 */
export function parseTimeToSeconds(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(':');

  // MM:SS format (SLURM uses this when time < 1 hour)
  if (parts.length === 2) {
    const [m, s] = parts;
    return parseInt(m, 10) * 60 + parseInt(s, 10);
  }

  // HH:MM:SS or D-HH:MM:SS format
  if (parts.length === 3) {
    const [h, m, s] = parts;
    // Check for days (D-HH:MM:SS)
    if (h.includes('-')) {
      const [days, hours] = h.split('-');
      return parseInt(days, 10) * 86400 + parseInt(hours, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10);
    }
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10);
  }
  return null;
}

/**
 * Format seconds to human-readable time (11h 45m)
 * @param seconds - Total seconds
 * @returns Formatted time string
 */
export function formatHumanTime(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Calculate remaining time for a job
 * @param startedAt - When job started
 * @param walltime - Job walltime in HH:MM:SS format
 * @returns Remaining time in HH:MM:SS format, or null if invalid
 */
export function calculateRemainingTime(
  startedAt: string | Date | null | undefined,
  walltime: string | null | undefined
): string | null {
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

// CommonJS compatibility for existing require() calls
module.exports = { parseTimeToSeconds, formatHumanTime, calculateRemainingTime };
