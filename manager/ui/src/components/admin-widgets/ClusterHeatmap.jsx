/**
 * ClusterHeatmap - GitHub-style utilization heatmap for cluster health
 * Rolling 12 months from today
 */
import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { renderHeatmap, HeatmapLegend } from './heatmapUtils.jsx';

export function ClusterHeatmap({ getAuthHeader, hpc = 'gemini', data: externalData }) {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  const [data, setData] = useState(externalData || []);
  const [metric, setMetric] = useState('avgCpus');
  const [loading, setLoading] = useState(!externalData);

  // Only fetch if no external data provided
  useEffect(() => {
    if (externalData) {
      setData(externalData);
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/analytics/heatmap/cluster/${hpc}?days=365`, {
          headers: getAuthHeader(),
        });
        const json = await res.json();
        setData(json.data || []);
      } catch (err) {
        console.error('Failed to fetch cluster heatmap:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [hpc, externalData]);

  useEffect(() => {
    if (!data.length || !svgRef.current || !tooltipRef.current) return;

    const dateMap = new Map(data.map(d => [d.date, d]));
    // Color scale for utilization (0-100%) - inverted: green = low, red = high
    const colorScale = d3.scaleSequential(d3.interpolateRdYlGn).domain([100, 0]);

    renderHeatmap(svgRef.current, {
      dateMap,
      colorScale,
      getValue: (dayData) => dayData[metric] || 0,
      getTooltipHtml: (date, dayData) => `
        <strong>${date.toLocaleDateString()}</strong><br/>
        CPU: ${dayData?.avgCpus || 0}% (max: ${dayData?.maxCpus || 0}%)<br/>
        Memory: ${dayData?.avgMemory || 0}%<br/>
        Jobs: ${dayData?.totalRunning || 0} running, ${dayData?.totalPending || 0} pending
      `,
      tooltipElement: d3.select(tooltipRef.current),
    });
  }, [data, metric]);

  const metrics = [
    { value: 'avgCpus', label: 'CPU' },
    { value: 'avgMemory', label: 'Memory' },
    { value: 'avgNodes', label: 'Nodes' },
  ];

  return (
    <div className="cluster-heatmap">
      <div className="heatmap-header">
        <h4>{hpc.charAt(0).toUpperCase() + hpc.slice(1)} Utilization</h4>
        <div className="metric-selector">
          {metrics.map(m => (
            <button
              key={m.value}
              className={`metric-btn ${metric === m.value ? 'active' : ''}`}
              onClick={() => setMetric(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="heatmap-loading">Loading...</div>
      ) : (
        <div className="heatmap-container-inline">
          <div className="heatmap-chart">
            <svg ref={svgRef} className="heatmap-svg" />
          </div>
          <HeatmapLegend
            colorInterpolator={d3.interpolateRdYlGn}
            invert={true}
            lowLabel="Low"
            highLabel="High"
          />
          <div
            ref={tooltipRef}
            className="heatmap-tooltip"
            style={{
              position: 'fixed',
              opacity: 0,
              pointerEvents: 'none',
              background: 'var(--bg-card)',
              padding: '8px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              zIndex: 1000,
            }}
          />
        </div>
      )}
    </div>
  );
}
