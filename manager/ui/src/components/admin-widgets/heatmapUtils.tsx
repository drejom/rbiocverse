/**
 * Shared heatmap rendering utilities
 */
import * as d3 from 'd3';

const CELL_SIZE = 11;
const CELL_PADDING = 2;
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface HeatmapOptions<T> {
  dateMap: Map<string, T>;
  colorScale: (value: number) => string;
  getValue: (dayData: T) => number;
  getTooltipHtml: (date: Date, dayData: T | undefined) => string;
  tooltipElement: d3.Selection<HTMLDivElement, unknown, null, undefined>;
}

/**
 * Render a GitHub-style heatmap
 */
// eslint-disable-next-line react-refresh/only-export-components
export function renderHeatmap<T>(svgElement: SVGElement, options: HeatmapOptions<T>): void {
  const { dateMap, colorScale, getValue, getTooltipHtml, tooltipElement } = options;

  const svg = d3.select(svgElement);
  svg.selectAll('*').remove();

  const width = 53 * (CELL_SIZE + CELL_PADDING) + 20;
  const height = 7 * (CELL_SIZE + CELL_PADDING) + 20;

  svg.attr('viewBox', `0 0 ${width} ${height}`);

  // Generate all days in range (rolling 12 months)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 365);

  const allDays: Date[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    allDays.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  // Day labels - S/M/T/W/T/F/S
  svg.selectAll('.day-label')
    .data(DAY_LABELS)
    .enter()
    .append('text')
    .attr('class', 'day-label')
    .attr('x', 0)
    .attr('y', (_d, i) => 17 + i * (CELL_SIZE + CELL_PADDING))
    .attr('font-size', '9px')
    .attr('fill', 'var(--text-muted)')
    .text(d => d);

  // Calculate week offset
  const firstDay = allDays[0];
  const weekOffset = firstDay.getDay();

  // Draw cells
  svg.selectAll('.day')
    .data(allDays)
    .enter()
    .append('rect')
    .attr('class', 'day')
    .attr('x', (_d, i) => {
      const dayOfYear = i + weekOffset;
      const week = Math.floor(dayOfYear / 7);
      return 15 + week * (CELL_SIZE + CELL_PADDING);
    })
    .attr('y', (d) => {
      const dayOfWeek = d.getDay();
      return 10 + dayOfWeek * (CELL_SIZE + CELL_PADDING);
    })
    .attr('width', CELL_SIZE)
    .attr('height', CELL_SIZE)
    .attr('rx', 2)
    .attr('fill', (d) => {
      const dateStr = d.toISOString().split('T')[0];
      const dayData = dateMap.get(dateStr);
      if (!dayData) return 'var(--bg-elevated)';
      const value = getValue(dayData);
      return colorScale(value);
    })
    .style('cursor', 'pointer')
    .on('mouseover', (event: MouseEvent, d: Date) => {
      const dateStr = d.toISOString().split('T')[0];
      const dayData = dateMap.get(dateStr);

      tooltipElement
        .style('opacity', '1')
        .style('left', `${event.pageX + 10}px`)
        .style('top', `${event.pageY - 10}px`)
        .html(getTooltipHtml(d, dayData));
    })
    .on('mouseout', () => {
      tooltipElement.style('opacity', '0');
    });

  // Month labels
  interface MonthLabel {
    month: string;
    x: number;
  }
  const months: MonthLabel[] = [];
  allDays.forEach((d, i) => {
    if (d.getDate() === 1 || i === 0) {
      const dayOfYear = i + weekOffset;
      const week = Math.floor(dayOfYear / 7);
      months.push({
        month: d.toLocaleString('default', { month: 'short' }),
        x: 15 + week * (CELL_SIZE + CELL_PADDING),
      });
    }
  });

  svg.selectAll('.month-label')
    .data(months)
    .enter()
    .append('text')
    .attr('class', 'month-label')
    .attr('x', d => d.x)
    .attr('y', 7)
    .attr('font-size', '9px')
    .attr('fill', 'var(--text-muted)')
    .text(d => d.month);
}

interface HeatmapLegendProps {
  steps?: number[];
  colorInterpolator: (t: number) => string;
  invert?: boolean;
  lowLabel?: string;
  highLabel?: string;
}

/**
 * Render heatmap legend cells
 */
export function HeatmapLegend({
  steps = [0, 0.25, 0.5, 0.75, 1],
  colorInterpolator,
  invert = false,
  lowLabel = 'Less',
  highLabel = 'More'
}: HeatmapLegendProps) {
  return (
    <div className="heatmap-legend-inline">
      <span>{lowLabel}</span>
      {steps.map(v => (
        <div
          key={v}
          className="legend-cell"
          style={{
            backgroundColor: v === 0 ? 'var(--bg-elevated)' : colorInterpolator(invert ? 1 - v : v),
            width: CELL_SIZE,
            height: CELL_SIZE,
            borderRadius: 2,
          }}
        />
      ))}
      <span>{highLabel}</span>
    </div>
  );
}
