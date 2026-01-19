/**
 * FeatureUsage - Bar chart showing Shiny and Live Server usage rates
 */
import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { DateRangeSelector } from './DateRangeSelector';

export function FeatureUsage({ getAuthHeader }) {
  const svgRef = useRef(null);
  const [data, setData] = useState(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [days]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/features?days=${days}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || null);
    } catch (err) {
      console.error('Failed to fetch feature usage:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 10, right: 50, bottom: 10, left: 80 };
    const width = 500 - margin.left - margin.right;
    const height = 110 - margin.top - margin.bottom;

    svg.attr('viewBox', `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const features = [
      { name: 'Shiny', percent: data.shiny?.percent || 0, count: data.shiny?.count || 0 },
      { name: 'Live Server', percent: data.liveServer?.percent || 0, count: data.liveServer?.count || 0 },
    ];

    // Scales
    const x = d3.scaleLinear()
      .domain([0, 100])
      .range([0, width]);

    const y = d3.scaleBand()
      .domain(features.map(d => d.name))
      .range([0, height])
      .padding(0.3);

    // Background bars (100%)
    g.selectAll('.bar-bg')
      .data(features)
      .enter()
      .append('rect')
      .attr('class', 'bar-bg')
      .attr('x', 0)
      .attr('y', d => y(d.name))
      .attr('width', width)
      .attr('height', y.bandwidth())
      .attr('fill', 'var(--bg-elevated)')
      .attr('rx', 3);

    // Filled bars
    g.selectAll('.bar')
      .data(features)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('x', 0)
      .attr('y', d => y(d.name))
      .attr('width', d => x(d.percent))
      .attr('height', y.bandwidth())
      .attr('fill', (d, i) => i === 0 ? 'var(--status-success)' : 'var(--accent-primary)')
      .attr('rx', 3);

    // Labels (feature names)
    g.selectAll('.label')
      .data(features)
      .enter()
      .append('text')
      .attr('class', 'label')
      .attr('x', -5)
      .attr('y', d => y(d.name) + y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', 'end')
      .attr('font-size', '11px')
      .attr('fill', 'var(--text-primary)')
      .text(d => d.name);

    // Percentage labels
    g.selectAll('.percent-label')
      .data(features)
      .enter()
      .append('text')
      .attr('class', 'percent-label')
      .attr('x', width + 5)
      .attr('y', d => y(d.name) + y.bandwidth() / 2)
      .attr('dy', '0.35em')
      .attr('font-size', '10px')
      .attr('fill', 'var(--text-muted)')
      .text(d => `${d.percent}%`);

  }, [data]);

  return (
    <div className="feature-usage">
      <div className="chart-header">
        <h4>VS Code Features</h4>
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
      ) : !data ? (
        <div className="chart-empty">No data available</div>
      ) : data.vscodeTotal === 0 ? (
        <div className="chart-empty">No VS Code sessions in period</div>
      ) : (
        <>
          <svg ref={svgRef} className="feature-chart" />
          <div className="feature-note">
            Based on {data.vscodeTotal} VS Code session{data.vscodeTotal !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </div>
  );
}
