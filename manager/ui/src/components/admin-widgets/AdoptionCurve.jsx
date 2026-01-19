/**
 * AdoptionCurve - Line chart showing cumulative user adoption for a release
 */
import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';

export function AdoptionCurve({ getAuthHeader, version }) {
  const svgRef = useRef(null);
  const [data, setData] = useState([]);
  const [versions, setVersions] = useState([]);
  const [selectedVersion, setSelectedVersion] = useState(version || '');
  const [loading, setLoading] = useState(true);

  // Fetch available versions
  useEffect(() => {
    const fetchVersions = async () => {
      try {
        const res = await fetch('/api/admin/analytics/releases?days=365', {
          headers: getAuthHeader(),
        });
        const json = await res.json();
        const versionList = (json.data || []).map(d => d.version).filter(Boolean);
        setVersions(versionList);
        if (!selectedVersion && versionList.length > 0) {
          setSelectedVersion(versionList[0]);
        }
      } catch (err) {
        console.error('Failed to fetch versions:', err);
      }
    };
    fetchVersions();
  }, []);

  // Fetch adoption data for selected version
  useEffect(() => {
    if (!selectedVersion) return;
    fetchData();
  }, [selectedVersion]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/adoption/${encodeURIComponent(selectedVersion)}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || []);
    } catch (err) {
      console.error('Failed to fetch adoption curve:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data.length || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 10, right: 20, bottom: 25, left: 35 };
    const width = 500 - margin.left - margin.right;
    const height = 110 - margin.top - margin.bottom;

    svg.attr('viewBox', `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Parse dates
    const parseDate = d3.timeParse('%Y-%m-%d');
    const chartData = data.map(d => ({
      date: parseDate(d.date),
      users: d.cumulativeUsers,
    })).filter(d => d.date);

    if (chartData.length === 0) return;

    // Scales
    const x = d3.scaleTime()
      .domain(d3.extent(chartData, d => d.date))
      .range([0, width]);

    const y = d3.scaleLinear()
      .domain([0, d3.max(chartData, d => d.users)])
      .nice()
      .range([height, 0]);

    // Area
    const area = d3.area()
      .x(d => x(d.date))
      .y0(height)
      .y1(d => y(d.users))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(chartData)
      .attr('fill', 'var(--accent-primary)')
      .attr('fill-opacity', 0.2)
      .attr('d', area);

    // Line
    const line = d3.line()
      .x(d => x(d.date))
      .y(d => y(d.users))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(chartData)
      .attr('fill', 'none')
      .attr('stroke', 'var(--accent-primary)')
      .attr('stroke-width', 2)
      .attr('d', line);

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(d3.timeFormat('%b %d')))
      .selectAll('text')
      .attr('font-size', '9px')
      .attr('fill', 'var(--text-muted)');

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(4))
      .selectAll('text')
      .attr('font-size', '9px')
      .attr('fill', 'var(--text-muted)');

    // Style axis lines
    g.selectAll('.domain').attr('stroke', 'var(--border-subtle)');
    g.selectAll('.tick line').attr('stroke', 'var(--border-subtle)');

  }, [data]);

  const totalUsers = data.length > 0 ? data[data.length - 1]?.cumulativeUsers || 0 : 0;

  return (
    <div className="adoption-curve">
      <div className="chart-header">
        <h4>Release Adoption</h4>
        {versions.length > 0 && (
          <select
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(e.target.value)}
            className="version-selector"
          >
            {versions.map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        )}
      </div>
      {loading ? (
        <div className="chart-loading">Loading...</div>
      ) : data.length === 0 ? (
        <div className="chart-empty">No adoption data for {selectedVersion}</div>
      ) : (
        <>
          <svg ref={svgRef} className="adoption-chart" />
          <div className="adoption-summary">
            {totalUsers} user{totalUsers !== 1 ? 's' : ''} adopted {selectedVersion}
          </div>
        </>
      )}
    </div>
  );
}
