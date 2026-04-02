import { useState, useRef, useEffect, memo } from 'react';
import SVGTooltip from './SVGTooltip';

const DEFAULTS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

/**
 * Lightweight SVG pie/donut chart.
 * Replaces recharts PieChart, Pie, Cell, Legend, Tooltip, ResponsiveContainer.
 *
 * @param {Object[]} data - Array of { name, value, ... }
 * @param {string}   dataKey - Value key (default 'value')
 * @param {string}   nameKey - Label key (default 'name')
 * @param {Function} colorFn - (entry, index) => hexColor
 * @param {number}   height
 * @param {number}   innerRadius - 0 for pie, >0 for donut
 * @param {number}   outerRadius
 * @param {boolean}  showLabels
 * @param {boolean}  showLegend
 * @param {Function} formatTooltip - (value, name) => displayString
 */
export default memo(function SVGPieChart({
  data, dataKey = 'value', nameKey = 'name',
  colorFn, height = 300, innerRadius = 0, outerRadius = 100,
  showLabels = false, showLegend = true, formatTooltip,
}) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const legendH = showLegend ? 32 : 0;
  const svgH = height - legendH;
  const cx = width / 2;
  const cy = svgH / 2;

  if (!data.length || width <= 0)
    return <div ref={containerRef} style={{ width: '100%', height }} />;

  const total = data.reduce((s, d) => s + (Number(d[dataKey]) || 0), 0);
  if (total === 0)
    return <div ref={containerRef} style={{ width: '100%', height }} className="flex items-center justify-center text-slate-500">No data</div>;

  // Build arcs
  const arcs = [];
  let angle = -Math.PI / 2;
  const padAngle = 0.04; // ~2 degrees gap between segments
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i][dataKey]) || 0;
    const sweep = (v / total) * (2 * Math.PI) - padAngle;
    if (sweep <= 0) { angle += padAngle; continue; }
    const start = angle + padAngle / 2;
    const end = start + sweep;
    const fill = colorFn ? colorFn(data[i], i) : DEFAULTS[i % DEFAULTS.length];

    const x1o = cx + outerRadius * Math.cos(start);
    const y1o = cy + outerRadius * Math.sin(start);
    const x2o = cx + outerRadius * Math.cos(end);
    const y2o = cy + outerRadius * Math.sin(end);
    const large = sweep > Math.PI ? 1 : 0;

    let d;
    if (innerRadius > 0) {
      const x1i = cx + innerRadius * Math.cos(start);
      const y1i = cy + innerRadius * Math.sin(start);
      const x2i = cx + innerRadius * Math.cos(end);
      const y2i = cy + innerRadius * Math.sin(end);
      d = `M${x1o},${y1o}A${outerRadius},${outerRadius} 0 ${large} 1 ${x2o},${y2o}L${x2i},${y2i}A${innerRadius},${innerRadius} 0 ${large} 0 ${x1i},${y1i}Z`;
    } else {
      d = `M${cx},${cy}L${x1o},${y1o}A${outerRadius},${outerRadius} 0 ${large} 1 ${x2o},${y2o}Z`;
    }

    const midAngle = (start + end) / 2;
    arcs.push({ d, fill, midAngle, i, v, name: data[i][nameKey] });
    angle = start + sweep + padAngle / 2;
  }

  // Labels
  const labels = showLabels ? arcs.map(a => {
    const lx = cx + (outerRadius + 14) * Math.cos(a.midAngle);
    const ly = cy + (outerRadius + 14) * Math.sin(a.midAngle);
    const pct = total > 0 ? Math.round((a.v / total) * 100) : 0;
    return (
      <text key={`lbl${a.i}`} x={lx} y={ly} fill="#94a3b8" fontSize={11}
        textAnchor={a.midAngle > Math.PI / 2 && a.midAngle < 3 * Math.PI / 2 ? 'end' : 'start'}
        dominantBaseline="middle">
        {a.name} {pct}%
      </text>
    );
  }) : null;

  function onMouse(e, idx) {
    const rect = containerRef.current.getBoundingClientRect();
    setMouse({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (idx !== undefined) setHoverIdx(idx);
  }

  // Tooltip
  let tooltip = null;
  if (hoverIdx != null) {
    const arc = arcs.find(a => a.i === hoverIdx);
    if (arc) {
      tooltip = (
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: arc.fill }} />
            <span>{arc.name}</span>
          </div>
          <div className="mt-1">{formatTooltip ? formatTooltip(arc.v, arc.name) : arc.v}</div>
        </div>
      );
    }
  }

  return (
    <div ref={containerRef} className="relative" style={{ width: '100%' }}
      onMouseMove={(e) => onMouse(e)} onMouseLeave={() => setHoverIdx(null)}>
      <svg width={width} height={svgH} className="overflow-visible">
        {arcs.map(a => (
          <path key={a.i} d={a.d} fill={a.fill}
            opacity={hoverIdx != null && hoverIdx !== a.i ? 0.5 : 1}
            onMouseEnter={(e) => { setHoverIdx(a.i); onMouse(e); }}
            className="cursor-pointer transition-opacity"
          />
        ))}
        {labels}
      </svg>
      {showLegend && (
        <div className="flex flex-wrap gap-3 justify-center mt-1 text-xs text-slate-400">
          {arcs.map(a => (
            <span key={a.i} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: a.fill }} />
              {a.name}
            </span>
          ))}
        </div>
      )}
      <SVGTooltip x={mouse.x} y={mouse.y} content={tooltip} visible={hoverIdx != null} />
    </div>
  );
});
