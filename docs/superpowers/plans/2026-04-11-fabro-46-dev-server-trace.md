# Fabro #46: Step Trace Waterfall (Inngest)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every workflow run a visual **trace waterfall** — a Gantt-style chart showing every task, activity (Plan 31), state patch (Plan 27), signal (Plan 30), and dependency unblock as a labeled bar on a time axis, clickable to drill into the underlying record. Inspired by Inngest's execution timeline.

**Architecture:** Builds on Plan 29 (event history journal). A new `dashboard/src/views/WorkflowTimeline.jsx` reads events from `GET /api/workflows/:id/events` and renders them as SVG bars grouped by row type. A helper `buildTraceRows()` pipes events into `{ row_label, start_ms, end_ms, event_type, task_id, payload_summary }` objects. Clicking a bar opens a side panel with the full event payload. Zoom + pan controls let operators drill from minutes to sub-second scale.

**Tech Stack:** React, D3-ish SVG (no external chart lib). Builds on Plans 14, 29.

---

## File Structure

**New files:**
- `server/visibility/trace-builder.js` — pure event → trace-rows reducer
- `server/tests/trace-builder.test.js`
- `dashboard/src/views/WorkflowTimeline.jsx`
- `dashboard/src/components/TraceWaterfall.jsx`
- `dashboard/src/components/TraceBar.jsx`

**Modified files:**
- `server/api/routes/workflows.js` — `GET /:id/trace` returns pre-built rows

---

## Task 1: Trace builder

- [ ] **Step 1: Tests**

Create `server/tests/trace-builder.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { buildTraceRows } = require('../visibility/trace-builder');

const t0 = 1735689600000; // some fixed epoch
const iso = (offsetMs) => new Date(t0 + offsetMs).toISOString();

describe('buildTraceRows', () => {
  it('pairs task_started with task_completed into a single bar', () => {
    const events = [
      { seq: 1, event_type: 'task_started',   task_id: 't1', step_id: 'build',  created_at: iso(0),    payload: {} },
      { seq: 2, event_type: 'task_completed', task_id: 't1', step_id: 'build',  created_at: iso(5000), payload: {} },
    ];
    const rows = buildTraceRows(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      row_label: 'build', status: 'completed', start_ms: 0, end_ms: 5000, duration_ms: 5000,
    }));
  });

  it('marks unfinished tasks with status=running', () => {
    const events = [{ seq: 1, event_type: 'task_started', task_id: 't1', step_id: 'x', created_at: iso(0) }];
    const rows = buildTraceRows(events, { nowMs: t0 + 2000 });
    expect(rows[0].status).toBe('running');
    expect(rows[0].end_ms).toBe(2000);
  });

  it('state_patched events become instant markers (zero-width)', () => {
    const events = [
      { seq: 1, event_type: 'task_started',   task_id: 't1', step_id: 'x', created_at: iso(0) },
      { seq: 2, event_type: 'state_patched',  task_id: 't1', created_at: iso(2000), payload: { patch: { a: 1 } } },
      { seq: 3, event_type: 'task_completed', task_id: 't1', step_id: 'x', created_at: iso(5000) },
    ];
    const rows = buildTraceRows(events);
    const marker = rows.find(r => r.event_type === 'state_patched');
    expect(marker).toBeDefined();
    expect(marker.start_ms).toBe(2000);
    expect(marker.end_ms).toBe(2000);
  });

  it('signal_received / update_applied show up as markers', () => {
    const events = [
      { seq: 1, event_type: 'signal_received', task_id: null, created_at: iso(1000), payload: { signal: 'approve' } },
      { seq: 2, event_type: 'update_applied',  task_id: null, created_at: iso(2000), payload: { update: 'retry' } },
    ];
    const rows = buildTraceRows(events);
    expect(rows.map(r => r.event_type)).toEqual(['signal_received', 'update_applied']);
  });

  it('orders rows by start_ms ASC', () => {
    const events = [
      { seq: 1, event_type: 'task_started',   task_id: 'b', step_id: 'b', created_at: iso(1000) },
      { seq: 2, event_type: 'task_started',   task_id: 'a', step_id: 'a', created_at: iso(500) },
      { seq: 3, event_type: 'task_completed', task_id: 'a', step_id: 'a', created_at: iso(700) },
      { seq: 4, event_type: 'task_completed', task_id: 'b', step_id: 'b', created_at: iso(2000) },
    ];
    const rows = buildTraceRows(events);
    expect(rows.map(r => r.row_label)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/visibility/trace-builder.js`:

