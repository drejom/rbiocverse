/**
 * Time remaining pie chart component
 * Visual countdown display with warning/critical states
 * Pie empties clockwise from 12 o'clock as time runs out
 */
import { formatTime, getCountdownLevel } from '../hooks/useCountdown';

// SVG arc constants
const FULL_CIRCLE_OFFSET = 0.001;  // Small offset to avoid rendering issues with complete circles
const LARGE_ARC_THRESHOLD = 0.5;   // Threshold for SVG large-arc-flag (>50% uses large arc)

/**
 * Calculate SVG path for pie wedge (clockwise from 12 o'clock)
 * Arc fills counter-clockwise from 12 o'clock, so empty space grows clockwise (to the right)
 */
function calcPiePath(percent: number, cx: number, cy: number, radius: number): string {
  if (percent >= 1) {
    // Full circle - use two arcs to complete the circle
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - FULL_CIRCLE_OFFSET} ${cy - radius} Z`;
  } else if (percent > 0) {
    // Endpoint is where the consumed (empty) portion ends, going clockwise from 12
    const consumed = 1 - percent;
    const angle = consumed * 2 * Math.PI;
    const endX = cx + radius * Math.sin(angle);
    const endY = cy - radius * Math.cos(angle);
    const largeArc = percent > LARGE_ARC_THRESHOLD ? 1 : 0;
    const sweepFlag = 0;  // Counter-clockwise
    return `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${endX} ${endY} Z`;
  }
  return '';
}

interface TimePieProps {
  remaining: number;
  total: number;
  small?: boolean;
}

export function TimePie({ remaining, total, small = false }: TimePieProps) {
  const percent = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 1;
  const level = getCountdownLevel(remaining, total);
  const timeText = formatTime(remaining);

  // Use same dimensions as original: radius 14, viewbox 36
  const size = 36;
  const radius = 14;
  const cx = size / 2;
  const cy = size / 2;

  const piePath = calcPiePath(percent, cx, cy, radius);

  const sizeClass = small ? 'time-pie-sm' : '';
  const levelClass = level === 'critical' ? 'critical' : level === 'warning' ? 'warning' : '';

  return (
    <div className={`time-pie ${sizeClass}`}>
      <svg viewBox={`0 0 ${size} ${size}`}>
        <circle className="time-pie-bg" cx={cx} cy={cy} r={radius} />
        {piePath && (
          <path className={`time-pie-fill ${levelClass}`} d={piePath} />
        )}
      </svg>
      <span className={`time-pie-text ${levelClass}`}>{timeText}</span>
    </div>
  );
}

export default TimePie;
