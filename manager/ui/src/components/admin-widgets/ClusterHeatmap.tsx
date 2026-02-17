/**
 * ClusterHeatmap - GitHub-style utilization heatmap for cluster health
 * Rolling 12 months from today
 */
import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { renderHeatmap, HeatmapLegend } from './heatmapUtils';

interface HeatmapData {
  date: string;
  avgCpus: number;
  maxCpus: number;
  avgMemory: number;
  avgNodes: number;
  avgA100?: number;
  avgV100?: number;
  totalRunning: number;
  totalPending: number;
}

type MetricKey = 'avgCpus' | 'maxCpus' | 'avgMemory' | 'avgNodes' | 'avgA100' | 'avgV100' | 'totalRunning' | 'totalPending';

interface ClusterHeatmapProps {
  getAuthHeader: () => Record<string, string>;
  hpc?: string;
  data?: HeatmapData[];
}

export function ClusterHeatmap({ getAuthHeader, hpc = 'gemini', data: externalData }: ClusterHeatmapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<HeatmapData[]>(externalData || []);
  const [metric, setMetric] = useState<MetricKey>('avgCpus');
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
  }, [hpc, externalData, getAuthHeader]);

  useEffect(() => {
    if (!data.length || !svgRef.current || !tooltipRef.current) return;

    const dateMap = new Map(data.map(d => [d.date, d]));
    // Color scale for utilization (0-100%) - inverted: green = low, red = high
    const colorScale = d3.scaleSequential(d3.interpolateRdYlGn).domain([100, 0]);

    renderHeatmap(svgRef.current, {
      dateMap,
      colorScale,
      getValue: (dayData) => dayData[metric] ?? 0,
      getTooltipHtml: (date, dayData) => {
        let html = `<strong>${date.toLocaleDateString()}</strong><br/>
          CPU: ${dayData?.avgCpus || 0}% (max: ${dayData?.maxCpus || 0}%)<br/>`;
        if (hpc === 'gemini' && (dayData?.avgA100 !== null || dayData?.avgV100 !== null)) {
          html += `A100: ${dayData?.avgA100 ?? 'N/A'}%<br/>`;
          html += `V100: ${dayData?.avgV100 ?? 'N/A'}%<br/>`;
        }
        html += `Memory: ${dayData?.avgMemory || 0}%<br/>
          Jobs: ${dayData?.totalRunning || 0} running, ${dayData?.totalPending || 0} pending`;
        return html;
      },
      tooltipElement: d3.select(tooltipRef.current),
    });
  }, [data, metric, hpc]);

  // Build metrics list - include GPU partitions only for Gemini
  const baseMetrics: { value: MetricKey; label: string }[] = [
    { value: 'avgCpus', label: 'CPU' },
  ];

  // Add GPU partition metrics for Gemini only
  if (hpc === 'gemini') {
    baseMetrics.push(
      { value: 'avgA100', label: 'A100' },
      { value: 'avgV100', label: 'V100' }
    );
  }

  baseMetrics.push(
    { value: 'avgMemory', label: 'Memory' },
    { value: 'avgNodes', label: 'Nodes' }
  );

  const metrics = baseMetrics;

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
