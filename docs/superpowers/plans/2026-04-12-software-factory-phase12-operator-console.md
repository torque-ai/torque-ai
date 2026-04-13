# Software Factory Phase 12: Operator Console

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn `dashboard/src/views/Factory.jsx` from a read-only dashboard into an operator console. Four focused changes: a cross-project **approval inbox** pinned to the top, a **plan drill-in** modal for `source=plan_file` intake items, a **live execution pane** that tails the active TORQUE task when a project is in `EXECUTE`, and **intake triage mode** with multi-select + bulk actions. Today the page surfaces state; after this plan it surfaces *decisions the operator needs to make*.

**Architecture:** No backend module rewrite. Four new React components under `dashboard/src/components/factory/` plus one small REST addition (`GET /factory/approvals` — aggregated pending gates across all projects). Existing APIs cover everything else: `factory.approveGate`, `factory.loopStatus`, `factory.intake`, `factory.rejectWorkItem`, `tasks.logs`. The new approval inbox polls every 5s; the execution pane subscribes to task SSE when possible and falls back to polling.

**Tech Stack:** React, Tailwind (existing design system), the existing `factoryApi` client. Depends on Phases 9–11 for any of this to have real data; the components render fine on empty state.

---

## File Structure

**New files:**
- `server/handlers/factory-approvals.js` — aggregator for pending gates across projects
- `dashboard/src/components/factory/ApprovalInbox.jsx`
- `dashboard/src/components/factory/PlanDrillIn.jsx`
- `dashboard/src/components/factory/ExecutionPane.jsx`
- `dashboard/src/components/factory/IntakeTriage.jsx`
- `server/tests/factory-approvals-handler.test.js`
- `dashboard/src/components/factory/ApprovalInbox.test.jsx`
- `dashboard/src/components/factory/PlanDrillIn.test.jsx`
- `dashboard/src/components/factory/ExecutionPane.test.jsx`
- `dashboard/src/components/factory/IntakeTriage.test.jsx`

**Modified files:**
- `server/api-server.js` — wire `GET /v2/factory/approvals` route
- `dashboard/src/api.js` — add `factory.listApprovals()` + `factory.bulkUpdateIntake()` + `factory.readPlanFile()`
- `dashboard/src/views/Factory.jsx` — mount the four new components, replace the existing intake list
- `server/db/factory-intake.js` — add `bulkUpdate({ ids, patch })` helper

---

## Task 1: Approvals aggregator + Approval Inbox

- [ ] **Step 1: Backend tests**

Create `server/tests/factory-approvals-handler.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/setup-test-db');
const { buildApprovalQueue } = require('../handlers/factory-approvals');

describe('factory-approvals aggregator', () => {
  let db;
  beforeEach(() => {
    db = setupTestDb([
      '011-factory-work-items.sql',
      '012-factory-projects.sql',
      '013-factory-loop.sql',
    ]);
  });

  it('returns empty array when no projects are paused at a gate', () => {
    db.prepare('INSERT INTO factory_projects (id, name, trust_level, current_state) VALUES (?, ?, ?, ?)').run('p1', 'proj', 'supervised', 'IDLE');
    expect(buildApprovalQueue({ db })).toEqual([]);
  });

  it('lists one entry per paused project with pending stage + work item context', () => {
    db.prepare('INSERT INTO factory_projects (id, name, trust_level, current_state, paused_at_stage) VALUES (?, ?, ?, ?, ?)').run('p1', 'proj', 'supervised', 'PAUSED', 'PRIORITIZE');
    db.prepare('INSERT INTO factory_work_items (project_id, source, title, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('p1', 'plan_file', 'Feature X', 50, 'prioritized', '2026-04-12', '2026-04-12');
    const queue = buildApprovalQueue({ db });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ project_id: 'p1', stage: 'PRIORITIZE', trust_level: 'supervised' });
    expect(queue[0].work_item.title).toBe('Feature X');
  });

  it('orders by project name then paused_at ascending (oldest-first)', () => {
    db.prepare('INSERT INTO factory_projects (id, name, trust_level, current_state, paused_at_stage, paused_at) VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'beta', 'supervised', 'PAUSED', 'PLAN', '2026-04-12T10:00:00Z');
    db.prepare('INSERT INTO factory_projects (id, name, trust_level, current_state, paused_at_stage, paused_at) VALUES (?, ?, ?, ?, ?, ?)').run('p2', 'alpha', 'supervised', 'PAUSED', 'VERIFY', '2026-04-12T09:00:00Z');
    const queue = buildApprovalQueue({ db });
    expect(queue.map(q => q.project_id)).toEqual(['p2', 'p1']);
  });

  it('skips projects that are paused but have no gated stage (operator pause)', () => {
    db.prepare('INSERT INTO factory_projects (id, name, trust_level, current_state, paused_at_stage) VALUES (?, ?, ?, ?, ?)').run('p1', 'proj', 'supervised', 'PAUSED', null);
    expect(buildApprovalQueue({ db })).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement aggregator**

Create `server/handlers/factory-approvals.js`:

```js
'use strict';

