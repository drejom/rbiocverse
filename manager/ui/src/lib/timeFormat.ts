/**
 * Time formatting utilities
 */

/**
 * Format estimated start time in human-friendly way
 * Shows relative time like "in 2h 30m" or date for longer waits
 */
export function formatEstimatedStart(isoTime: string): string {
  const startDate = new Date(isoTime);
  const now = new Date();
  const diffMs = startDate.getTime() - now.getTime();

  if (diffMs < 0) {
    return 'soon';
  }

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const remainingMins = diffMins % 60;

  if (diffHours < 1) {
    return `in ${diffMins}m`;
  } else if (diffHours < 24) {
    return remainingMins > 0 ? `in ${diffHours}h ${remainingMins}m` : `in ${diffHours}h`;
  } else {
    // Show date/time for longer waits
    return startDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }
}