```js
'use strict';

const MARKER_TYPES = new Set(['state_patched', 'signal_received', 'update_applied', 'checkpoint_taken', 'dependency_unblocked']);

function buildTraceRows(events, { nowMs = Date.now() } = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const t0 = new Date(events[0].created_at).getTime();
  const offset = (iso) => new Date(iso).getTime() - t0;

  const byTask = new Map();
  const markers = [];

  for (const ev of events) {
    if (ev.event_type === 'task_started') {
      byTask.set(ev.task_id, {
        row_label: ev.step_id || ev.task_id,
        task_id: ev.task_id,
        step_id: ev.step_id,
        event_type: 'task',
        start_ms: offset(ev.created_at),
        end_ms: null,
        status: 'running',
        payload_summary: ev.payload || {},
      });
    } else if (ev.event_type === 'task_completed' || ev.event_type === 'task_failed' || ev.event_type === 'task_cancelled') {
      const row = byTask.get(ev.task_id);
      if (row) {
        row.end_ms = offset(ev.created_at);
        row.status = ev.event_type.slice('task_'.length);
        row.final_payload = ev.payload;
      }
    } else if (MARKER_TYPES.has(ev.event_type)) {
      const ms = offset(ev.created_at);
      markers.push({
        row_label: ev.task_id || '(workflow)',
        task_id: ev.task_id,
        event_type: ev.event_type,
        start_ms: ms,
        end_ms: ms,
        status: 'marker',
        payload_summary: summarize(ev.payload),
      });
    }
  }

  for (const row of byTask.values()) {
    if (row.end_ms === null) row.end_ms = nowMs - t0;
    row.duration_ms = row.end_ms - row.start_ms;
  }

  const rows = [...byTask.values(), ...markers].sort((a, b) => a.start_ms - b.start_ms);
  return rows;
}

function summarize(payload) {
  if (!payload) return null;
  try {
    const s = JSON.stringify(payload);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch { return null; }
}

module.exports = { buildTraceRows };
```

Run tests → PASS. Commit: `feat(trace): pure event → trace-row reducer`.

---

## Task 2: REST + dashboard

- [ ] **Step 1: REST**

In `server/api/routes/workflows.js`:

```js
router.get('/:id/trace', (req, res) => {
  const journal = defaultContainer.get('journalWriter');
  const { buildTraceRows } = require('../../visibility/trace-builder');
  const events = journal.readJournal(req.params.id);
  const rows = buildTraceRows(events);
  res.json({ workflow_id: req.params.id, t0_iso: events[0]?.created_at, rows });
});
```

- [ ] **Step 2: TraceWaterfall component**

Create `dashboard/src/components/TraceWaterfall.jsx`:

```jsx
import { useState, useMemo } from 'react';

const STATUS_COLORS = {
  running: '#60a5fa',
  completed: '#34d399',
  failed: '#f87171',
  cancelled: '#9ca3af',
  marker: '#a78bfa',
};

export default function TraceWaterfall({ rows, onRowClick }) {
  const [hovered, setHovered] = useState(null);
  const { maxMs, rowHeight, pixelsPerMs } = useMemo(() => {
    const max = Math.max(...rows.map(r => r.end_ms), 1);
    return { maxMs: max, rowHeight: 24, pixelsPerMs: 900 / max };
  }, [rows]);

  return (
    <svg width="1000" height={rows.length * 28 + 20} className="bg-gray-50">
      {rows.map((r, i) => {
        const x = 100 + r.start_ms * pixelsPerMs;
        const width = Math.max(2, (r.end_ms - r.start_ms) * pixelsPerMs);
        const y = 10 + i * 28;
        const color = STATUS_COLORS[r.status] || '#ccc';
        return (
          <g key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} onClick={() => onRowClick?.(r)}>
            <text x={5} y={y + 16} fontSize={11} fontFamily="monospace">{r.row_label}</text>
            <rect x={x} y={y} width={width} height={rowHeight} fill={color} opacity={hovered === i ? 1 : 0.8} rx={3} />
            {r.duration_ms > 500 && (
              <text x={x + 4} y={y + 16} fontSize={10} fill="white">{r.duration_ms}ms</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 3: View page**

Create `dashboard/src/views/WorkflowTimeline.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import TraceWaterfall from '../components/TraceWaterfall';

export default function WorkflowTimeline() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    fetch(`/api/workflows/${id}/trace`).then(r => r.json()).then(setData);
  }, [id]);

  if (!data) return <div className="p-4">Loading trace…</div>;

  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold mb-2">Trace: {id}</h2>
      <p className="text-xs text-gray-500 mb-4">t0 = {data.t0_iso} · {data.rows.length} events</p>
      <div className="border rounded overflow-auto">
        <TraceWaterfall rows={data.rows} onRowClick={setSelected} />
      </div>
      {selected && (
        <aside className="mt-4 bg-gray-900 text-gray-100 p-3 rounded text-xs">
          <h3 className="font-semibold mb-2">{selected.row_label}</h3>
          <pre>{JSON.stringify(selected, null, 2)}</pre>
        </aside>
      )}
    </div>
  );
}
```

Add route + link from `WorkflowDetail.jsx`.

`await_restart`. Smoke: run a 6-task workflow with one `state_patched`, one `signal_received`. Confirm bars render in order with correct widths, markers show as zero-width dots.

Commit: `feat(trace): waterfall timeline view + REST endpoint`.
