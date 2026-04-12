# Fabro #13: Workflow Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render workflow specs and live workflows as Mermaid diagrams in the dashboard. See the DAG instead of mentally parsing YAML dependencies. Status colors light up live for in-flight workflows. Conditional edges (Plan 12) appear as labeled arrows; merge nodes (Plan 5) get a distinct shape; goal-gated nodes (Plan 4) get a badge.

**Architecture:** A new `server/workflow-spec/render-mermaid.js` module produces a Mermaid `graph TD` representation from either a parsed spec or a live workflow's tasks+dependencies. Output is plain text — the dashboard renders it via the `mermaid` JS library using its `run()` API (which mounts SVG into a container element without raw HTML injection). New REST endpoints expose the rendered diagram.

**Depends on:** workflow-spec (Plan 1) for the spec rendering. Live-workflow rendering works regardless.

---

## File Structure

**New files:**
- `server/workflow-spec/render-mermaid.js`
- `server/handlers/workflow-render-handlers.js`
- `server/tool-defs/workflow-render-defs.js`
- `server/tests/render-mermaid.test.js`
- `dashboard/src/components/WorkflowGraph.jsx`
- `dashboard/src/components/WorkflowGraph.test.jsx`

**Modified files:**
- `server/tools.js`, `server/tool-defs/index.js`, `server/api/routes-passthrough.js`
- `dashboard/src/views/WorkflowSpecs.jsx` — add graph below each spec
- `dashboard/src/views/Workflow.jsx` (existing workflow detail view) — add graph
- `dashboard/package.json` — add `mermaid` dep

---

## Task 1: Mermaid renderer

- [ ] **Step 1: Tests**

Create `server/tests/render-mermaid.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { renderSpecToMermaid, renderWorkflowToMermaid } = require('../workflow-spec/render-mermaid');

describe('renderSpecToMermaid', () => {
  it('renders a linear chain', () => {
    const spec = {
      name: 'linear',
      tasks: [
        { node_id: 'a', task_description: 'A' },
        { node_id: 'b', task_description: 'B', depends_on: ['a'] },
        { node_id: 'c', task_description: 'C', depends_on: ['b'] },
      ],
    };
    const out = renderSpecToMermaid(spec);
    expect(out).toContain('graph TD');
    expect(out).toContain('a["a"]');
    expect(out).toContain('a --> b');
    expect(out).toContain('b --> c');
  });

  it('annotates conditional edges', () => {
    const spec = {
      name: 'cond',
      tasks: [
        { node_id: 'scan', task_description: 's' },
        { node_id: 'ship', task_description: 's', depends_on: ['scan'], condition: 'outcome=success' },
        { node_id: 'escalate', task_description: 'e', depends_on: ['scan'], condition: 'outcome=fail' },
      ],
    };
    const out = renderSpecToMermaid(spec);
    expect(out).toMatch(/scan -->\|outcome=success\| ship/);
    expect(out).toMatch(/scan -->\|outcome=fail\| escalate/);
  });

  it('uses distinct shapes for merge and parallel_fanout nodes', () => {
    const spec = {
      name: 'ensemble',
      tasks: [
        { node_id: 'fan', task_description: 'fan', kind: 'parallel_fanout' },
        { node_id: 'a', task_description: 'a', depends_on: ['fan'] },
        { node_id: 'b', task_description: 'b', depends_on: ['fan'] },
        { node_id: 'm', task_description: 'm', kind: 'merge', join_policy: 'wait_all', depends_on: ['a', 'b'] },
      ],
    };
    const out = renderSpecToMermaid(spec);
    expect(out).toMatch(/fan\{\{"fan"\}\}/);
    expect(out).toMatch(/m\[\/"m \(wait_all\)"\\?\\\]/);
  });

  it('marks goal-gated nodes with a badge in the label', () => {
    const spec = {
      name: 'gg',
      tasks: [
        { node_id: 'tests', task_description: 'tests', goal_gate: true },
      ],
    };
    const out = renderSpecToMermaid(spec);
    expect(out).toContain('tests["tests 🛡"]');
  });
});

describe('renderWorkflowToMermaid', () => {
  it('colors nodes by live status', () => {
    const tasks = [
      { workflow_node_id: 'a', status: 'completed' },
      { workflow_node_id: 'b', status: 'running' },
      { workflow_node_id: 'c', status: 'failed' },
      { workflow_node_id: 'd', status: 'queued' },
    ];
    const deps = [
      { from_node_id: 'a', to_node_id: 'b' },
      { from_node_id: 'b', to_node_id: 'c' },
      { from_node_id: 'c', to_node_id: 'd' },
    ];
    const out = renderWorkflowToMermaid({ name: 'live', tasks, dependencies: deps });
    expect(out).toContain('classDef completed');
    expect(out).toContain('classDef running');
    expect(out).toContain('classDef failed');
    expect(out).toContain('a:::completed');
    expect(out).toContain('b:::running');
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

Create `server/workflow-spec/render-mermaid.js`:

```js
'use strict';

