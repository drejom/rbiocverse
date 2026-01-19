/**
 * SessionHeatmap - GitHub-style activity heatmap for session launches
 * Rolling 12 months from today
 */
import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { renderHeatmap, HeatmapLegend } from './heatmapUtils.jsx';

export function SessionHeatmap({ getAuthHeader }) {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/analytics/heatmap/sessions?days=365`, {
          headers: getAuthHeader(),
        });
        const json = await res.json();
        setData(json.data || []);
      } catch (err) {
        console.error('Failed to fetch session heatmap:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (!data.length || !svgRef.current || !tooltipRef.current) return;

    const dateMap = new Map(data.map(d => [d.date, d]));
    const maxSessions = d3.max(data, d => d.sessions) || 1;
    const colorScale = d3.scaleSequential(d3.interpolateGreens).domain([0, maxSessions]);

    renderHeatmap(svgRef.current, {
      dateMap,
      colorScale,
      getValue: (dayData) => dayData.sessions,
      getTooltipHtml: (date, dayData) => {
        const sessions = dayData?.sessions || 0;
        const users = dayData?.uniqueUsers || 0;
        return `
          <strong>${date.toLocaleDateString()}</strong><br/>
          ${sessions} session${sessions !== 1 ? 's' : ''}<br/>
          ${users} user${users !== 1 ? 's' : ''}
        `;
      },
      tooltipElement: d3.select(tooltipRef.current),
    });
  }, [data]);

  return (
    <div className="session-heatmap">
      <div className="heatmap-header">
        <h4>Session Activity</h4>
      </div>
      {loading ? (
        <div className="heatmap-loading">Loading...</div>
      ) : (
        <div className="heatmap-container-inline">
          <div className="heatmap-chart">
            <svg ref={svgRef} className="heatmap-svg" />
          </div>
          <HeatmapLegend colorInterpolator={d3.interpolateGreens} />
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
