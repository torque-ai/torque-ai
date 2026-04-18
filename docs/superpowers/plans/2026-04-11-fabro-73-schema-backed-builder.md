# Fabro #73: Schema-Backed Visual Builder (AutoGen Studio)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a **dual-mode** workflow builder to the dashboard: a drag-and-drop canvas **and** a JSON editor, both operating on the same typed workflow spec (Plan 1). A **gallery** of reusable workflow templates can be pinned and dropped into the canvas. Authored workflows serialize to the exact same YAML/JSON that CLI + MCP consume. Inspired by AutoGen Studio + Rivet.

**Architecture:** Dashboard adds a new `/builder` view using React Flow (or similar). The canvas state mirrors the workflow spec 1:1 — each node is a task, edges are `depends_on`. A sidebar toggles between canvas and raw JSON; edits in either sync the shared state. A **Gallery** tab lists reusable templates (Plan 8 workflow templates) with a "Pin to sidebar" action. An **Export/Import** flow turns canvas state into `torque workflow submit path/to/spec.yaml`.

**Tech Stack:** React Flow (or xyflow), existing dashboard. Builds on plans 1 (workflow-as-code), 8 (templates), 13 (visualization), 64 (validation).

---

## File Structure

**New files:**
- `dashboard/src/views/WorkflowBuilder.jsx`
- `dashboard/src/builder/canvas-to-spec.js`
- `dashboard/src/builder/spec-to-canvas.js`
- `dashboard/src/builder/Gallery.jsx`
- `dashboard/src/builder/NodePalette.jsx`
- `dashboard/src/builder/JsonEditor.jsx`
- `dashboard/src/tests/canvas-to-spec.test.js`
- `dashboard/src/tests/spec-to-canvas.test.js`

**Modified files:**
- `dashboard/package.json` — add `reactflow` (or `@xyflow/react`)
- `dashboard/src/App.jsx` — add `/builder` route
- `server/handlers/mcp-tools.js` — `pin_to_gallery`, `unpin_from_gallery`

---

## Task 1: Canvas ↔ spec roundtrip

- [x] **Step 1: Tests (spec → canvas)**

Create `dashboard/src/tests/spec-to-canvas.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { specToCanvas } from '../builder/spec-to-canvas';

describe('specToCanvas', () => {
  it('converts linear workflow to nodes + edges', () => {
    const spec = {
      name: 'linear',
      tasks: [
        { id: 'a', task_description: 'step a' },
        { id: 'b', task_description: 'step b', depends_on: ['a'] },
        { id: 'c', task_description: 'step c', depends_on: ['b'] },
      ],
    };
    const { nodes, edges } = specToCanvas(spec);
    expect(nodes).toHaveLength(3);
    expect(edges).toEqual([
      expect.objectContaining({ source: 'a', target: 'b' }),
      expect.objectContaining({ source: 'b', target: 'c' }),
    ]);
  });

  it('handles diamond DAG', () => {
    const spec = {
      name: 'diamond',
      tasks: [
        { id: 'a' }, { id: 'b', depends_on: ['a'] }, { id: 'c', depends_on: ['a'] },
        { id: 'd', depends_on: ['b', 'c'] },
      ],
    };
    const { edges } = specToCanvas(spec);
    expect(edges).toHaveLength(4);
    const targetsOfA = edges.filter(e => e.source === 'a').map(e => e.target).sort();
    expect(targetsOfA).toEqual(['b', 'c']);
  });

  it('positions nodes in topological columns (simple layout)', () => {
    const spec = {
      name: 't',
      tasks: [{ id: 'a' }, { id: 'b', depends_on: ['a'] }],
    };
    const { nodes } = specToCanvas(spec);
    const a = nodes.find(n => n.id === 'a');
    const b = nodes.find(n => n.id === 'b');
    expect(a.position.x).toBeLessThan(b.position.x);
  });

  it('preserves node metadata', () => {
    const spec = { name: 't', tasks: [{ id: 'a', provider: '<git-user>', kind: 'agent' }] };
    const { nodes } = specToCanvas(spec);
    expect(nodes[0].data.provider).toBe('<git-user>');
    expect(nodes[0].data.kind).toBe('agent');
  });
});
```

- [x] **Step 2: Implement spec-to-canvas**

Create `dashboard/src/builder/spec-to-canvas.js`:

