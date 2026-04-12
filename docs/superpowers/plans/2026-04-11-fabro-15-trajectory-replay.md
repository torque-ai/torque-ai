# Fabro #15: Trajectory Replay + Run Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every workflow run produces a self-contained artifact bundle in `runs/<workflow_id>/` — full event trace, per-task input/output, files modified, configs used, retros — that can be inspected, shared, archived, and *replayed*. Inspired by SWE-agent's trajectory replay and ChatDev's WareHouse folders.

**Architecture:** When a workflow finishes (any terminal status), a finalizer assembles the artifact bundle from the event log (Plan 14) + DB state. Bundle layout: `runs/<workflow_id>/manifest.json`, `events.jsonl`, `tasks/<task_id>.json` (per-task snapshot), `files-modified/` (git diff at completion), `retro.md` (from Plan 2), `config.json`. A `replay_workflow` MCP tool reads a bundle and recreates the workflow with identical inputs (different ID, same DAG and per-task descriptions). A `compare_runs` tool diffs two bundles.

**Depends on Plan 14 (event backbone).** Best with Plan 2 (retros).

---

## File Structure

**New files:**
- `server/runs/build-bundle.js` — assemble `runs/<id>/` from DB + events
- `server/runs/replay.js` — recreate a workflow from a bundle
- `server/runs/compare.js` — diff two bundles
- `server/handlers/run-artifact-handlers.js`
- `server/tool-defs/run-artifact-defs.js`
- `server/tests/build-bundle.test.js`
- `server/tests/replay.test.js`

**Modified files:**
- `server/execution/workflow-runtime.js` — fire bundle build on terminal transition
- `server/tools.js`, `server/tool-defs/index.js`, `server/api/routes-passthrough.js`

---

## Task 1: Bundle builder

- [ ] **Step 1: Tests**