function buildApprovalQueue({ db }) {
  const rows = db.prepare(`
    SELECT p.id AS project_id, p.name, p.trust_level, p.current_state, p.paused_at_stage, p.paused_at,
           p.current_work_item_id
    FROM factory_projects p
    WHERE p.current_state = 'PAUSED' AND p.paused_at_stage IS NOT NULL
    ORDER BY p.name ASC, p.paused_at ASC
  `).all();

  const out = [];
  for (const row of rows) {
    const wi = row.current_work_item_id
      ? db.prepare('SELECT id, title, source, priority, status, origin_json FROM factory_work_items WHERE id = ?').get(row.current_work_item_id)
      : null;
    let origin = null;
    if (wi?.origin_json) {
      try { origin = JSON.parse(wi.origin_json); } catch { origin = null; }
    }
    out.push({
      project_id: row.project_id,
      project_name: row.name,
      trust_level: row.trust_level,
      stage: row.paused_at_stage,
      paused_at: row.paused_at,
      work_item: wi ? { ...wi, origin } : null,
    });
  }
  return out;
}

module.exports = { buildApprovalQueue };
```

Wire into `server/api-server.js`:

```js
const { buildApprovalQueue } = require('./handlers/factory-approvals');

app.get('/v2/factory/approvals', (req, res) => {
  try {
    const queue = buildApprovalQueue({ db: container.get('db') });
    res.json({ approvals: queue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Commit: `feat(factory): cross-project approval queue aggregator + REST route`.

- [ ] **Step 3: Dashboard API client**

In `dashboard/src/api.js`, add to the `factory` export:

```js
listApprovals: (opts = {}) => requestV2('/factory/approvals', opts),
bulkUpdateIntake: (projectId, data, opts = {}) => requestV2(`/factory/projects/${projectId}/intake/bulk`, { method: 'POST', body: JSON.stringify(data), ...opts }),
readPlanFile: (params, opts = {}) => requestV2(`/factory/plans/read${buildQuery(params)}`, opts),
```

- [ ] **Step 4: Component tests**

Create `dashboard/src/components/factory/ApprovalInbox.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ApprovalInbox from './ApprovalInbox';

const APPROVALS = [
  { project_id: 'p1', project_name: 'torque-public', trust_level: 'supervised', stage: 'PRIORITIZE', paused_at: '2026-04-12T10:00:00Z', work_item: { id: 42, title: 'Plan 1: Workflow-as-Code', source: 'plan_file' } },
];

describe('ApprovalInbox', () => {
  it('renders nothing when queue is empty', () => {
    const { container } = render(<ApprovalInbox approvals={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows one row per pending approval with project, stage, work item', () => {
    render(<ApprovalInbox approvals={APPROVALS} />);
    expect(screen.getByText(/torque-public/)).toBeTruthy();
    expect(screen.getByText(/PRIORITIZE/)).toBeTruthy();
    expect(screen.getByText(/Plan 1: Workflow-as-Code/)).toBeTruthy();
  });

  it('calls onApprove with project_id + stage when approve clicked', async () => {
    const onApprove = vi.fn().mockResolvedValue();
    render(<ApprovalInbox approvals={APPROVALS} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith('p1', 'PRIORITIZE'));
  });

  it('calls onReject when reject clicked', async () => {
    const onReject = vi.fn().mockResolvedValue();
    render(<ApprovalInbox approvals={APPROVALS} onReject={onReject} />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    await waitFor(() => expect(onReject).toHaveBeenCalledWith('p1', 'PRIORITIZE'));
  });

  it('disables buttons while busy', () => {
    render(<ApprovalInbox approvals={APPROVALS} busyKeys={['p1:PRIORITIZE']} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject/i })).toBeDisabled();
  });
});
```

- [ ] **Step 5: Implement ApprovalInbox**

Create `dashboard/src/components/factory/ApprovalInbox.jsx`:

```jsx
import { useState } from 'react';

export default function ApprovalInbox({ approvals = [], busyKeys = [], onApprove, onReject }) {
  const [localBusy, setLocalBusy] = useState({});
  if (approvals.length === 0) return null;
  const isBusy = (k) => busyKeys.includes(k) || localBusy[k];

  async function handle(fn, projectId, stage) {
    const key = `${projectId}:${stage}`;
    setLocalBusy(b => ({ ...b, [key]: true }));
    try { await fn?.(projectId, stage); } finally { setLocalBusy(b => ({ ...b, [key]: false })); }
  }

  return (
    <section className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-amber-200">Awaiting your approval ({approvals.length})</h2>
      </header>
      <ul className="divide-y divide-amber-500/20">
        {approvals.map(a => {
          const key = `${a.project_id}:${a.stage}`;
          return (
            <li key={key} className="flex items-center justify-between py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-100">
                  <span className="font-semibold">{a.project_name}</span>
                  <span className="mx-2 text-slate-400">·</span>
                  <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-200">{a.stage}</span>
                </div>
                {a.work_item ? (
                  <div className="mt-1 text-xs text-slate-400 truncate">
                    {a.work_item.source === 'plan_file' ? '📄 ' : ''}
                    {a.work_item.title}
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-slate-500 italic">No work item attached</div>
                )}
              </div>
              <div className="ml-4 flex gap-2 shrink-0">
                <button
                  aria-label="Approve"
                  onClick={() => handle(onApprove, a.project_id, a.stage)}
                  disabled={isBusy(key)}
                  className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                  Approve
                </button>
                <button
                  aria-label="Reject"
                  onClick={() => handle(onReject, a.project_id, a.stage)}
                  disabled={isBusy(key)}
                  className="rounded bg-slate-700 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-600 disabled:opacity-50">
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 6: Mount in Factory.jsx**

In `Factory.jsx`, add state + poll:

```jsx
const [approvals, setApprovals] = useState([]);
useEffect(() => {
  let cancelled = false;
  const poll = async () => {
    try {
      const res = await factoryApi.listApprovals();
      if (!cancelled) setApprovals(res?.approvals || []);
    } catch { /* swallow */ }
  };
  poll();
  const interval = setInterval(poll, 5000);
  return () => { cancelled = true; clearInterval(interval); };
}, []);

const handleApprove = useCallback(async (projectId, stage) => {
  await factoryApi.approveGate(projectId, stage);
  toast.success(`Approved ${stage} for ${projectId}`);
  const res = await factoryApi.listApprovals();
  setApprovals(res?.approvals || []);
}, [toast]);
```

Render `<ApprovalInbox approvals={approvals} onApprove={handleApprove} onReject={handleReject} />` as the very first child inside the main content area.

Commit: `feat(factory-ui): approval inbox panel (cross-project, 5s poll)`.

---

## Task 2: Plan drill-in modal

- [ ] **Step 1: Tests**

Create `dashboard/src/components/factory/PlanDrillIn.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlanDrillIn from './PlanDrillIn';

const PLAN = {
  title: 'Feature X Plan',
  goal: 'Build feature X.',
  tech_stack: 'Node.js',
  tasks: [
    { task_number: 1, task_title: 'Schema', completed: true, steps: [{ step_number: 1, title: 'Tests', done: true }, { step_number: 2, title: 'Impl', done: true }] },
    { task_number: 2, task_title: 'API', completed: false, steps: [{ step_number: 1, title: 'Tests', done: false }, { step_number: 2, title: 'Impl', done: false }] },
  ],
};

describe('PlanDrillIn', () => {
  it('returns null when no item', () => {
    const { container } = render(<PlanDrillIn item={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows title, goal, tech stack, task list with completion state', async () => {
    const fetchPlan = vi.fn().mockResolvedValue(PLAN);
    render(<PlanDrillIn item={{ id: 1, origin: { plan_path: '/x.md' } }} fetchPlan={fetchPlan} />);
    await waitFor(() => expect(screen.getByText('Feature X Plan')).toBeTruthy());
    expect(screen.getByText(/Build feature X/)).toBeTruthy();
    expect(screen.getByText('Task 1: Schema')).toBeTruthy();
    expect(screen.getByText('Task 2: API')).toBeTruthy();
    expect(screen.getByText(/2 \/ 2 steps/)).toBeTruthy(); // Task 1 complete
    expect(screen.getByText(/0 \/ 2 steps/)).toBeTruthy(); // Task 2 pending
  });

  it('calls onExecute with item id when Execute clicked', async () => {
    const onExecute = vi.fn().mockResolvedValue();
    render(<PlanDrillIn item={{ id: 42, origin: { plan_path: '/x.md' } }} fetchPlan={() => Promise.resolve(PLAN)} onExecute={onExecute} />);
    await waitFor(() => screen.getByText('Feature X Plan'));
    fireEvent.click(screen.getByRole('button', { name: /execute/i }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(42));
  });

  it('calls onClose when Close clicked', async () => {
    const onClose = vi.fn();
    render(<PlanDrillIn item={{ id: 1, origin: { plan_path: '/x.md' } }} fetchPlan={() => Promise.resolve(PLAN)} onClose={onClose} />);
    await waitFor(() => screen.getByText('Feature X Plan'));
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Add `GET /factory/plans/read` route**

In `server/api-server.js`:

```js
const fs = require('fs');
const { parsePlanFile } = require('./factory/plan-parser'); // Phase 10

app.get('/v2/factory/plans/read', (req, res) => {
  try {
    const planPath = String(req.query.plan_path || '');
    if (!planPath) return res.status(400).json({ error: 'plan_path required' });
    if (!fs.existsSync(planPath)) return res.status(404).json({ error: 'plan_path not found' });
    const content = fs.readFileSync(planPath, 'utf8');
    res.json(parsePlanFile(content));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

**If Phase 10 has not landed yet**, this task depends on it. Mark the Task blocked and start Task 3 first.

- [ ] **Step 3: Implement PlanDrillIn**

Create `dashboard/src/components/factory/PlanDrillIn.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { factory as factoryApi } from '../../api';

export default function PlanDrillIn({ item, fetchPlan, onExecute, onClose }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!item?.origin?.plan_path) return;
    let cancelled = false;
    setLoading(true);
    const fetcher = fetchPlan || ((path) => factoryApi.readPlanFile({ plan_path: path }));
    fetcher(item.origin.plan_path)
      .then(p => !cancelled && setPlan(p))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [item, fetchPlan]);

  if (!item) return null;

  async function handleExecute() {
    setBusy(true);
    try { await onExecute?.(item.id); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-3xl rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        {loading && <div className="text-sm text-slate-400">Loading plan…</div>}
        {plan && (
          <>
            <header className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">{plan.title}</h3>
                {plan.goal && <p className="mt-1 text-sm text-slate-400">{plan.goal}</p>}
                {plan.tech_stack && <p className="mt-1 text-xs text-slate-500">Tech: {plan.tech_stack}</p>}
              </div>
              <button aria-label="Close" onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
            </header>
            <ul className="mb-5 max-h-96 divide-y divide-slate-700 overflow-y-auto rounded border border-slate-700">
              {plan.tasks.map(t => {
                const done = t.steps.filter(s => s.done).length;
                return (
                  <li key={t.task_number} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className={t.completed ? 'text-emerald-300 line-through' : 'text-slate-200'}>
                      Task {t.task_number}: {t.task_title}
                    </span>
                    <span className="text-xs text-slate-500">{done} / {t.steps.length} steps</span>
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end gap-3">
              <button onClick={onClose} className="rounded bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600">Close</button>
              <button onClick={handleExecute} disabled={busy} className="rounded bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy ? 'Submitting…' : 'Execute'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Mount in Factory.jsx**

Add state `const [drillItem, setDrillItem] = useState(null);`. In the intake list render, make the row clickable when `item.source === 'plan_file'`: `onClick={() => setDrillItem(item)}`. Render `<PlanDrillIn item={drillItem} onClose={() => setDrillItem(null)} onExecute={handleExecutePlan} />` at the end of the component. Implement `handleExecutePlan(itemId)` to call an MCP tool or REST endpoint that kicks EXECUTE for that work item — if Phase 10 doesn't expose one yet, stub to toast `"not yet wired"`.

Commit: `feat(factory-ui): plan drill-in modal with task completion preview`.

---

## Task 3: Live execution pane

- [ ] **Step 1: Tests**

Create `dashboard/src/components/factory/ExecutionPane.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ExecutionPane from './ExecutionPane';

describe('ExecutionPane', () => {
  it('returns null when project not in EXECUTE', () => {
    const { container } = render(<ExecutionPane project={{ current_state: 'IDLE' }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders active task id + status + last 20 log lines when EXECUTEing', async () => {
    const fetchActiveTask = vi.fn().mockResolvedValue({ task_id: 't_42', status: 'running', progress: 60 });
    const fetchLogs = vi.fn().mockResolvedValue({ lines: ['line 1', 'line 2', 'line 3'] });
    render(<ExecutionPane project={{ id: 'p1', current_state: 'EXECUTE', current_work_item_id: 7 }} fetchActiveTask={fetchActiveTask} fetchLogs={fetchLogs} />);
    await waitFor(() => expect(screen.getByText(/t_42/)).toBeTruthy());
    expect(screen.getByText(/running/)).toBeTruthy();
    expect(screen.getByText('line 3')).toBeTruthy();
  });

  it('shows empty state when no active task found', async () => {
    render(<ExecutionPane project={{ id: 'p1', current_state: 'EXECUTE' }} fetchActiveTask={() => Promise.resolve(null)} fetchLogs={() => Promise.resolve({ lines: [] })} />);
    await waitFor(() => expect(screen.getByText(/no active task/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Implement**

Create `dashboard/src/components/factory/ExecutionPane.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { tasks as tasksApi, factory as factoryApi } from '../../api';

export default function ExecutionPane({ project, fetchActiveTask, fetchLogs }) {
  const [task, setTask] = useState(null);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    if (project?.current_state !== 'EXECUTE') return;
    let cancelled = false;
    const taskFetcher = fetchActiveTask || (async () => {
      const res = await factoryApi.loopStatus(project.id);
      return res?.active_task || null;
    });
    const logsFetcher = fetchLogs || (async (taskId) => tasksApi.logs(taskId, { tail: 20 }));

    const tick = async () => {
      const t = await taskFetcher();
      if (cancelled) return;
      setTask(t);
      if (t?.task_id) {
        const l = await logsFetcher(t.task_id);
        if (!cancelled) setLogs(l?.lines || []);
      }
    };
    tick();
    const interval = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [project, fetchActiveTask, fetchLogs]);

  if (project?.current_state !== 'EXECUTE') return null;

  return (
    <section className="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
      <header className="mb-2 flex items-center justify-between text-sm">
        <h3 className="font-semibold text-sky-200">Active execution</h3>
        {task && <span className="text-xs text-slate-400">{task.task_id} · {task.status} {task.progress != null ? `· ${task.progress}%` : ''}</span>}
      </header>
      {task ? (
        <pre className="max-h-56 overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-300">
          {logs.join('\n') || '(no output yet)'}
        </pre>
      ) : (
        <div className="text-xs italic text-slate-500">No active task for this project.</div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Mount + smoke**

In `Factory.jsx`, render `<ExecutionPane project={selectedHealth?.project} />` inside the project detail panel, near the loop status badge.

Commit: `feat(factory-ui): live execution pane tails active TORQUE task`.

---

## Task 4: Intake triage mode

- [ ] **Step 1: Backend bulk helper tests**

Create `server/tests/factory-intake-bulk.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/setup-test-db');
const factoryIntake = require('../db/factory-intake');

describe('factory-intake bulkUpdate', () => {
  beforeEach(() => {
    const db = setupTestDb(['011-factory-work-items.sql']);
    factoryIntake.setDb(db);
  });

  it('updates priority + status for a list of ids', () => {
    const a = factoryIntake.createWorkItem({ project_id: 'p1', title: 'A', priority: 'default' });
    const b = factoryIntake.createWorkItem({ project_id: 'p1', title: 'B', priority: 'default' });
    const result = factoryIntake.bulkUpdate({ ids: [a.id, b.id], patch: { priority: 'high' } });
    expect(result.updated).toBe(2);
    expect(factoryIntake.getWorkItem(a.id).priority).toBe(90);
    expect(factoryIntake.getWorkItem(b.id).priority).toBe(90);
  });

  it('rejects unknown patch keys silently (whitelist enforced)', () => {
    const item = factoryIntake.createWorkItem({ project_id: 'p1', title: 'X', priority: 'default' });
    const result = factoryIntake.bulkUpdate({ ids: [item.id], patch: { priority: 'high', evil_column: 'drop' } });
    expect(result.updated).toBe(1);
    expect(factoryIntake.getWorkItem(item.id).priority).toBe(90);
  });

  it('returns updated=0 when ids empty', () => {
    expect(factoryIntake.bulkUpdate({ ids: [], patch: { priority: 'high' } })).toEqual({ updated: 0 });
  });
});
```

- [ ] **Step 2: Implement bulk helper**

Add to `server/db/factory-intake.js`:

```js
function bulkUpdate({ ids, patch }) {
  if (!Array.isArray(ids) || ids.length === 0) return { updated: 0 };
  const allowed = ['priority', 'status'];
  const applied = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) applied[k] = patch[k];
  }
  if (Object.keys(applied).length === 0) return { updated: 0 };

  let count = 0;
  const txn = db.transaction(() => {
    for (const id of ids) {
      updateWorkItem(id, applied);
      count += 1;
    }
  });
  txn();
  return { updated: count };
}

module.exports = { ...module.exports, bulkUpdate };
```

Wire a REST route `POST /v2/factory/projects/:id/intake/bulk` that calls this.

Commit: `feat(factory): bulkUpdate helper + REST route for intake triage`.

- [ ] **Step 3: Component tests**

Create `dashboard/src/components/factory/IntakeTriage.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import IntakeTriage from './IntakeTriage';

const ITEMS = [
  { id: 1, title: 'Plan A', source: 'plan_file', priority: 50, status: 'pending' },
  { id: 2, title: 'Plan B', source: 'plan_file', priority: 50, status: 'pending' },
  { id: 3, title: 'Issue X', source: 'github_issue', priority: 70, status: 'triaged' },
];

describe('IntakeTriage', () => {
  it('renders one row per item', () => {
    render(<IntakeTriage items={ITEMS} />);
    expect(screen.getAllByRole('row')).toHaveLength(ITEMS.length + 1); // +1 for header
  });

  it('filters by source', () => {
    render(<IntakeTriage items={ITEMS} />);
    fireEvent.change(screen.getByLabelText(/source/i), { target: { value: 'plan_file' } });
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 plan_file
  });

  it('selecting checkboxes enables Bulk Update button', () => {
    render(<IntakeTriage items={ITEMS} />);
    expect(screen.getByRole('button', { name: /bulk update/i })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('checkbox', { name: /select row/i })[0]);
    expect(screen.getByRole('button', { name: /bulk update/i })).not.toBeDisabled();
  });

  it('calls onBulkUpdate with selected ids + patch', async () => {
    const onBulkUpdate = vi.fn().mockResolvedValue({ updated: 2 });
    render(<IntakeTriage items={ITEMS} onBulkUpdate={onBulkUpdate} />);
    fireEvent.click(screen.getAllByRole('checkbox', { name: /select row/i })[0]);
    fireEvent.click(screen.getAllByRole('checkbox', { name: /select row/i })[1]);
    fireEvent.change(screen.getByLabelText(/priority/i), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /bulk update/i }));
    await waitFor(() => expect(onBulkUpdate).toHaveBeenCalledWith([1, 2], { priority: 'high' }));
  });

  it('select-all toggles every row', () => {
    render(<IntakeTriage items={ITEMS} />);
    fireEvent.click(screen.getByLabelText(/select all/i));
    for (const cb of screen.getAllByRole('checkbox', { name: /select row/i })) {
      expect(cb).toBeChecked();
    }
  });
});
```

- [ ] **Step 4: Implement IntakeTriage**

Create `dashboard/src/components/factory/IntakeTriage.jsx`:

```jsx
import { useMemo, useState } from 'react';

const PRIORITY_OPTIONS = ['low', 'default', 'medium', 'high', 'user_override'];
const SOURCE_OPTIONS = ['all', 'plan_file', 'github_issue', 'scout', 'manual', 'self_generated'];

export default function IntakeTriage({ items = [], onBulkUpdate, onRowClick }) {
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('all');
  const [bulkPriority, setBulkPriority] = useState('default');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(
    () => filter === 'all' ? items : items.filter(i => i.source === filter),
    [items, filter],
  );

  function toggle(id) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(i => i.id)));
  }

  async function applyBulk() {
    setBusy(true);
    try { await onBulkUpdate?.([...selected], { priority: bulkPriority }); setSelected(new Set()); }
    finally { setBusy(false); }
  }

  return (
    <section className="mt-4 rounded-lg border border-slate-700 bg-slate-900/50 p-4">
      <header className="mb-3 flex items-center gap-4">
        <h3 className="text-sm font-semibold text-slate-100">Intake queue ({filtered.length})</h3>
        <label className="text-xs text-slate-400">
          Source:
          <select aria-label="Source filter" value={filter} onChange={e => setFilter(e.target.value)} className="ml-2 rounded bg-slate-800 px-2 py-1 text-slate-200">
            {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-slate-400">
            Priority:
            <select aria-label="Priority" value={bulkPriority} onChange={e => setBulkPriority(e.target.value)} className="ml-2 rounded bg-slate-800 px-2 py-1 text-slate-200">
              {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <button onClick={applyBulk} disabled={selected.size === 0 || busy} className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
            Bulk Update ({selected.size})
          </button>
        </div>
      </header>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400">
            <th className="w-8">
              <input type="checkbox" aria-label="Select all" checked={filtered.length > 0 && selected.size === filtered.length} onChange={toggleAll} />
            </th>
            <th>Title</th>
            <th>Source</th>
            <th>Priority</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(item => (
            <tr key={item.id} role="row" className="cursor-pointer border-t border-slate-800 hover:bg-slate-800/50" onClick={() => onRowClick?.(item)}>
              <td onClick={e => e.stopPropagation()}>
                <input type="checkbox" aria-label="Select row" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
              </td>
              <td className="py-1 text-slate-100">{item.title}</td>
              <td className="py-1 text-slate-400">{item.source}</td>
              <td className="py-1 text-slate-400">{item.priority}</td>
              <td className="py-1 text-slate-400">{item.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 5: Replace existing intake list in Factory.jsx**

Swap the old intake panel for `<IntakeTriage items={intakeItems} onBulkUpdate={handleBulkUpdate} onRowClick={handleIntakeClick} />`.

```jsx
const handleBulkUpdate = useCallback(async (ids, patch) => {
  await factoryApi.bulkUpdateIntake(selectedProjectId, { ids, patch });
  toast.success(`Updated ${ids.length} items`);
  const res = await factoryApi.intake(selectedProjectId);
  setIntakeItems(getIntakeItemsFromResponse(res));
}, [selectedProjectId, toast]);

const handleIntakeClick = useCallback((item) => {
  if (item.source === 'plan_file') setDrillItem(item);
}, []);
```

Commit: `feat(factory-ui): intake triage table with source filter + bulk priority update`.

---

## Task 5: End-to-end smoke

- [ ] **Step 1: Build + launch + verify**

```bash
cd dashboard && npm run build
# Launch TORQUE (if not running) and open http://localhost:3456/#/factory
```

Checklist to eyeball:
- With no paused projects, Approval Inbox is hidden.
- Register torque-public (Phase 11). Scan plans (Phase 9). Advance loop past SENSE — Approval Inbox appears with PRIORITIZE gate for Plan 1.
- Click a `plan_file` intake row → drill-in modal opens with Plan 1's 10+ tasks listed.
- Approve PRIORITIZE → inbox clears that entry within 5s.
- Advance loop into EXECUTE → Execution Pane appears with active TORQUE task and log tail.
- In intake triage, filter `plan_file`, select 5 items, change priority to `high`, click Bulk Update → rows reflect new priority after refresh.

- [ ] **Step 2: Commit smoke artifacts if any**

If the smoke reveals a layout bug or missing state, fix inline and commit. Otherwise:

```bash
# No-op commit not needed — the visual verification is the deliverable.
```
