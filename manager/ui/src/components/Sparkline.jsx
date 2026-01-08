/**
 * Sparkline component for 24hr trend visualization
 * Renders a simple SVG line chart
 */

export function Sparkline({ data, width = 40, height = 12, className = '' }) {
  if (!data || data.length < 2) {
    return null;
  }

  // Normalize data to 0-100 range (percentages)
  const values = data.map(d => Math.min(100, Math.max(0, d)));
  const min = 0;
  const max = 100;
  const range = max - min || 1;

  // Calculate points for polyline
  const points = values.map((val, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  // Determine trend color based on last vs first value
  const trend = values[values.length - 1] - values[0];
  const strokeColor = trend > 5 ? 'var(--color-high)' :
                      trend < -5 ? 'var(--color-low)' :
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

export default Sparkline;