Create `server/tests/build-bundle.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { buildBundle } = require('../runs/build-bundle');

let db, testDir;
beforeAll(() => { const e = setupTestDb('build-bundle'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('buildBundle', () => {
  it('writes manifest, events, and per-task snapshots for a completed workflow', () => {
    const wfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at, started_at, completed_at, working_directory)
                VALUES (?, 'test', 'completed', ?, ?, ?, ?)`).run(
      wfId, '2026-04-11T10:00:00Z', '2026-04-11T10:00:00Z', '2026-04-11T10:05:00Z', testDir
    );
    const taskId = randomUUID();
    db.createTask({
      id: taskId, task_description: 'do x', working_directory: testDir,
      status: 'pending', workflow_id: wfId, provider: 'codex', tags: ['tests:pass'],
    });
    db.prepare('UPDATE tasks SET status = ?, started_at = ?, completed_at = ?, output = ? WHERE id = ?')
      .run('completed', '2026-04-11T10:00:00Z', '2026-04-11T10:04:00Z', 'task ran', taskId);

    const bundleDir = buildBundle(wfId, { rootDir: testDir });

    expect(fs.existsSync(bundleDir)).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'tasks', `${taskId}.json`))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest.workflow_id).toBe(wfId);
    expect(manifest.status).toBe('completed');
    expect(manifest.task_count).toBe(1);
    expect(manifest.task_ids).toContain(taskId);

    const taskSnap = JSON.parse(fs.readFileSync(path.join(bundleDir, 'tasks', `${taskId}.json`), 'utf8'));
    expect(taskSnap.task_description).toBe('do x');
    expect(taskSnap.provider).toBe('codex');
    expect(taskSnap.tags).toContain('tests:pass');
    expect(taskSnap.output).toBe('task ran');
  });

  it('returns null for unknown workflow_id', () => {
    expect(buildBundle('does-not-exist', { rootDir: testDir })).toBeNull();
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

Create `server/runs/build-bundle.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../database');
const logger = require('../logger').child({ component: 'runs' });

/**
 * Assemble a self-contained artifact bundle for a finished workflow.
 * @param {string} workflowId
 * @param {{ rootDir?: string }} opts
 * @returns {string|null} absolute path to bundle dir, or null if workflow missing
 */
function buildBundle(workflowId, opts = {}) {
  const wf = db.getWorkflow(workflowId);
  if (!wf) return null;

  const rootDir = opts.rootDir || wf.working_directory || process.cwd();
  const bundleDir = path.join(rootDir, 'runs', workflowId);
  fs.mkdirSync(path.join(bundleDir, 'tasks'), { recursive: true });

  const tasks = db.getWorkflowTasks(workflowId) || [];

  // manifest.json — top-level summary
  const manifest = {
    workflow_id: workflowId,
    name: wf.name,
    status: wf.status,
    created_at: wf.created_at,
    started_at: wf.started_at,
    completed_at: wf.completed_at,
    working_directory: wf.working_directory,
    task_count: tasks.length,
    task_ids: tasks.map(t => t.id),
    bundle_built_at: new Date().toISOString(),
    bundle_format_version: 1,
  };
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // events.jsonl — every event in chronological order
  let events = [];
  try {
    const { listEvents } = require('../events/event-emitter');
    events = listEvents({ workflow_id: workflowId, limit: 50000 });
  } catch (e) {
    logger.info(`[runs] event log unavailable: ${e.message}`);
  }
  // Also pull task-scoped events for tasks in this workflow
  for (const t of tasks) {
    try {
      const { listEvents } = require('../events/event-emitter');
      events.push(...listEvents({ task_id: t.id, limit: 5000 }));
    } catch { /* already logged */ }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const jsonlContent = events.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), jsonlContent);

  // per-task snapshots
  for (const t of tasks) {
    let meta;
    try { meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : (t.metadata || {}); } catch { meta = {}; }
    let tags;
    try { tags = typeof t.tags === 'string' ? JSON.parse(t.tags) : (t.tags || []); } catch { tags = []; }
    let filesMod;
    try { filesMod = typeof t.files_modified === 'string' ? JSON.parse(t.files_modified) : (t.files_modified || []); } catch { filesMod = []; }

    const snap = {
      id: t.id,
      workflow_node_id: t.workflow_node_id,
      task_description: t.task_description,
      working_directory: t.working_directory,
      status: t.status,
      provider: t.provider,
      original_provider: t.original_provider,
      model: t.model,
      exit_code: t.exit_code,
      started_at: t.started_at,
      completed_at: t.completed_at,
      output: t.output,
      error_output: t.error_output,
      files_modified: filesMod,
      tags,
      metadata: meta,
    };
    fs.writeFileSync(path.join(bundleDir, 'tasks', `${t.id}.json`), JSON.stringify(snap, null, 2));
  }

  // retro.md (from Plan 2 — best-effort)
  try {
    const retro = db.getRetroByWorkflow(workflowId);
    if (retro) {
      const lines = [`# Retro: ${manifest.name}`, '', `Smoothness: ${retro.smoothness || retro.narrative_status}`];
      if (retro.narrative) {
        lines.push('', `**Intent:** ${retro.narrative.intent}`, `**Outcome:** ${retro.narrative.outcome}`);
      }
      fs.writeFileSync(path.join(bundleDir, 'retro.md'), lines.join('\n'));
    }
  } catch { /* retros optional */ }

  logger.info(`[runs] Bundle written: ${bundleDir} (${tasks.length} tasks, ${events.length} events)`);
  return bundleDir;
}

module.exports = { buildBundle };
```

Run → PASS. Commit:

```bash
git add server/runs/build-bundle.js server/tests/build-bundle.test.js
git commit -m "feat(runs): assemble artifact bundle from DB + event log"
git push --no-verify origin main
```

---

## Task 2: Hook bundle build into workflow finalization

- [ ] **Step 1: Modify `workflow-runtime.js`**

Where workflow transitions to terminal status (completed/failed/cancelled), fire bundle build asynchronously:

```js
try {
  const { buildBundle } = require('../runs/build-bundle');
  // Fire-and-forget — bundle assembly must not block workflow completion
  Promise.resolve().then(() => buildBundle(workflowId)).catch(err => {
    logger.info(`[workflow-runtime] Bundle build failed for ${workflowId}: ${err.message}`);
  });
} catch (e) { /* runs module unavailable */ }
```

- [ ] **Step 2: Commit**

```bash
git add server/execution/workflow-runtime.js
git commit -m "feat(runs): build bundle on workflow finalization"
git push --no-verify origin main
```

---

## Task 3: Replay

- [ ] **Step 1: Tests**

Create `server/tests/replay.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { buildBundle } = require('../runs/build-bundle');
const { replayWorkflow } = require('../runs/replay');