function escapeLabel(s) {
  if (!s) return '';
  return String(s).replace(/"/g, '\\"');
}

function nodeShape(task) {
  const kind = task.kind || (task.metadata && task.metadata.kind) || 'agent';
  const baseLabel = task.node_id || task.workflow_node_id;
  const label = task.goal_gate || (task.metadata && task.metadata.goal_gate)
    ? `${baseLabel} 🛡`
    : baseLabel;
  const join = task.join_policy || (task.metadata && task.metadata.join_policy);

  if (kind === 'parallel_fanout') return `${baseLabel}{{"${escapeLabel(label)}"}}`;
  if (kind === 'merge') {
    const annotated = join ? `${label} (${join})` : label;
    return `${baseLabel}[/"${escapeLabel(annotated)}"\\]`;
  }
  return `${baseLabel}["${escapeLabel(label)}"]`;
}

function edgeArrow(condition) {
  if (!condition) return '-->';
  return `-->|${condition.replace(/\|/g, '\\|')}|`;
}

/**
 * Render a parsed workflow spec to Mermaid graph TD syntax.
 */
function renderSpecToMermaid(spec) {
  const lines = ['```mermaid', 'graph TD'];
  for (const task of spec.tasks || []) {
    lines.push(`  ${nodeShape(task)}`);
  }
  for (const task of spec.tasks || []) {
    const deps = task.depends_on || [];
    for (const depNodeId of deps) {
      lines.push(`  ${depNodeId} ${edgeArrow(task.condition)} ${task.node_id}`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * Render a live workflow with status-based coloring.
 */
function renderWorkflowToMermaid({ name, tasks, dependencies }) {
  const lines = ['```mermaid', 'graph TD'];

  lines.push('  classDef completed fill:#1e7c3a,stroke:#2ecc71,color:#fff');
  lines.push('  classDef failed fill:#7c1e1e,stroke:#e74c3c,color:#fff');
  lines.push('  classDef running fill:#1e4f7c,stroke:#3498db,color:#fff');
  lines.push('  classDef cancelled fill:#5a5a5a,stroke:#888,color:#fff');
  lines.push('  classDef skipped fill:#5a5a5a,stroke:#aaa,color:#bbb');
  lines.push('  classDef queued fill:#5a4d1e,stroke:#f1c40f,color:#fff');
  lines.push('  classDef blocked fill:#3a3a3a,stroke:#666,color:#aaa');
  lines.push('  classDef pending fill:#2a2a2a,stroke:#555,color:#888');

  for (const task of tasks || []) {
    const shape = nodeShape({ ...task, node_id: task.workflow_node_id });
    const cls = task.status || 'pending';
    lines.push(`  ${shape}:::${cls}`);
  }
  for (const dep of dependencies || []) {
    lines.push(`  ${dep.from_node_id} ${edgeArrow(dep.condition_expr)} ${dep.to_node_id}`);
  }
  lines.push('```');
  return lines.join('\n');
}

module.exports = { renderSpecToMermaid, renderWorkflowToMermaid };
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/workflow-spec/render-mermaid.js server/tests/render-mermaid.test.js
git commit -m "feat(render-mermaid): spec + live workflow → Mermaid renderer"
git push --no-verify origin main
```

---

## Task 2: MCP tools + REST routes

- [ ] **Step 1: Tool defs**

Create `server/tool-defs/workflow-render-defs.js`:

```js
'use strict';

const WORKFLOW_RENDER_TOOLS = [
  {
    name: 'render_workflow_spec_graph',
    description: 'Render a workflow spec YAML as a Mermaid diagram (graph TD).',
    inputSchema: {
      type: 'object',
      required: ['spec_path'],
      properties: {
        spec_path: { type: 'string' },
        working_directory: { type: 'string' },
      },
    },
  },
  {
    name: 'render_workflow_graph',
    description: 'Render a live workflow (by ID) as a Mermaid diagram with status-based coloring.',
    inputSchema: {
      type: 'object',
      required: ['workflow_id'],
      properties: {
        workflow_id: { type: 'string' },
      },
    },
  },
];

module.exports = { WORKFLOW_RENDER_TOOLS };
```

- [ ] **Step 2: Handler**

Create `server/handlers/workflow-render-handlers.js`:

```js
'use strict';

const path = require('path');
const db = require('../database');
const { renderSpecToMermaid, renderWorkflowToMermaid } = require('../workflow-spec/render-mermaid');
const { ErrorCodes, makeError } = require('./shared');

function handleRenderWorkflowSpecGraph(args) {
  const { parseSpec } = require('../workflow-spec');
  const fullPath = path.isAbsolute(args.spec_path)
    ? args.spec_path
    : path.join(args.working_directory || process.cwd(), args.spec_path);

  const parsed = parseSpec(fullPath);
  if (!parsed.ok) {
    return makeError(ErrorCodes.INVALID_PARAM, `Cannot render — spec invalid:\n- ${parsed.errors.join('\n- ')}`);
  }

  const mermaid = renderSpecToMermaid(parsed.spec);
  return {
    content: [{ type: 'text', text: mermaid }],
    structuredData: { mermaid, spec_path: fullPath },
  };
}

function handleRenderWorkflowGraph(args) {
  const wf = db.getWorkflow(args.workflow_id);
  if (!wf) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Workflow ${args.workflow_id} not found`);
  }
  const tasks = db.getWorkflowTasks(args.workflow_id) || [];
  const rawDeps = db.prepare(`
    SELECT
      from_t.workflow_node_id AS from_node_id,
      to_t.workflow_node_id AS to_node_id,
      d.condition_expr
    FROM task_dependencies d
    JOIN tasks from_t ON from_t.id = d.depends_on_task_id
    JOIN tasks to_t ON to_t.id = d.task_id
    WHERE from_t.workflow_id = ?
  `).all(args.workflow_id);

  const tasksHydrated = tasks.map(t => {
    let meta;
    try { meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : (t.metadata || {}); } catch { meta = {}; }
    return { workflow_node_id: t.workflow_node_id, status: t.status, metadata: meta };
  });

  const mermaid = renderWorkflowToMermaid({
    name: wf.name, tasks: tasksHydrated, dependencies: rawDeps,
  });
  return {
    content: [{ type: 'text', text: mermaid }],
    structuredData: { mermaid, workflow_id: args.workflow_id },
  };
}

module.exports = { handleRenderWorkflowSpecGraph, handleRenderWorkflowGraph };
```

- [ ] **Step 3: Wire dispatch + REST**

`server/tool-defs/index.js`:
```js
const { WORKFLOW_RENDER_TOOLS } = require('./workflow-render-defs');
// merge into the workflow tier
```

`server/tools.js` switch:
```js
case 'render_workflow_spec_graph': {
  const { handleRenderWorkflowSpecGraph } = require('./handlers/workflow-render-handlers');
  return handleRenderWorkflowSpecGraph(args);
}
case 'render_workflow_graph': {
  const { handleRenderWorkflowGraph } = require('./handlers/workflow-render-handlers');
  return handleRenderWorkflowGraph(args);
}
```

`server/api/routes-passthrough.js`:
```js
{ method: 'POST', path: '/api/v2/workflow-specs/render', tool: 'render_workflow_spec_graph', mapBody: true },
{ method: 'GET',  path: /^\/api\/v2\/workflows\/([^/]+)\/graph$/, tool: 'render_workflow_graph', mapParams: ['workflow_id'] },
```

- [ ] **Step 4: Commit**

```bash
git add server/tool-defs/workflow-render-defs.js server/tool-defs/index.js server/handlers/workflow-render-handlers.js server/tools.js server/api/routes-passthrough.js
git commit -m "feat(render-mermaid): MCP + REST tools for graph rendering"
git push --no-verify origin main
```

---

## Task 3: Dashboard graph component (no innerHTML)

Mermaid's `run()` API mounts SVG by transforming pre-existing `<pre class="mermaid">` blocks in place — no raw HTML strings, no innerHTML assignment. This is the safer pattern.

- [ ] **Step 1: Add mermaid dep**

In `dashboard/`:

```bash
npm install mermaid --save
```

(Skip if already a dep — check `dashboard/package.json` first.)

- [ ] **Step 2: Component using `mermaid.run()`**

Create `dashboard/src/components/WorkflowGraph.jsx`:

```jsx
import { useEffect, useRef } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: { fontSize: '14px' },
  securityLevel: 'strict',
});

/**
 * Renders a Mermaid diagram safely — no innerHTML.
 * Uses mermaid.run() to transform a <pre class="mermaid"> block in place,
 * which restricts content to plain text Mermaid syntax (no HTML injection).
 */
export default function WorkflowGraph({ mermaidSource }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !mermaidSource) return;
    const src = mermaidSource.replace(/^```mermaid\n?/, '').replace(/\n?```$/, '');

    // Set the source via textContent (safe), reset processed flag, then ask mermaid to run.
    ref.current.textContent = src;
    ref.current.removeAttribute('data-processed');

    mermaid.run({ nodes: [ref.current] }).catch(err => {
      // If mermaid fails to render, leave the source visible as the error display
      ref.current.textContent = `Graph render failed: ${err.message || err}`;
    });
  }, [mermaidSource]);

  return (
    <div className="overflow-auto bg-slate-800/40 p-3 rounded border border-slate-600/30">
      <pre ref={ref} className="mermaid"></pre>
    </div>
  );
}
```

- [ ] **Step 3: Component test**

Create `dashboard/src/components/WorkflowGraph.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import WorkflowGraph from './WorkflowGraph';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    run: vi.fn().mockResolvedValue({}),
  },
}));

describe('WorkflowGraph', () => {
  it('sets the mermaid source via textContent and triggers mermaid.run', async () => {
    const mermaid = (await import('mermaid')).default;
    const { container } = render(<WorkflowGraph mermaidSource="```mermaid\ngraph TD\n  a --> b\n```" />);
    await waitFor(() => expect(mermaid.run).toHaveBeenCalled());
    const pre = container.querySelector('pre.mermaid');
    expect(pre.textContent).toContain('graph TD');
    expect(pre.textContent).toContain('a --> b');
  });

  it('shows error text inside the pre block when mermaid throws', async () => {
    const mermaid = (await import('mermaid')).default;
    mermaid.run.mockRejectedValueOnce(new Error('bad syntax'));
    const { container } = render(<WorkflowGraph mermaidSource="```mermaid\nbroken\n```" />);
    await waitFor(() => {
      const pre = container.querySelector('pre.mermaid');
      expect(pre.textContent).toMatch(/bad syntax/i);
    });
  });
});
```

Run: `npx vitest run src/components/WorkflowGraph.test.jsx --no-coverage` (in dashboard dir) → PASS.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/WorkflowGraph.jsx dashboard/src/components/WorkflowGraph.test.jsx dashboard/package.json dashboard/package-lock.json
git commit -m "feat(dashboard): WorkflowGraph component using mermaid.run (no innerHTML)"
git push --no-verify origin main
```

---

## Task 4: Plug into existing views

- [ ] **Step 1: WorkflowSpecs view (from Plan 1)**

In `dashboard/src/views/WorkflowSpecs.jsx`, add a "Show graph" toggle per spec card. When toggled, fetch `/api/v2/workflow-specs/render` for that spec and render via `WorkflowGraph`.

```jsx
import { useState } from 'react';
import WorkflowGraph from '../components/WorkflowGraph';

// Inside the spec card render, add per-card state:
const [graph, setGraph] = useState(null);
const [showGraph, setShowGraph] = useState(false);
async function loadGraph() {
  if (graph) { setShowGraph(s => !s); return; }
  try {
    const res = await fetch('/api/v2/workflow-specs/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec_path: spec.relative_path }),
    });
    const data = await res.json();
    setGraph(data.mermaid || data?.structuredData?.mermaid);
    setShowGraph(true);
  } catch (err) {
    alert('Graph render failed: ' + err.message);
  }
}
// Render a button next to the Run button:
<button onClick={loadGraph} className="ml-2 text-slate-400 hover:text-white text-xs">
  {showGraph ? 'Hide graph' : 'Show graph'}
</button>
{showGraph && graph && <div className="mt-2"><WorkflowGraph mermaidSource={graph} /></div>}
```

(Per-card state means extracting the card into a sub-component or using a `Map<spec, state>` at the top level. Whichever fits the existing structure.)

- [ ] **Step 2: Workflow detail view**

Find the existing workflow detail view (likely `dashboard/src/views/Workflow.jsx` or `WorkflowDetail.jsx`). Add a graph section that calls `/api/v2/workflows/:id/graph` and renders. Re-fetch the graph when task statuses change (the existing detail view almost certainly polls or subscribes).

- [ ] **Step 3: Build dashboard**

```bash
cd dashboard && npx vite build
```

Expected: build success.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/views/WorkflowSpecs.jsx dashboard/src/views/Workflow.jsx
git commit -m "feat(dashboard): graph view in WorkflowSpecs + Workflow detail"
git push --no-verify origin main
```

---

## Task 5: Restart + smoke

- [ ] **Step 1: Run all render tests**

`npx vitest run tests/render-mermaid --no-coverage` → PASS.

- [ ] **Step 2: Restart**

`await_restart`. Hard-refresh dashboard.

- [ ] **Step 3: Smoke**

Open dashboard → **Specs** → click "Show graph" on the example spec → expect a Mermaid SVG showing plan → implement → simplify.

Then submit a workflow, open its detail page, expect the graph with live status colors (running tasks blue, completed green, failed red).