```js
export function specToCanvas(spec) {
  const tasks = spec.tasks || [];
  const depthByNode = computeDepths(tasks);
  const nodesByDepth = new Map();
  for (const t of tasks) {
    const d = depthByNode.get(t.id) ?? 0;
    if (!nodesByDepth.has(d)) nodesByDepth.set(d, []);
    nodesByDepth.get(d).push(t);
  }

  const nodes = [];
  for (const [depth, group] of nodesByDepth) {
    group.forEach((t, idx) => {
      nodes.push({
        id: t.id,
        type: 'default',
        position: { x: depth * 220, y: idx * 120 },
        data: { label: t.id, ...t },
      });
    });
  }

  const edges = [];
  for (const t of tasks) {
    for (const dep of (t.depends_on || [])) {
      edges.push({ id: `${dep}->${t.id}`, source: dep, target: t.id });
    }
  }

  return { nodes, edges };
}

function computeDepths(tasks) {
  const depsMap = new Map(tasks.map(t => [t.id, t.depends_on || []]));
  const depthCache = new Map();
  function depth(id, visiting = new Set()) {
    if (depthCache.has(id)) return depthCache.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = depsMap.get(id) || [];
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(d2 => depth(d2, visiting)));
    depthCache.set(id, d);
    return d;
  }
  for (const t of tasks) depth(t.id);
  return depthCache;
}
```

Commit: `feat(builder): spec → canvas (React Flow nodes + edges) with topological layout`.

---

## Task 2: Canvas → spec

- [ ] **Step 1: Tests**

