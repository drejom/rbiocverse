/**
 * Shared heatmap rendering utilities
 */
import * as d3 from 'd3';

const CELL_SIZE = 11;
const CELL_PADDING = 2;
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * Render a GitHub-style heatmap
 * @param {SVGElement} svgElement - The SVG element to render into
 * @param {Object} options - Configuration options
 * @param {Map} options.dateMap - Map of date strings to data objects
 * @param {Function} options.colorScale - D3 color scale function
 * @param {Function} options.getValue - Function to extract value from day data
 * @param {Function} options.getTooltipHtml - Function to generate tooltip HTML
 * @param {Object} options.tooltipElement - Tooltip DOM element (d3 selection)
 */
export function renderHeatmap(svgElement, options) {
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

  const allDays = [];
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
    .attr('y', (d, i) => 17 + i * (CELL_SIZE + CELL_PADDING))
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
    .attr('x', (d, i) => {
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
    .on('mouseover', (event, d) => {
      const dateStr = d.toISOString().split('T')[0];
      const dayData = dateMap.get(dateStr);

      tooltipElement
        .style('opacity', 1)
        .style('left', `${event.pageX + 10}px`)
        .style('top', `${event.pageY - 10}px`)
        .html(getTooltipHtml(d, dayData));
    })
    .on('mouseout', () => {
      tooltipElement.style('opacity', 0);
    });

  // Month labels
  const months = [];
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

/**
 * Render heatmap legend cells
 * @param {Array} steps - Array of values 0-1 for color interpolation
 * @param {Function} colorInterpolator - D3 color interpolator function
 * @param {boolean} invert - Invert the color scale
 */
export function HeatmapLegend({ steps = [0, 0.25, 0.5, 0.75, 1], colorInterpolator, invert = false, lowLabel = 'Less', highLabel = 'More' }) {
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
