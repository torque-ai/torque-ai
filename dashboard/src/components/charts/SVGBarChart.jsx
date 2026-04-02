import { useState, useRef, useEffect, useMemo, memo } from 'react';
import SVGTooltip from './SVGTooltip';

/**
 * Lightweight SVG bar chart. Supports vertical (default) and horizontal layout.
 * Replaces recharts BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
 * ResponsiveContainer, Legend.
 *
 * @param {Object[]} data - Array of data objects
 * @param {Object[]} bars - Series config: { dataKey, color?, colorFn?, name? }
 *   colorFn: (entry, index) => hexColor — per-bar color override
 * @param {string}   xKey - Category key
 * @param {number}   height - Chart height in px
 * @param {boolean}  horizontal - If true, categories on Y axis, values on X (layout="vertical")
 * @param {Function} formatX - Label formatter for category axis
 * @param {Function} formatY - Label formatter for value axis
 * @param {Function} formatTooltip - (value, seriesName, entry) => displayString
 * @param {boolean}  showLegend
 * @param {number}   yWidth - Width reserved for Y-axis labels in horizontal mode (default 100)
 * @param {number}   radius - Corner radius for bars (default 4)
 */
export default memo(function SVGBarChart({
  data, bars, xKey, height = 300,
  horizontal = false, formatX, formatY, formatTooltip,
  showLegend = false, yWidth = 100, radius = 4,
}) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [hoverBar, setHoverBar] = useState(null);
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
  const pad = horizontal
    ? { top: 10, right: 20, bottom: 10, left: yWidth + 10 }
    : { top: 10, right: 20, bottom: 28, left: 50 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom - legendH;

  // Value range
  const { vMax } = useMemo(() => {
    let max = 0;
    for (const d of data) {
      for (const b of bars) {
        const v = Number(d[b.dataKey]) || 0;
        if (v > max) max = v;
      }
    }
    return { vMax: max * 1.1 || 1 };
  }, [data, bars]);

  if (!data.length || plotW <= 0)
    return <div ref={containerRef} style={{ width: '100%', height }} />;

  function getMousePos(e) {
    const r = containerRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : mouse;
  }

  const n = data.length;
  const nBars = bars.length;
  const gap = 0.3; // fraction of slot used for gaps

  const elements = [];

  if (horizontal) {
    // Horizontal: categories on Y, values on X
    const slotH = plotH / n;
    const barH = (slotH * (1 - gap)) / nBars;
    const vScale = v => pad.left + (v / vMax) * plotW;

    // Grid
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const x = pad.left + (plotW / ticks) * i;
      elements.push(<line key={`g${i}`} x1={x} y1={pad.top} x2={x} y2={pad.top + plotH} stroke="#334155" strokeDasharray="3 3" />);
    }

    // X axis labels (value)
    for (let i = 0; i <= ticks; i++) {
      const v = (vMax / ticks) * i;
      elements.push(
        <text key={`xv${i}`} x={pad.left + (plotW / ticks) * i} y={pad.top + plotH + 16}
          fill="#94a3b8" fontSize={11} textAnchor="middle">
          {formatY ? formatY(v) : Math.round(v)}
        </text>
      );
    }

    // Y axis labels (category) + bars
    for (let di = 0; di < n; di++) {
      const d = data[di];
      const slotY = pad.top + slotH * di;
      const label = formatX ? formatX(d[xKey]) : d[xKey];

      elements.push(
        <text key={`yl${di}`} x={pad.left - 8} y={slotY + slotH / 2 + 4}
          fill="#94a3b8" fontSize={11} textAnchor="end">{label}</text>
      );

      for (let bi = 0; bi < nBars; bi++) {
        const b = bars[bi];
        const v = Number(d[b.dataKey]) || 0;
        const bw = vScale(v) - pad.left;
        const by = slotY + (slotH * gap) / 2 + barH * bi;
        const fill = b.colorFn ? b.colorFn(d, di) : (b.color || '#3b82f6');

        elements.push(
          <rect key={`b${di}-${bi}`} x={pad.left} y={by} width={Math.max(0, bw)} height={barH}
            rx={radius} fill={fill}
            onMouseEnter={(e) => {
              setHoverBar({ di, bi, v, name: b.name || b.dataKey, entry: d });
              setMouse(getMousePos(e));
            }}
            onMouseMove={(e) => setMouse(getMousePos(e))}
            onMouseLeave={() => setHoverBar(null)}
            className="cursor-pointer"
          />
        );
      }
    }
  } else {
    // Vertical: categories on X, values on Y
    const slotW = plotW / n;
    const barW = (slotW * (1 - gap)) / nBars;
    const yScale = v => pad.top + plotH - (v / vMax) * plotH;

    // Grid
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const y = pad.top + (plotH / ticks) * i;
      elements.push(<line key={`g${i}`} x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#334155" strokeDasharray="3 3" />);
    }

    // Y axis labels (value)
    for (let i = 0; i <= ticks; i++) {
      const v = (vMax / ticks) * (ticks - i);
      elements.push(
        <text key={`yv${i}`} x={pad.left - 8} y={pad.top + (plotH / ticks) * i + 4}
          fill="#94a3b8" fontSize={11} textAnchor="end">
          {formatY ? formatY(v) : Math.round(v)}
        </text>
      );
    }

    // X axis labels (category) + bars
    for (let di = 0; di < n; di++) {
      const d = data[di];
      const slotX = pad.left + slotW * di;
      const label = formatX ? formatX(d[xKey]) : (d[xKey] ?? '');
      const labelStr = String(label);

      elements.push(
        <text key={`xl${di}`} x={slotX + slotW / 2} y={height - legendH - 4}
          fill="#94a3b8" fontSize={11} textAnchor="middle">
          {labelStr.length > 12 ? labelStr.slice(0, 10) + '..' : labelStr}
        </text>
      );

      for (let bi = 0; bi < nBars; bi++) {
        const b = bars[bi];
        const v = Number(d[b.dataKey]) || 0;
        const bh = (v / vMax) * plotH;
        const bx = slotX + (slotW * gap) / 2 + barW * bi;
        const fill = b.colorFn ? b.colorFn(d, di) : (b.color || '#3b82f6');

        elements.push(
          <rect key={`b${di}-${bi}`} x={bx} y={yScale(v)} width={barW} height={Math.max(0, bh)}
            rx={radius} fill={fill}
            onMouseEnter={(e) => {
              setHoverBar({ di, bi, v, name: b.name || b.dataKey, entry: d });
              setMouse(getMousePos(e));
            }}
            onMouseMove={(e) => setMouse(getMousePos(e))}
            onMouseLeave={() => setHoverBar(null)}
            className="cursor-pointer"
          />
        );
      }
    }
  }

  // Tooltip
  let tooltip = null;
  if (hoverBar) {
    const { v, name, entry } = hoverBar;
    const label = formatX ? formatX(entry[xKey]) : entry[xKey];
    tooltip = (
      <div>
        <div className="text-slate-400 mb-1">{label}</div>
        <div>{name}: {formatTooltip ? formatTooltip(v, name, entry) : v}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative" style={{ width: '100%' }}>
      <svg width={width} height={height - legendH} className="overflow-visible">
        {elements}
      </svg>
      {showLegend && bars.length > 1 && (
        <div className="flex flex-wrap gap-4 justify-center mt-1 text-xs text-slate-400">
          {bars.map(b => (
            <span key={b.dataKey} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded inline-block" style={{ backgroundColor: b.color || '#3b82f6' }} />
              {b.name || b.dataKey}
            </span>
          ))}
        </div>
      )}
      <SVGTooltip x={mouse.x} y={mouse.y} content={tooltip} visible={!!hoverBar} />
    </div>
  );
});
