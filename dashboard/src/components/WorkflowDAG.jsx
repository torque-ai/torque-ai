import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
const STATUS_FILL = {
  completed: '#16a34a',
  running: '#2563eb',
  pending: '#475569',
  failed: '#dc2626',
  cancelled: '#ca8a04',
  skipped: '#64748b',
};

const STATUS_ICON = {
  completed: '\u2713',
  running: '\u25B6',
  pending: '\u25CB',
  failed: '\u2717',
  cancelled: '\u25CB',
  skipped: '\u2015',
};

const NODE_W = 180;
const NODE_H = 60;
const NODE_RX = 8;

function truncate(str, max = 25) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/**
 * SVG-based DAG visualization for workflow tasks, laid out with dagre.
 */
export default function WorkflowDAG({ tasks = [], onOpenDrawer }) {
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);

  const layout = useMemo(() => {
    if (!tasks.length) return null;

    const NODESEP = 40;
    const RANKSEP = 80;
    const MARGIN = 20;

    // Build adjacency
    const nodeMap = new Map();
    const inEdges = new Map();
    const outEdges = new Map();

    for (const task of tasks) {
      const id = task.node_id || task.id || task.task_id;
      nodeMap.set(id, task);
      if (!inEdges.has(id)) inEdges.set(id, []);
      if (!outEdges.has(id)) outEdges.set(id, []);
    }

    const edgeList = [];
    for (const task of tasks) {
      const id = task.node_id || task.id || task.task_id;
      const deps = task.depends_on || task.dependencies || [];
      for (const dep of deps) {
        if (nodeMap.has(dep)) {
          outEdges.get(dep).push(id);
          inEdges.get(id).push(dep);
          edgeList.push({ from: dep, to: id });
        }
      }
    }

    // Rank assignment via longest-path from roots (LR layout)
    const rank = new Map();
    const ids = [...nodeMap.keys()];
    const roots = ids.filter((id) => inEdges.get(id).length === 0);
    if (roots.length === 0 && ids.length > 0) roots.push(ids[0]);

    const queue = roots.map((id) => { rank.set(id, 0); return id; });
    while (queue.length) {
      const id = queue.shift();
      const r = rank.get(id);
      for (const child of outEdges.get(id)) {
        const prev = rank.get(child);
        if (prev === undefined || r + 1 > prev) {
          rank.set(child, r + 1);
          queue.push(child);
        }
      }
    }
    // Assign unranked nodes (disconnected) to rank 0
    for (const id of ids) {
      if (!rank.has(id)) rank.set(id, 0);
    }

    // Group by rank
    const ranks = new Map();
    for (const id of ids) {
      const r = rank.get(id);
      if (!ranks.has(r)) ranks.set(r, []);
      ranks.get(r).push(id);
    }

    // Compute positions (LR: rank = x column, index within rank = y row)
    const maxRank = Math.max(0, ...ranks.keys());
    const posMap = new Map();

    for (let r = 0; r <= maxRank; r++) {
      const col = ranks.get(r) || [];
      for (let i = 0; i < col.length; i++) {
        const x = MARGIN + r * (NODE_W + RANKSEP) + NODE_W / 2;
        const y = MARGIN + i * (NODE_H + NODESEP) + NODE_H / 2;
        posMap.set(col[i], { x, y });
      }
    }

    const nodes = ids.map((id) => {
      const pos = posMap.get(id);
      return { id, x: pos.x, y: pos.y, width: NODE_W, height: NODE_H, task: nodeMap.get(id) };
    });

    const edges = edgeList.map((e) => {
      const from = posMap.get(e.from);
      const to = posMap.get(e.to);
      // Simple edge: right side of source → left side of target
      return {
        from: e.from,
        to: e.to,
        points: [
          { x: from.x + NODE_W / 2, y: from.y },
          { x: to.x - NODE_W / 2, y: to.y },
        ],
      };
    });

    const maxCol = ranks.size;
    const maxRows = Math.max(1, ...([...ranks.values()].map((col) => col.length)));
    const svgWidth = MARGIN * 2 + maxCol * (NODE_W + RANKSEP) - RANKSEP + 40;
    const svgHeight = MARGIN * 2 + maxRows * (NODE_H + NODESEP) - NODESEP + 40;

    return { nodes, edges, svgWidth, svgHeight };
  }, [tasks]);

  // Fit to container on mount and when layout changes
  useEffect(() => {
    if (!layout || !containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    if (containerWidth > 0 && layout.svgWidth > 0) {
      const fitScale = Math.min(1, containerWidth / layout.svgWidth);
      setScale(fitScale);
      setPan({ x: 0, y: 0 });
    }
  }, [layout]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function handleWheel(e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setScale((s) => Math.max(0.2, Math.min(2, s - e.deltaY * 0.001)));
    }
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e) => {
    if (!dragging || !dragStart.current) return;
    setPan({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
    dragStart.current = null;
  }, []);

  if (!layout || layout.nodes.length === 0) {
    return <p className="text-sm text-slate-500 text-center py-4">No tasks to visualize</p>;
  }

  return (
    <div
      ref={containerRef}
      className="overflow-hidden bg-slate-900/50 rounded-lg border border-slate-700/30"
      style={{ minHeight: 120, maxHeight: 400, cursor: dragging ? 'grabbing' : 'grab' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <svg
        ref={svgRef}
        width={layout.svgWidth * scale}
        height={layout.svgHeight * scale}
        viewBox={`${-pan.x / scale} ${-pan.y / scale} ${layout.svgWidth} ${layout.svgHeight}`}
        className="select-none"
        data-testid="workflow-dag-svg"
      >
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#64748b" />
          </marker>
        </defs>

        {/* Edges */}
        {layout.edges.map((edge) => {
          const pts = edge.points;
          if (!pts || pts.length < 2) return null;
          const d = pts.length === 2
            ? `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`
            : `M ${pts[0].x} ${pts[0].y} ` +
              pts.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ');
          return (
            <path
              key={`${edge.from}-${edge.to}`}
              d={d}
              fill="none"
              stroke="#475569"
              strokeWidth={1.5}
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {/* Nodes */}
        {layout.nodes.map((node) => {
          const t = node.task;
          const fill = STATUS_FILL[t.status] || STATUS_FILL.pending;
          const icon = STATUS_ICON[t.status] || STATUS_ICON.pending;
          const label = truncate(t.node_id || t.description || t.task_description || t.id || t.task_id);
          const duration = t.completed_at && t.started_at
            ? (new Date(t.completed_at) - new Date(t.started_at)) / 1000
            : null;

          return (
            <g
              key={node.id}
              transform={`translate(${node.x - NODE_W / 2}, ${node.y - NODE_H / 2})`}
              onClick={() => onOpenDrawer?.(t.id || t.task_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenDrawer?.(t.id || t.task_id);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`${label} — ${t.status}`}
              style={{ cursor: 'pointer' }}
              data-testid={`dag-node-${node.id}`}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={NODE_RX}
                fill="#1e293b"
                stroke={fill}
                strokeWidth={2}
              />
              {/* Status indicator bar */}
              <rect
                width={4}
                height={NODE_H - 4}
                x={2}
                y={2}
                rx={2}
                fill={fill}
              />
              {/* Icon */}
              <text
                x={16}
                y={NODE_H / 2 - 6}
                fill={fill}
                fontSize={14}
                fontFamily="monospace"
                dominantBaseline="central"
              >
                {icon}
              </text>
              {/* Label */}
              <text
                x={32}
                y={NODE_H / 2 - 6}
                fill="#e2e8f0"
                fontSize={11}
                fontFamily="system-ui, sans-serif"
                dominantBaseline="central"
              >
                {label}
              </text>
              {/* Duration or status */}
              <text
                x={32}
                y={NODE_H / 2 + 10}
                fill="#94a3b8"
                fontSize={9}
                fontFamily="monospace"
                dominantBaseline="central"
              >
                {duration ? formatDuration(duration) : t.status}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
