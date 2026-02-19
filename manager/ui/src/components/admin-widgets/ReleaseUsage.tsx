/**
 * ReleaseUsage - Horizontal bar chart of Bioconductor version popularity
 */
import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { DateRangeSelector } from './DateRangeSelector';
import log from '../../lib/logger';

interface ReleaseData {
  version: string;
  sessions: number;
}

interface ReleaseUsageProps {
  getAuthHeader: () => Record<string, string>;
}

export function ReleaseUsage({ getAuthHeader }: ReleaseUsageProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<ReleaseData[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [days]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/releases?days=${days}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || []);
    } catch (err) {
      log.error('Failed to fetch release usage', { error: err });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data.length || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    // Limit to top 5 versions for consistent height
    const chartData = data.slice(0, 5);

    const margin = { top: 5, right: 40, bottom: 5, left: 50 };
    const width = 500 - margin.left - margin.right;
    const height = 110 - margin.top - margin.bottom;

    svg.attr('viewBox', `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Scales
    const maxSessions = d3.max(chartData, d => d.sessions) || 1;
    const x = d3.scaleLinear()
      .domain([0, maxSessions])
      .range([0, width]);

    const y = d3.scaleBand()
      .domain(chartData.map(d => d.version))
      .range([0, height])
      .padding(0.2);

    // Color scale: newer versions are greener
    const versions = chartData.map(d => d.version).sort();
    const colorScale = d3.scaleOrdinal<string>()
      .domain(versions)
      .range(d3.schemeGreens[Math.min(9, Math.max(3, versions.length))].slice().reverse());

    // Bars
    g.selectAll('.bar')
      .data(chartData)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('x', 0)
      .attr('y', d => y(d.version) || 0)
      .attr('width', d => x(d.sessions))
      .attr('height', y.bandwidth())
      .attr('fill', d => colorScale(d.version))
      .attr('rx', 3);

    // Labels (version names)
    g.selectAll('.version-label')
      .data(chartData)
      .enter()
      .append('text')
      .attr('class', 'version-label')
      .attr('x', -5)
      .attr('y', d => (y(d.version) || 0) + y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', 'end')
      .attr('font-size', '11px')
      .attr('fill', 'var(--text-primary)')
      .text(d => d.version);

    // Value labels
    g.selectAll('.value-label')
      .data(chartData)
      .enter()
      .append('text')
      .attr('class', 'value-label')
      .attr('x', d => x(d.sessions) + 5)
      .attr('y', d => (y(d.version) || 0) + y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .attr('font-size', '10px')
      .attr('fill', 'var(--text-muted)')
      .text(d => d.sessions);

  }, [data]);

  return (
    <div className="release-usage">
      <div className="chart-header">
        <h4>Bioconductor Versions</h4>
        <DateRangeSelector
          value={days}
          onChange={setDays}
          ranges={[
            { value: 30, label: '30d' },
            { value: 90, label: '90d' },
          ]}
        />
      </div>
      {loading ? (
        <div className="chart-loading">Loading...</div>
      ) : data.length === 0 ? (
        <div className="chart-empty">No data available</div>
      ) : (
        <svg ref={svgRef} className="release-chart" />
      )}
    </div>
  );
}