Create `dashboard/src/tests/canvas-to-spec.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { canvasToSpec } from '../builder/canvas-to-spec';

describe('canvasToSpec', () => {
  it('converts nodes + edges back to spec', () => {
    const nodes = [
      { id: 'a', data: { task_description: 'first' } },
      { id: 'b', data: { task_description: 'second' } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    const spec = canvasToSpec({ name: 'my-wf', nodes, edges });
    expect(spec.name).toBe('my-wf');
    expect(spec.tasks).toHaveLength(2);
    expect(spec.tasks.find(t => t.id === 'b').depends_on).toEqual(['a']);
  });

  it('aggregates multiple dependencies into depends_on array', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const edges = [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }];
    const spec = canvasToSpec({ name: 'w', nodes, edges });
    expect(spec.tasks.find(t => t.id === 'c').depends_on.sort()).toEqual(['a', 'b']);
  });

  it('preserves node data as task fields', () => {
    const nodes = [{ id: 'a', data: { task_description: 'x', provider: '<git-user>', kind: 'agent' } }];
    const spec = canvasToSpec({ name: 'w', nodes, edges: [] });
    expect(spec.tasks[0]).toEqual(expect.objectContaining({
      id: 'a', task_description: 'x', provider: '<git-user>', kind: 'agent',
    }));
  });

  it('omits empty depends_on arrays', () => {
    const nodes = [{ id: 'a' }];
    const spec = canvasToSpec({ name: 'w', nodes, edges: [] });
    expect(spec.tasks[0].depends_on).toBeUndefined();
  });

  it('roundtrip (spec → canvas → spec) preserves shape', async () => {
    const original = {
      name: 'rt',
      tasks: [
        { id: 'a', task_description: 'step a' },
        { id: 'b', task_description: 'step b', depends_on: ['a'] },
      ],
    };
    const { specToCanvas } = await import('../builder/spec-to-canvas');
    const { nodes, edges } = specToCanvas(original);
    const roundtripped = canvasToSpec({ name: 'rt', nodes, edges });
    expect(roundtripped.tasks).toHaveLength(original.tasks.length);
    expect(roundtripped.tasks.find(t => t.id === 'b').depends_on).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Implement canvas-to-spec**

Create `dashboard/src/builder/canvas-to-spec.js`:

```js
export function canvasToSpec({ name, description, nodes, edges }) {
  const incoming = new Map();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e.source);
  }

  const tasks = nodes.map(n => {
    const task = { id: n.id, ...(n.data || {}) };
    delete task.label; // React Flow label is UI-only
    const deps = incoming.get(n.id);
    if (deps && deps.length > 0) task.depends_on = [...deps].sort();
    return task;
  });

  const spec = { name, tasks };
  if (description) spec.description = description;
  return spec;
}
```

Run tests → PASS. Commit: `feat(builder): canvas → spec roundtrip with roundtrip property test`.

---

## Task 3: Builder UI + Gallery + JSON editor

- [ ] **Step 1: Builder view**

Install `@xyflow/react` (`npm install @xyflow/react`). Create `dashboard/src/views/WorkflowBuilder.jsx`:

```jsx
import { useState, useEffect, useCallback } from 'react';
import { ReactFlow, addEdge, Background, Controls, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { specToCanvas } from '../builder/spec-to-canvas';
import { canvasToSpec } from '../builder/canvas-to-spec';
import JsonEditor from '../builder/JsonEditor';
import Gallery from '../builder/Gallery';
import NodePalette from '../builder/NodePalette';

export default function WorkflowBuilder() {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [meta, setMeta] = useState({ name: 'new-workflow', description: '' });
  const [mode, setMode] = useState('canvas'); // 'canvas' | 'json'
  const [validation, setValidation] = useState(null);

  const onNodesChange = useCallback(c => setNodes(ns => applyNodeChanges(c, ns)), []);
  const onEdgesChange = useCallback(c => setEdges(es => applyEdgeChanges(c, es)), []);
  const onConnect = useCallback(conn => setEdges(es => addEdge(conn, es)), []);

  async function submit() {
    const spec = canvasToSpec({ ...meta, nodes, edges });
    // Pre-submit: validate via Plan 64 endpoint
    const vr = await fetch('/api/workflows/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: spec }),
    }).then(r => r.json());
    setValidation(vr);
    if (!vr.ok) return;
    const r = await fetch('/api/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec),
    }).then(r => r.json());
    alert(`Submitted as ${r.workflow_id}`);
  }

  function loadTemplate(templateSpec) {
    const { nodes: tn, edges: te } = specToCanvas(templateSpec);
    setNodes(tn); setEdges(te);
    setMeta({ name: templateSpec.name || 'from-template', description: templateSpec.description });
  }

  const spec = canvasToSpec({ ...meta, nodes, edges });

  return (
    <div className="flex h-screen">
      <aside className="w-64 p-3 border-r bg-gray-50">
        <NodePalette onAdd={(node) => setNodes(n => [...n, node])} />
        <Gallery onPick={loadTemplate} />
      </aside>
      <main className="flex-1 flex flex-col">
        <header className="flex items-center gap-2 p-2 border-b">
          <input value={meta.name} onChange={e => setMeta(m => ({ ...m, name: e.target.value }))} className="border rounded px-2 py-1" />
          <button onClick={() => setMode(m => m === 'canvas' ? 'json' : 'canvas')} className="px-3 py-1 border rounded">
            {mode === 'canvas' ? 'Show JSON' : 'Show Canvas'}
          </button>
          <button onClick={submit} className="ml-auto px-3 py-1 bg-blue-600 text-white rounded">Submit</button>
        </header>
        <div className="flex-1">
          {mode === 'canvas' ? (
            <ReactFlow
              nodes={nodes} edges={edges}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              fitView
            >
              <Background /><Controls />
            </ReactFlow>
          ) : (
            <JsonEditor
              value={spec}
              onChange={(newSpec) => {
                const { nodes: nn, edges: ne } = specToCanvas(newSpec);
                setNodes(nn); setEdges(ne);
                setMeta({ name: newSpec.name, description: newSpec.description });
              }}
            />
          )}
        </div>
        {validation && !validation.ok && (
          <aside className="p-3 bg-red-100 border-t text-sm">
            <strong>Validation errors:</strong>
            <ul>{validation.errors.map((e, i) => <li key={i}>• {e}</li>)}</ul>
          </aside>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Gallery + Palette + JsonEditor**

Three supporting components:
- `NodePalette.jsx` — renders a list of node kinds (`agent`, `inline`, `jq_transform`, `human`, `crew`, etc.) — drag/click to add.
- `Gallery.jsx` — fetches `/api/workflow_templates?pinned=true`, lists them, and calls `onPick(template)` when clicked.
- `JsonEditor.jsx` — textarea with JSON-parse-on-blur that calls `onChange(parsedSpec)`, validation errors shown inline.

- [ ] **Step 3: MCP tools**

```js
pin_to_gallery: {
  description: 'Pin a workflow template to the builder gallery sidebar.',
  inputSchema: { type: 'object', required: ['template_id'], properties: { template_id: { type: 'string' } } },
},
unpin_from_gallery: {
  description: 'Remove a workflow template from the gallery.',
  inputSchema: { type: 'object', required: ['template_id'], properties: { template_id: { type: 'string' } } },
},
```

Add a `pinned INTEGER` column to `workflow_templates` (from Plan 8).

`await_restart`. Smoke: open `/builder`, drag 2 nodes, connect them, click Submit. Confirm workflow accepted. Toggle to JSON mode, edit directly, toggle back. Pick from Gallery, confirm canvas repopulates.

Commit: `feat(builder): schema-backed visual + JSON builder with gallery`.
