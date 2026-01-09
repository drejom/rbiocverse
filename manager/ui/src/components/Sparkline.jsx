/**
 * Sparkline component for 24hr trend visualization
 * - Shape shows full 24hr pattern (all data points)
 * - Color shows recent trend (~3hr) for "should I launch now?" decision
 */

// Percentage point change threshold for trend coloring
const TREND_THRESHOLD = 5;

// Number of recent points to use for color (4 points @ 30min = ~2 hours)
// Analysis shows avg change of ~13% over 2hrs vs 10% over 1hr - good signal-to-noise
const RECENT_WINDOW = 4;

export function Sparkline({ data, width = 40, height = 12, className = '' }) {
  if (!data || data.length < 2) {
    return null;
  }

  // Normalize data to 0-100 range (percentages)
  const values = data.map(d => Math.min(100, Math.max(0, d)));
  const min = 0;
  const max = 100;
  const range = max - min || 1;

  // Calculate points for polyline (full 24hr shape)
  const points = values.map((val, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  // Determine trend color based on RECENT values (~3hr window)
  // This answers "is it getting better or worse right now?"
  const recentStart = Math.max(0, values.length - RECENT_WINDOW);
  const trend = values[values.length - 1] - values[recentStart];
  const strokeColor = trend > TREND_THRESHOLD ? 'var(--color-high)' :
                      trend < -TREND_THRESHOLD ? 'var(--color-low)' :
                      'var(--color-medium)';

  return (
    <svg
      className={`sparkline ${className}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}