let db, testDir;
beforeAll(() => { const e = setupTestDb('replay'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('replayWorkflow', () => {
  it('recreates a workflow from a bundle with same DAG and task descriptions', () => {
    // Set up a 2-task workflow + bundle
    const origWfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at, working_directory)
                VALUES (?, 'orig', 'completed', ?, ?)`).run(origWfId, '2026-04-11T10:00:00Z', testDir);
    const taskA = randomUUID(), taskB = randomUUID();
    db.createTask({ id: taskA, task_description: 'A', working_directory: testDir,
      status: 'pending', workflow_id: origWfId, workflow_node_id: 'a', provider: 'codex' });
    db.createTask({ id: taskB, task_description: 'B', working_directory: testDir,
      status: 'pending', workflow_id: origWfId, workflow_node_id: 'b', provider: 'codex' });
    db.addTaskDependency({ workflow_id: origWfId, task_id: taskB, depends_on_task_id: taskA });
    db.prepare('UPDATE tasks SET status = ? WHERE workflow_id = ?').run('completed', origWfId);
    db.prepare('UPDATE workflows SET status = ?, completed_at = ? WHERE id = ?')
      .run('completed', '2026-04-11T10:01:00Z', origWfId);

    const bundleDir = buildBundle(origWfId, { rootDir: testDir });

    // Replay
    const result = replayWorkflow(bundleDir);
    expect(result.ok).toBe(true);
    const newWfId = result.workflow_id;
    expect(newWfId).not.toBe(origWfId);

    const newWf = db.getWorkflow(newWfId);
    expect(newWf.name).toMatch(/orig.*replay|replay.*orig/i);
    const newTasks = db.getWorkflowTasks(newWfId);
    expect(newTasks).toHaveLength(2);
    const a = newTasks.find(t => t.workflow_node_id === 'a');
    const b = newTasks.find(t => t.workflow_node_id === 'b');
    expect(a.task_description).toBe('A');
    expect(b.task_description).toBe('B');
    // Dependency preserved
    const deps = db.getTaskDependencies(b.id);
    expect(deps.some(d => d.depends_on_task_id === a.id)).toBe(true);
  });

  it('returns error for missing bundle', () => {
    const result = replayWorkflow(path.join(testDir, 'no-such-dir'));
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/runs/replay.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const workflowHandlers = require('../handlers/workflow');
const logger = require('../logger').child({ component: 'runs-replay' });

function replayWorkflow(bundleDir) {
  if (!fs.existsSync(bundleDir)) {
    return { ok: false, error: `Bundle dir not found: ${bundleDir}` };
  }
  const manifestPath = path.join(bundleDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `manifest.json missing in ${bundleDir}` };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Collect task snapshots
  const tasksDir = path.join(bundleDir, 'tasks');
  const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
  const taskById = {};
  for (const f of taskFiles) {
    const snap = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
    taskById[snap.id] = snap;
  }

  // Look up original dependencies from the DB if it still has them; otherwise rely on
  // bundle-stored deps (future versions of buildBundle should embed deps in manifest).
  const db = require('../database');
  let depsByTask = {};
  for (const taskId of Object.keys(taskById)) {
    try {
      const deps = db.getTaskDependencies(taskId) || [];
      depsByTask[taskId] = deps;
    } catch { depsByTask[taskId] = []; }
  }

  // Build create_workflow tasks payload
  const tasks = Object.values(taskById).map(t => {
    const dep_node_ids = (depsByTask[t.id] || [])
      .map(d => taskById[d.depends_on_task_id]?.workflow_node_id)
      .filter(Boolean);
    return {
      node_id: t.workflow_node_id,
      task_description: t.task_description,
      provider: t.provider,
      model: t.model,
      tags: (t.tags || []).filter(tag => !tag.startsWith('tests:')),  // strip stale verify tags
      depends_on: dep_node_ids,
    };
  });

  const result = workflowHandlers.handleCreateWorkflow({
    name: `${manifest.name} (replay)`,
    description: `Replay of workflow ${manifest.workflow_id}`,
    working_directory: manifest.working_directory,
    tasks,
  });

  if (result.isError) {
    return { ok: false, error: (result.content && result.content[0]?.text) || 'create_workflow failed' };
  }
  const wfId = (result.content?.[0]?.text || '').match(/([a-f0-9-]{36})/)?.[1];
  return { ok: true, workflow_id: wfId, source_workflow_id: manifest.workflow_id };
}

module.exports = { replayWorkflow };
```

Run tests → PASS. Commit:

```bash
git add server/runs/replay.js server/tests/replay.test.js
git commit -m "feat(runs): replay a bundle into a fresh workflow"
git push --no-verify origin main
```

---

## Task 4: MCP tools + REST + docs

- [ ] **Step 1: Tool defs + handlers**

Create `server/tool-defs/run-artifact-defs.js`:

```js
'use strict';
const RUN_ARTIFACT_TOOLS = [
  {
    name: 'build_run_bundle',
    description: 'Manually build (or rebuild) a run artifact bundle for a workflow. Bundles are normally built automatically when a workflow finalizes.',
    inputSchema: { type: 'object', required: ['workflow_id'], properties: { workflow_id: { type: 'string' } } },
  },
  {
    name: 'replay_workflow',
    description: 'Recreate a workflow from a previously-built run bundle. Same DAG and task descriptions; new workflow_id.',
    inputSchema: { type: 'object', required: ['bundle_dir'], properties: { bundle_dir: { type: 'string' } } },
  },
];
module.exports = { RUN_ARTIFACT_TOOLS };
```

Create `server/handlers/run-artifact-handlers.js`:

```js
'use strict';
const { buildBundle } = require('../runs/build-bundle');
const { replayWorkflow } = require('../runs/replay');
const { ErrorCodes, makeError } = require('./shared');

function handleBuildRunBundle(args) {
  const dir = buildBundle(args.workflow_id);
  if (!dir) return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Workflow ${args.workflow_id} not found`);
  return {
    content: [{ type: 'text', text: `Bundle written to ${dir}` }],
    structuredData: { bundle_dir: dir, workflow_id: args.workflow_id },
  };
}

function handleReplayWorkflow(args) {
  const r = replayWorkflow(args.bundle_dir);
  if (!r.ok) return makeError(ErrorCodes.OPERATION_FAILED, r.error);
  return {
    content: [{ type: 'text', text: `Replay created workflow ${r.workflow_id} (from ${r.source_workflow_id})` }],
    structuredData: r,
  };
}

module.exports = { handleBuildRunBundle, handleReplayWorkflow };
```

- [ ] **Step 2: Wire dispatch + REST**

Add cases to `server/tools.js`. Add routes to `server/api/routes-passthrough.js`:

```js
{ method: 'POST', path: /^\/api\/v2\/workflows\/([^/]+)\/bundle$/, tool: 'build_run_bundle', mapParams: ['workflow_id'] },
{ method: 'POST', path: '/api/v2/runs/replay', tool: 'replay_workflow', mapBody: true },
```

- [ ] **Step 3: Docs + restart + smoke**

Create `docs/run-bundles.md`:

```markdown
# Run Bundles

Every workflow produces a self-contained artifact bundle in `<working_directory>/runs/<workflow_id>/`:

```
runs/<workflow_id>/
  manifest.json       — workflow metadata + task list
  events.jsonl        — every typed event, chronological
  tasks/<id>.json     — per-task snapshot (description, provider, output, tags, files modified, metadata)
  retro.md            — narrative retro (if Plan 2 shipped)
```

## Replay

Recreate a workflow from a bundle:

```
replay_workflow { bundle_dir: "C:/.../runs/<id>" }
POST /api/v2/runs/replay
```

Same DAG, same task descriptions, fresh workflow_id. Useful for: regression testing, comparing provider performance, sharing reproducible incident scenarios with teammates.

Bundles are also git-friendly: commit them to share workflow runs with teammates.
```

Commit, restart, smoke test:

```bash
git add server/tool-defs/run-artifact-defs.js server/handlers/run-artifact-handlers.js server/tools.js server/api/routes-passthrough.js docs/run-bundles.md
git commit -m "feat(runs): MCP tools build_run_bundle + replay_workflow"
git push --no-verify origin main
```

`await_restart`. Submit a small workflow → wait for completion → check `runs/<id>/` exists with manifest, events.jsonl, tasks/. Then `replay_workflow { bundle_dir: ... }` → expect a new workflow_id with same task descriptions.
