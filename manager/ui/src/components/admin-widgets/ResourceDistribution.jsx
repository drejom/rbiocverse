/**
 * ResourceDistribution - Histograms for CPU, memory, and walltime requests
 */
import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { DateRangeSelector } from './DateRangeSelector';

export function ResourceDistribution({ getAuthHeader }) {
  const cpuRef = useRef(null);
  const [data, setData] = useState(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [days]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/resources?days=${days}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || null);
    } catch (err) {
      console.error('Failed to fetch resource distribution:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data?.cpuDistribution?.length || !cpuRef.current) return;

    const svg = d3.select(cpuRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 10, right: 20, bottom: 25, left: 35 };
    const width = 500 - margin.left - margin.right;
    const height = 110 - margin.top - margin.bottom;

    svg.attr('viewBox', `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const cpuData = data.cpuDistribution;

    // Scales
    const x = d3.scaleBand()
      .domain(cpuData.map(d => d.cpus))
      .range([0, width])
      .padding(0.1);

    const y = d3.scaleLinear()
      .domain([0, d3.max(cpuData, d => d.count)])
      .nice()
      .range([height, 0]);

    // Bars
    g.selectAll('.bar')
      .data(cpuData)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('x', d => x(d.cpus))
      .attr('y', d => y(d.count))
      .attr('width', x.bandwidth())
      .attr('height', d => height - y(d.count))
      .attr('fill', 'var(--accent-primary)')
      .attr('rx', 2);

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).tickValues(cpuData.filter((d, i) => i % 2 === 0 || cpuData.length <= 8).map(d => d.cpus)))
      .selectAll('text')
      .attr('font-size', '9px')
      .attr('fill', 'var(--text-muted)');

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(4))
      .selectAll('text')
      .attr('font-size', '9px')
      .attr('fill', 'var(--text-muted)');

    // Remove domain lines
    g.selectAll('.domain').attr('stroke', 'var(--border-subtle)');
    g.selectAll('.tick line').attr('stroke', 'var(--border-subtle)');

  }, [data]);

  const formatMemory = (patterns) => {
    if (!patterns?.length) return 'N/A';
    return patterns.slice(0, 3).map(p => p.memory).join(', ');
  };

  return (
    <div className="resource-distribution">
      <div className="chart-header">
        <h4>Resource Requests</h4>
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
      ) : (
        <div className="resource-stats">
          <div className="resource-chart-section">
            <div className="resource-label">CPU Distribution</div>
            <svg ref={cpuRef} className="resource-chart" />
          </div>
          <div className="resource-summary">
            <div className="stat-row">
              <span className="stat-label">Avg CPUs:</span>
              <span className="stat-value">{data.avgCpus?.toFixed(1) || 'N/A'}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">CPU Range:</span>
              <span className="stat-value">{data.minCpus || 0} - {data.maxCpus || 0}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Top Memory:</span>
              <span className="stat-value">{formatMemory(data.memoryPatterns)}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Avg Duration:</span>
              <span className="stat-value">{data.avgDurationMinutes ? `${Math.round(data.avgDurationMinutes)} min` : 'N/A'}</span>
            </div>
            {data.gpuUsage?.length > 0 && (
              <div className="stat-row">
                <span className="stat-label">GPU Usage:</span>
                <span className="stat-value">{data.gpuUsage.map(g => `${g.gpu}: ${g.count}`).join(', ')}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
