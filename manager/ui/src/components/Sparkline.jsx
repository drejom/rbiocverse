/**
 * Sparkline component for 24hr trend visualization
 * Renders a simple SVG line chart with gradient coloring
 * Each segment is colored based on direction: green (down), red (up), yellow (flat)
 */

// Threshold for considering a segment "flat" vs rising/falling
const FLAT_THRESHOLD = 2;

export function Sparkline({ data, width = 40, height = 12, className = '' }) {
  if (!data || data.length < 2) {
    return null;
  }

  // Normalize data to 0-100 range (percentages)
  const values = data.map(d => Math.min(100, Math.max(0, d)));
  const min = 0;
  const max = 100;
  const range = max - min || 1;

  // Calculate x,y coordinates for each point
  const points = values.map((val, i) => ({
    x: (i / (values.length - 1)) * width,
    y: height - ((val - min) / range) * height,
    value: val,
  }));

  // Build segments with colors based on direction
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const delta = p2.value - p1.value;

    // Color based on segment direction
    const color = delta > FLAT_THRESHOLD ? 'var(--color-high)' :    // rising = red
                  delta < -FLAT_THRESHOLD ? 'var(--color-low)' :    // falling = green
                  'var(--color-medium)';                             // flat = yellow

    segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color });
  }

  return (
    <svg
      className={`sparkline ${className}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {segments.map((seg, i) => (
        <line
          key={i}
          x1={seg.x1}
          y1={seg.y1}
          x2={seg.x2}
          y2={seg.y2}
          stroke={seg.color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
