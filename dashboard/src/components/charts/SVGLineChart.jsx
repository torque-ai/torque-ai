import { useState, useRef, useEffect, useMemo, memo } from 'react';
import SVGTooltip from './SVGTooltip';

const PAD = { top: 10, right: 20, bottom: 28, left: 50 };

function niceMax(v) { return v > 0 ? v * 1.1 : 1; }

/** Catmull-Rom spline: convert points to a smooth SVG path string. */
function catmullRomPath(pts, tension = 0.5) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y}L${pts[1].x},${pts[1].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / (6 / tension);
    const cp1y = p1.y + (p2.y - p0.y) / (6 / tension);
    const cp2x = p2.x - (p3.x - p1.x) / (6 / tension);
    const cp2y = p2.y - (p3.y - p1.y) / (6 / tension);
    d += `C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/**
 * Lightweight SVG line/area chart. Replaces recharts LineChart, AreaChart,
 * Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend.
 *
 * @param {Object[]} data - Array of data objects
 * @param {Object[]} lines - Series config: { dataKey, color, name?, fill?, fillOpacity?, stackId?, connectNulls?, dot? }
 * @param {string}   xKey - Key for X axis values (default 'date')
 * @param {number}   height - Chart height in px
 * @param {Function} formatX - (rawValue) => displayString for X labels
 * @param {Function} formatY - (number) => displayString for Y labels
 * @param {Function} formatTooltip - (value, seriesName) => displayString
 * @param {number[]} yDomain - [min, max] override
 * @param {boolean}  showLegend
 * @param {Function} legendFormatter - (seriesName) => displayName
 */
export default memo(function SVGLineChart({
  data, lines, xKey = 'date', height = 300,
  formatX, formatY, formatTooltip, yDomain,
  showLegend = false, legendFormatter, smooth = false,
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

  const legendH = showLegend ? 24 : 0;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom - legendH;

  // Compute stacked values and Y range
  const { rows, yMin, yMax } = useMemo(() => {
    if (!data.length || !lines.length) return { rows: data, yMin: 0, yMax: 1 };
    const hasStack = lines.some(l => l.stackId);
    let vals = [];

    const rows = data.map(d => {
      const r = { ...d };
      if (hasStack) {
        let cum = 0;
        r._s = {};
        for (const l of lines) {
          const v = Number(d[l.dataKey]) || 0;
          if (l.stackId) {
            r._s[l.dataKey] = { base: cum, top: cum + v };
            cum += v;
          }
        }
        vals.push(cum);
      }
      return r;
    });

    for (const l of lines) {
      if (!hasStack || !l.stackId) {
        for (const d of data) {
          const v = Number(d[l.dataKey]);
          if (!isNaN(v)) vals.push(v);
        }
      }
    }

    return {
      rows,
      yMin: yDomain ? yDomain[0] : (vals.length ? Math.min(0, ...vals) : 0),
      yMax: yDomain ? yDomain[1] : (vals.length ? niceMax(Math.max(...vals)) : 1),
    };
  }, [data, lines, yDomain]);

  if (!data.length || plotW <= 0)
    return <div ref={containerRef} style={{ width: '100%', height }} />;

  const n = data.length;
  const xOf = i => PAD.left + (i / Math.max(n - 1, 1)) * plotW;
  const yOf = v => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  // Grid + axes
  const ticks = 5;
  const grid = [];
  for (let i = 0; i <= ticks; i++) {
    const y = PAD.top + (plotH / ticks) * i;
    grid.push(<line key={i} x1={PAD.left} y1={y} x2={width - PAD.right} y2={y} stroke="#334155" strokeDasharray="3 3" />);
  }

  const step = Math.max(1, Math.ceil(n / 6));
  const xLabels = [];
  for (let i = 0; i < n; i += step) {
    xLabels.push(
      <text key={i} x={xOf(i)} y={height - legendH - 4} fill="#94a3b8" fontSize={11} textAnchor="middle">
        {formatX ? formatX(data[i][xKey]) : data[i][xKey]}
      </text>
    );
  }

  const yLabels = [];
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + ((yMax - yMin) / ticks) * (ticks - i);
    yLabels.push(
      <text key={i} x={PAD.left - 8} y={PAD.top + (plotH / ticks) * i + 4} fill="#94a3b8" fontSize={11} textAnchor="end">
        {formatY ? formatY(v) : Math.round(v)}
      </text>
    );
  }

  // Series paths
  const paths = [];
  for (const l of lines) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      let v;
      if (l.stackId && rows[i]._s?.[l.dataKey]) {
        v = rows[i]._s[l.dataKey].top;
      } else {
        v = Number(data[i][l.dataKey]);
      }
      if (isNaN(v)) { if (!l.connectNulls) pts.push(null); continue; }
      pts.push({ x: xOf(i), y: yOf(v), i, v });
    }

    // Build segments (split on nulls)
    const segments = [];
    let seg = [];
    for (const p of pts) {
      if (p === null) { if (seg.length) { segments.push(seg); seg = []; } }
      else seg.push(p);
    }
    if (seg.length) segments.push(seg);

    for (const seg of segments) {
      if (seg.length < 2) continue;
      const lineD = smooth ? catmullRomPath(seg) : null;
      const polyPoints = smooth ? null : seg.map(p => `${p.x},${p.y}`).join(' ');

      // Area fill
      if (l.fill || l.stackId) {
        let areaD;
        if (l.stackId && rows[0]._s) {
          const bases = [...seg].reverse().map(p => `${p.x},${yOf(rows[p.i]._s[l.dataKey].base)}`);
          const topD = smooth ? catmullRomPath(seg) : `M${seg.map(p => `${p.x},${p.y}`).join('L')}`;
          areaD = `${topD}L${bases.join('L')}Z`;
        } else {
          const bottom = yOf(yMin);
          if (smooth) {
            // Smooth area: move to bottom-left, line up to first point, curve along top, line down to bottom-right
            const curveStart = lineD.indexOf('C');
            const curvePart = curveStart !== -1 ? lineD.slice(curveStart) : `L${seg[seg.length - 1].x},${seg[seg.length - 1].y}`;
            areaD = `M${seg[0].x},${bottom}L${seg[0].x},${seg[0].y}${curvePart}L${seg[seg.length - 1].x},${bottom}Z`;
          } else {
            areaD = `M${seg[0].x},${bottom}L${seg.map(p => `${p.x},${p.y}`).join('L')}L${seg[seg.length - 1].x},${bottom}Z`;
          }
        }
        paths.push(<path key={`a-${l.dataKey}-${seg[0].i}`} d={areaD} fill={l.color} fillOpacity={l.fillOpacity ?? 0.3} />);
      }

      // Line
      if (smooth) {
        paths.push(<path key={`l-${l.dataKey}-${seg[0].i}`} d={lineD} fill="none" stroke={l.color} strokeWidth={2} />);
      } else {
        paths.push(<polyline key={`l-${l.dataKey}-${seg[0].i}`} points={polyPoints} fill="none" stroke={l.color} strokeWidth={2} />);
      }

      // Dots
      if (l.dot) {
        for (const p of seg) {
          paths.push(<circle key={`d-${l.dataKey}-${p.i}`} cx={p.x} cy={p.y} r={3} fill={l.color} />);
        }
      }
    }
  }

  // Hover
  function onMouseMove(e) {
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(xOf(i) - mx);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHoverIdx(bestD < plotW / n + 10 ? best : null);
    setMouse({ x: mx, y: e.clientY - rect.top });
  }

  // Tooltip
  let tooltip = null;
  if (hoverIdx != null) {
    const d = data[hoverIdx];
    tooltip = (
      <div>
        <div className="text-slate-400 mb-1">{formatX ? formatX(d[xKey]) : d[xKey]}</div>
        {lines.map(l => {
          const v = d[l.dataKey];
          if (v == null) return null;
          const nm = legendFormatter ? legendFormatter(l.name || l.dataKey) : (l.name || l.dataKey);
          return (
            <div key={l.dataKey} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: l.color }} />
              <span>{nm}: {formatTooltip ? formatTooltip(v, l.name || l.dataKey) : v}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative" style={{ width: '100%' }}
      onMouseMove={onMouseMove} onMouseLeave={() => setHoverIdx(null)}>
      <svg width={width} height={height - legendH} className="overflow-visible">
        {grid}
        {xLabels}
        {yLabels}
        {paths}
        {hoverIdx != null && (
          <line x1={xOf(hoverIdx)} y1={PAD.top} x2={xOf(hoverIdx)} y2={PAD.top + plotH}
            stroke="#475569" strokeDasharray="2 2" />
        )}
      </svg>
      {showLegend && (
        <div className="flex flex-wrap gap-4 justify-center mt-1 text-xs text-slate-400">
          {lines.map(l => (
            <span key={l.dataKey} className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 inline-block rounded" style={{ backgroundColor: l.color }} />
              {legendFormatter ? legendFormatter(l.name || l.dataKey) : (l.name || l.dataKey)}
            </span>
          ))}
        </div>
      )}
      <SVGTooltip x={mouse.x} y={mouse.y} content={tooltip} visible={hoverIdx != null} />
    </div>
  );
});
