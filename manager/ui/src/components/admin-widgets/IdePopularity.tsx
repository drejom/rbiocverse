/**
 * IdePopularity - Donut chart of IDE usage
 */
import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { DateRangeSelector } from './DateRangeSelector';

const IDE_COLORS: Record<string, string> = {
  vscode: '#007ACC',
  rstudio: '#75AADB',
  jupyter: '#F37626',
};

const IDE_LABELS: Record<string, string> = {
  vscode: 'VS Code',
  rstudio: 'RStudio',
  jupyter: 'Jupyter',
};

interface IdeData {
  ide: string;
  sessions: number;
}

interface IdePopularityProps {
  getAuthHeader: () => Record<string, string>;
}

export function IdePopularity({ getAuthHeader }: IdePopularityProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<IdeData[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [days]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/ides?days=${days}`, {
        headers: getAuthHeader(),
      });
      const json = await res.json();
      setData(json.data || []);
    } catch (err) {
      console.error('Failed to fetch IDE popularity:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data.length || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = 220;
    const height = 110;
    const radius = Math.min(width, height) / 2 - 5;
    const innerRadius = radius * 0.55;

    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg.append('g')
      .attr('transform', `translate(${width / 2},${height / 2})`);

    // Pie generator
    const pie = d3.pie<IdeData>()
      .value(d => d.sessions)
      .sort(null);

    const arc = d3.arc<d3.PieArcDatum<IdeData>>()
      .innerRadius(innerRadius)
      .outerRadius(radius)
      .cornerRadius(3);

    // Total sessions for center label
    const totalSessions = d3.sum(data, d => d.sessions);

    // Draw arcs
    const arcs = g.selectAll('.arc')
      .data(pie(data))
      .enter()
      .append('g')
      .attr('class', 'arc');

    arcs.append('path')
      .attr('d', arc)
      .attr('fill', d => IDE_COLORS[d.data.ide] || 'var(--accent-primary)')
      .style('stroke', 'var(--bg-card)')
      .style('stroke-width', 2);

    // Center text
    g.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '-0.2em')
      .attr('font-size', '24px')
      .attr('font-weight', '600')
      .attr('fill', 'var(--text-primary)')
      .text(totalSessions);

    g.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '1.2em')
      .attr('font-size', '11px')
      .attr('fill', 'var(--text-muted)')
      .text('sessions');

  }, [data]);

  const totalSessions = d3.sum(data, d => d.sessions);

  return (
    <div className="ide-popularity">
      <div className="chart-header">
        <h4>IDE Usage</h4>
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
        <>
          <svg ref={svgRef} className="ide-chart" />
          <div className="ide-legend">
            {data.map(d => (
              <div key={d.ide} className="legend-item">
                <div
                  className="legend-color"
                  style={{ backgroundColor: IDE_COLORS[d.ide] || 'var(--accent-primary)' }}
                />
                <span className="legend-label">{IDE_LABELS[d.ide] || d.ide}</span>
                <span className="legend-value">
                  {d.sessions} ({totalSessions > 0 ? Math.round((d.sessions / totalSessions) * 100) : 0}%)
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
