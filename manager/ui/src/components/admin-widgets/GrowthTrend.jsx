/**
 * GrowthTrend - Line chart of month-over-month growth
 */
import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';

export function GrowthTrend({ getAuthHeader }) {
  const svgRef = useRef(null);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/analytics/growth?months=12', {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || []);
    } catch (err) {
      console.error('Failed to fetch growth trend:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data.length || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 15, right: 40, bottom: 25, left: 35 };
    const width = 500 - margin.left - margin.right;
    const height = 110 - margin.top - margin.bottom;

    svg.attr('viewBox', `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Parse dates
    const parseMonth = d3.timeParse('%Y-%m');
    const parsedData = data.map(d => ({
      ...d,
      date: parseMonth(d.month),
    })).filter(d => d.date);

    // Scales
    const x = d3.scaleTime()
      .domain(d3.extent(parsedData, d => d.date))
      .range([0, width]);

    const maxSessions = d3.max(parsedData, d => d.sessions) || 1;
    const maxUsers = d3.max(parsedData, d => d.uniqueUsers) || 1;

    const ySessions = d3.scaleLinear()
      .domain([0, maxSessions * 1.1])
      .range([height, 0]);

    const yUsers = d3.scaleLinear()
      .domain([0, maxUsers * 1.1])
      .range([height, 0]);

    // Lines
    const sessionsLine = d3.line()
      .x(d => x(d.date))
      .y(d => ySessions(d.sessions))
      .curve(d3.curveMonotoneX);

    const usersLine = d3.line()
      .x(d => x(d.date))
      .y(d => yUsers(d.uniqueUsers))
      .curve(d3.curveMonotoneX);

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(6).tickFormat(d3.timeFormat('%b')))
      .selectAll('text')
      .attr('fill', 'var(--text-muted)')
      .attr('font-size', '10px');

    // Y axis (left - sessions)
    g.append('g')
      .call(d3.axisLeft(ySessions).ticks(5))
      .selectAll('text')
      .attr('fill', 'var(--text-muted)')
      .attr('font-size', '10px');

    // Y axis (right - users)
    g.append('g')
      .attr('transform', `translate(${width},0)`)
      .call(d3.axisRight(yUsers).ticks(5))
      .selectAll('text')
      .attr('fill', 'var(--text-muted)')
      .attr('font-size', '10px');

    // Sessions line
    g.append('path')
      .datum(parsedData)
      .attr('fill', 'none')
      .attr('stroke', 'var(--accent-primary)')
      .attr('stroke-width', 2)
      .attr('d', sessionsLine);

    // Users line
    g.append('path')
      .datum(parsedData)
      .attr('fill', 'none')
      .attr('stroke', '#F59E0B')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4,2')
      .attr('d', usersLine);

    // Dots
    g.selectAll('.dot-sessions')
      .data(parsedData)
      .enter()
      .append('circle')
      .attr('class', 'dot-sessions')
      .attr('cx', d => x(d.date))
      .attr('cy', d => ySessions(d.sessions))
      .attr('r', 3)
      .attr('fill', 'var(--accent-primary)');

    g.selectAll('.dot-users')
      .data(parsedData)
      .enter()
      .append('circle')
      .attr('class', 'dot-users')
      .attr('cx', d => x(d.date))
      .attr('cy', d => yUsers(d.uniqueUsers))
      .attr('r', 3)
      .attr('fill', '#F59E0B');

  }, [data]);

  return (
    <div className="growth-trend">
      <div className="chart-header">
        <h4>Monthly Growth</h4>
        <div className="growth-legend">
          <span className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: 'var(--accent-primary)' }} />
            Sessions
          </span>
          <span className="legend-item">
            <span className="legend-dot dashed" style={{ backgroundColor: '#F59E0B' }} />
            Users
          </span>
        </div>
      </div>
      {loading ? (
        <div className="chart-loading">Loading...</div>
      ) : data.length === 0 ? (
        <div className="chart-empty">No data available</div>
      ) : (
        <svg ref={svgRef} className="growth-chart" />
      )}
    </div>
  );
}
