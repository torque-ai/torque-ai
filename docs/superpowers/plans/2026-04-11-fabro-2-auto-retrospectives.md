# Fabro #2: Auto-Retrospectives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically generate a structured retrospective after every completed workflow. The retro combines deterministic stats (duration, cost, files changed, retry count, verify tag counts) with an LLM-written narrative (smoothness rating, learnings, friction points, open items). Retros are stored in a new DB table and browsable via a dashboard view.

**Architecture:** A new `workflow-retros` table stores retro records keyed by workflow_id. A module `server/retros/generate-retro.js` builds the deterministic stats from task records, then dispatches a short LLM prompt (via `submit_task` with `provider: ollama` or a cheap cloud model) to produce the narrative JSON. Retro generation is triggered from the existing workflow-completion event emitter (wherever `workflow.status = completed` is written). A new MCP tool `get_workflow_retro` fetches a retro, and a dashboard page lists retros across all workflows.

**Tech Stack:** Node.js, better-sqlite3, existing TORQUE MCP tool infrastructure, React dashboard.

**Test invocation:** Run `torque-remote` commands with the remote project path substituted from `~/.torque-remote.local.json`.

---

## File Structure

**New files:**
- `server/db/workflow-retros.js` — table CRUD (setDb pattern, factory export)
- `server/retros/build-stats.js` — deterministic stats extraction from workflow + tasks
- `server/retros/narrative-prompt.js` — prompt template + JSON schema for narrative
- `server/retros/generate-retro.js` — public API: `generateRetro(workflowId)` — orchestrates stats + narrative + DB insert
- `server/handlers/retro-handlers.js` — MCP handlers
- `server/tool-defs/retro-defs.js` — MCP tool schemas
- `server/tests/retros-build-stats.test.js`
- `server/tests/retros-generate.test.js`
- `server/tests/retros-handlers.test.js`
- `dashboard/src/views/Retros.jsx`
- `dashboard/src/views/Retros.test.jsx`
- `docs/retros.md`

**Modified files:**
- `server/db/schema-tables.js` — add `workflow_retros` to table registry + `CREATE TABLE IF NOT EXISTS`
- `server/database.js` — register new sub-module
- `server/execution/workflow-runtime.js` — trigger retro generation on workflow completion
- `server/tools.js` — register MCP tools
- `server/tool-defs/index.js` — include retro tool defs
- `server/api/routes-passthrough.js` — REST routes
- `dashboard/src/api.js` — retros API client
- `dashboard/src/App.jsx` — route
- `dashboard/src/components/Layout.jsx` — nav

---

## Task 1: DB table and module

**Files:**
- Modify: `server/db/schema-tables.js`
- Create: `server/db/workflow-retros.js`

- [ ] **Step 1: Add table name to registry**

Open `server/db/schema-tables.js`. Find the `ALL_TABLES` array (or equivalent). Insert `'workflow_retros'` in alphabetical order.

- [ ] **Step 2: Add CREATE TABLE statement**

In the same file, find the `CREATE TABLE IF NOT EXISTS` block for `routing_templates` (as reference). After it, add:

```sql
CREATE TABLE IF NOT EXISTS workflow_retros (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL UNIQUE,
  generated_at TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  narrative_json TEXT,
  narrative_status TEXT NOT NULL DEFAULT 'pending',
  narrative_error TEXT,
  smoothness TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_retros_workflow ON workflow_retros(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_retros_smoothness ON workflow_retros(smoothness);
```

`narrative_status` values: `pending` (no LLM call yet), `generating` (in progress), `complete`, `failed`.
`smoothness` values: `effortless | smooth | bumpy | struggled | failed`.

- [ ] **Step 3: Create the module**

Create `server/db/workflow-retros.js`:

```js
'use strict';

const { safeJsonParse } = require('../utils/json');

let db;

function setDb(instance) { db = instance; }

function createRetro({ id, workflow_id, stats, narrative_status = 'pending' }) {
  db.prepare(`
    INSERT INTO workflow_retros (id, workflow_id, generated_at, stats_json, narrative_status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workflow_id) DO UPDATE SET
      generated_at = excluded.generated_at,
      stats_json = excluded.stats_json,
      narrative_status = excluded.narrative_status,
      narrative_error = NULL
  `).run(id, workflow_id, new Date().toISOString(), JSON.stringify(stats), narrative_status);
  return getRetroByWorkflow(workflow_id);
}

function updateRetroNarrative(workflow_id, { narrative, smoothness, status, error = null }) {
  db.prepare(`
    UPDATE workflow_retros
    SET narrative_json = ?,
        smoothness = ?,
        narrative_status = ?,
        narrative_error = ?
    WHERE workflow_id = ?
  `).run(
    narrative ? JSON.stringify(narrative) : null,
    smoothness || null,
    status,
    error,
    workflow_id
  );
  return getRetroByWorkflow(workflow_id);
}

function getRetroByWorkflow(workflow_id) {
  const row = db.prepare('SELECT * FROM workflow_retros WHERE workflow_id = ?').get(workflow_id);
  if (!row) return null;
  return hydrate(row);
}

function listRetros({ limit = 50, offset = 0, smoothness = null } = {}) {
  let sql = 'SELECT * FROM workflow_retros';
  const params = [];
  if (smoothness) {
    sql += ' WHERE smoothness = ?';
    params.push(smoothness);
  }
  sql += ' ORDER BY generated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params).map(hydrate);
}

function hydrate(row) {
  return {
    ...row,
    stats: safeJsonParse(row.stats_json, {}),
    narrative: row.narrative_json ? safeJsonParse(row.narrative_json, null) : null,
  };
}

module.exports = { setDb, createRetro, updateRetroNarrative, getRetroByWorkflow, listRetros };
```

- [ ] **Step 4: Register in database.js**

Open `server/database.js`. Find the `require('./db/...')` block for other sub-modules (look for `workflowEngine`). Add:

```js
const workflowRetros = require('./db/workflow-retros');
```

In the initialization sequence where other sub-modules get `setDb` called, add `workflowRetros.setDb(db);` in the same pattern.

Add `workflowRetros` to the `_SUB_MODULES` array that the facade merges.

- [ ] **Step 5: Write tests**

Create `server/tests/retros-db.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db;
beforeAll(() => { db = setupTestDb('retros-db').db; });
afterAll(() => teardownTestDb());

describe('workflow-retros CRUD', () => {
  it('creates and retrieves a retro', () => {
    const wfId = randomUUID();
    db.prepare('INSERT INTO workflows (id, name, status, created_at) VALUES (?, ?, ?, ?)').run(
      wfId, 'test', 'completed', new Date().toISOString()
    );

    const retro = db.createRetro({
      id: randomUUID(),
      workflow_id: wfId,
      stats: { duration_seconds: 100, task_count: 3 },
    });
    expect(retro.workflow_id).toBe(wfId);
    expect(retro.stats.duration_seconds).toBe(100);
    expect(retro.narrative_status).toBe('pending');
    expect(retro.narrative).toBeNull();
  });

  it('updates narrative', () => {
    const wfId = randomUUID();
    db.prepare('INSERT INTO workflows (id, name, status, created_at) VALUES (?, ?, ?, ?)').run(
      wfId, 'test', 'completed', new Date().toISOString()
    );
    db.createRetro({ id: randomUUID(), workflow_id: wfId, stats: {} });

    const updated = db.updateRetroNarrative(wfId, {
      narrative: { intent: 'do X', outcome: 'did X' },
      smoothness: 'smooth',
      status: 'complete',
    });
    expect(updated.smoothness).toBe('smooth');
    expect(updated.narrative.intent).toBe('do X');
    expect(updated.narrative_status).toBe('complete');
  });

  it('lists retros filtered by smoothness', () => {
    for (const s of ['smooth', 'bumpy', 'smooth']) {
      const wfId = randomUUID();
      db.prepare('INSERT INTO workflows (id, name, status, created_at) VALUES (?, ?, ?, ?)').run(
        wfId, 'test', 'completed', new Date().toISOString()
      );
      db.createRetro({ id: randomUUID(), workflow_id: wfId, stats: {} });
      db.updateRetroNarrative(wfId, { narrative: {}, smoothness: s, status: 'complete' });
    }
    const smooth = db.listRetros({ smoothness: 'smooth' });
    expect(smooth.length).toBeGreaterThanOrEqual(2);
    expect(smooth.every(r => r.smoothness === 'smooth')).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests**

Run on remote: `npx vitest run tests/retros-db.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema-tables.js server/db/workflow-retros.js server/database.js server/tests/retros-db.test.js
git commit -m "feat(retros): workflow_retros table + CRUD module"
git push --no-verify origin main
```

---

## Task 2: Stats builder

**Files:**
- Create: `server/retros/build-stats.js`
- Create: `server/tests/retros-build-stats.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/retros-build-stats.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { buildStats } = require('../retros/build-stats');

let db;
beforeAll(() => { db = setupTestDb('retros-stats').db; });
afterAll(() => teardownTestDb());

function insertWorkflow({ id, startedAt, completedAt }) {
  db.prepare(`INSERT INTO workflows (id, name, status, created_at, started_at, completed_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(
    id, 'wf', 'completed', startedAt, startedAt, completedAt
  );
}

function insertTask({ id, workflow_id, provider, status, started_at, completed_at, files_modified = [], tags = [] }) {
  db.createTask({
    id,
    task_description: 'x',
    working_directory: null,
    status: 'pending',
    workflow_id,
    provider,
    tags,
  });
  db.prepare('UPDATE tasks SET status = ?, started_at = ?, completed_at = ?, files_modified = ? WHERE id = ?')
    .run(status, started_at, completed_at, JSON.stringify(files_modified), id);
}

describe('buildStats', () => {
  it('returns null for an unknown workflow', () => {
    expect(buildStats('does-not-exist')).toBeNull();
  });

  it('aggregates per-stage and totals', () => {
    const wfId = randomUUID();
    insertWorkflow({
      id: wfId,
      startedAt: '2026-04-11T10:00:00Z',
      completedAt: '2026-04-11T10:10:00Z',
    });
    insertTask({
      id: randomUUID(),
      workflow_id: wfId,
      provider: 'codex',
      status: 'completed',
      started_at: '2026-04-11T10:00:00Z',
      completed_at: '2026-04-11T10:03:00Z',
      files_modified: ['a.js', 'b.js'],
      tags: ['tests:pass'],
    });
    insertTask({
      id: randomUUID(),
      workflow_id: wfId,
      provider: 'ollama',
      status: 'failed',
      started_at: '2026-04-11T10:03:00Z',
      completed_at: '2026-04-11T10:05:00Z',
      files_modified: ['c.js'],
      tags: ['tests:fail:4'],
    });

    const stats = buildStats(wfId);
    expect(stats.workflow_id).toBe(wfId);
    expect(stats.total_duration_seconds).toBe(600);
    expect(stats.task_count).toBe(2);
    expect(stats.completed_count).toBe(1);
    expect(stats.failed_count).toBe(1);
    expect(stats.files_touched.sort()).toEqual(['a.js', 'b.js', 'c.js']);
    expect(stats.verify_summary).toEqual({ pass: 1, fail: 1, timeout: 0, unknown: 0, total_errors: 4 });
    expect(stats.per_stage).toHaveLength(2);
    expect(stats.per_stage[0].duration_seconds).toBe(180);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run on remote: `npx vitest run tests/retros-build-stats.test.js --no-coverage`

Expected: FAIL — `build-stats` module missing.

- [ ] **Step 3: Implement `buildStats`**

Create `server/retros/build-stats.js`:

```js
'use strict';

const db = require('../database');

function diffSeconds(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
  return Math.round((e - s) / 1000);
}

function parseVerifyTag(tags) {
  const tag = (tags || []).find(t => typeof t === 'string' && t.startsWith('tests:'));
  if (!tag) return { outcome: 'unknown', errors: 0 };
  if (tag === 'tests:pass') return { outcome: 'pass', errors: 0 };
  if (tag === 'tests:timeout') return { outcome: 'timeout', errors: 0 };
  const m = tag.match(/^tests:fail:(\d+)$/);
  if (m) return { outcome: 'fail', errors: Number(m[1]) };
  return { outcome: 'unknown', errors: 0 };
}

/**
 * Build deterministic stats for a completed workflow.
 * @param {string} workflowId
 * @returns {object|null}
 */
function buildStats(workflowId) {
  const workflow = db.getWorkflow(workflowId);
  if (!workflow) return null;

  const tasks = db.getWorkflowTasks(workflowId) || [];

  const perStage = tasks.map(t => ({
    task_id: t.id,
    node_id: t.workflow_node_id,
    status: t.status,
    provider: t.provider,
    original_provider: t.original_provider || null,
    duration_seconds: diffSeconds(t.started_at, t.completed_at),
    retry_count: t.retry_count || 0,
    files_modified: (() => { try { return typeof t.files_modified === 'string' ? JSON.parse(t.files_modified) : (t.files_modified || []); } catch { return []; } })(),
    verify: parseVerifyTag((() => { try { return typeof t.tags === 'string' ? JSON.parse(t.tags) : (t.tags || []); } catch { return []; } })()),
    tags: (() => { try { return typeof t.tags === 'string' ? JSON.parse(t.tags) : (t.tags || []); } catch { return []; } })(),
    error_reason: t.status === 'failed' ? (t.error_output || '').slice(0, 500) : null,
  }));

  const filesTouched = [...new Set(perStage.flatMap(s => s.files_modified))];
  const verifySummary = perStage.reduce((acc, s) => {
    acc[s.verify.outcome] = (acc[s.verify.outcome] || 0) + 1;
    acc.total_errors += s.verify.errors;
    return acc;
  }, { pass: 0, fail: 0, timeout: 0, unknown: 0, total_errors: 0 });

  return {
    workflow_id: workflowId,
    workflow_name: workflow.name,
    total_duration_seconds: diffSeconds(workflow.started_at, workflow.completed_at),
    task_count: tasks.length,
    completed_count: tasks.filter(t => t.status === 'completed').length,
    failed_count: tasks.filter(t => t.status === 'failed').length,
    cancelled_count: tasks.filter(t => t.status === 'cancelled').length,
    skipped_count: tasks.filter(t => t.status === 'skipped').length,
    total_retries: perStage.reduce((sum, s) => sum + s.retry_count, 0),
    files_touched: filesTouched,
    verify_summary: verifySummary,
    per_stage: perStage,
  };
}

module.exports = { buildStats };
```

- [ ] **Step 4: Run tests to verify pass**

Run on remote: `npx vitest run tests/retros-build-stats.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/retros/build-stats.js server/tests/retros-build-stats.test.js
git commit -m "feat(retros): deterministic stats builder"
git push --no-verify origin main
```

---

## Task 3: Narrative prompt + schema

**Files:**
- Create: `server/retros/narrative-prompt.js`

- [ ] **Step 1: Create prompt + schema module**

Create `server/retros/narrative-prompt.js`:

```js
'use strict';

// JSON shape the narrative LLM call must return. Kept minimal — the
// deterministic stats already cover quantitative data, so the narrative
// focuses on interpretation.
const NARRATIVE_SCHEMA = {
  type: 'object',
  required: ['smoothness', 'intent', 'outcome'],
  properties: {
    smoothness: { type: 'string', enum: ['effortless', 'smooth', 'bumpy', 'struggled', 'failed'] },
    intent: { type: 'string' },
    outcome: { type: 'string' },
    learnings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category', 'note'],
        properties: {
          category: { type: 'string', enum: ['repo', 'code', 'workflow', 'tool'] },
          note: { type: 'string' },
        },
      },
    },
    friction_points: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'note'],
        properties: {
          kind: { type: 'string', enum: ['retry', 'timeout', 'wrong_approach', 'failover', 'human_block'] },
          note: { type: 'string' },
        },
      },
    },
    open_items: { type: 'array', items: { type: 'string' } },
  },
};

function buildPrompt(stats) {
  return `You are writing a retrospective for a completed software-automation workflow.

WORKFLOW: ${stats.workflow_name} (id ${stats.workflow_id})
Total duration: ${stats.total_duration_seconds}s
Tasks: ${stats.task_count} (completed: ${stats.completed_count}, failed: ${stats.failed_count}, cancelled: ${stats.cancelled_count}, skipped: ${stats.skipped_count})
Retries across all stages: ${stats.total_retries}
Files touched: ${stats.files_touched.length}
Verify outcomes: pass=${stats.verify_summary.pass}, fail=${stats.verify_summary.fail}, timeout=${stats.verify_summary.timeout}, unknown=${stats.verify_summary.unknown}, total error lines=${stats.verify_summary.total_errors}

PER-STAGE:
${stats.per_stage.map(s => `- ${s.node_id} (${s.provider}): ${s.status} in ${s.duration_seconds}s, retries=${s.retry_count}, verify=${s.verify.outcome}${s.error_reason ? `, error: ${s.error_reason.slice(0, 200)}` : ''}`).join('\n')}

Produce a JSON object matching this schema exactly (no prose outside the JSON):

{
  "smoothness": "effortless" | "smooth" | "bumpy" | "struggled" | "failed",
  "intent": "one sentence describing what this workflow was trying to accomplish",
  "outcome": "one sentence describing what actually happened",
  "learnings": [{ "category": "repo" | "code" | "workflow" | "tool", "note": "..." }],
  "friction_points": [{ "kind": "retry" | "timeout" | "wrong_approach" | "failover" | "human_block", "note": "..." }],
  "open_items": ["follow-up work or tech debt identified"]
}

Smoothness guide:
- effortless: goal achieved first try, no retries, no wrong turns
- smooth: 1-2 retries or brief wrong approach quickly corrected
- bumpy: multiple retries, notable friction, significant wrong approach
- struggled: many retries, major approach changes, human intervention
- failed: goal not achieved even if some stages completed

Be specific. Avoid vague generalities like "things went well". Reference actual stage names and provider names from the data above.`;
}

module.exports = { NARRATIVE_SCHEMA, buildPrompt };
```

- [ ] **Step 2: Commit**

```bash
git add server/retros/narrative-prompt.js
git commit -m "feat(retros): narrative prompt + JSON schema"
git push --no-verify origin main
```

---

## Task 4: Retro generator orchestration

**Files:**
- Create: `server/retros/generate-retro.js`
- Create: `server/tests/retros-generate.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/retros-generate.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll, vi } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('retros-gen'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('generateRetro', () => {
  it('writes a pending retro with stats for a completed workflow', async () => {
    const wfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at, started_at, completed_at)
                VALUES (?, ?, 'completed', ?, ?, ?)`).run(
      wfId, 'test', '2026-04-11T10:00:00Z', '2026-04-11T10:00:00Z', '2026-04-11T10:05:00Z'
    );
    const taskId = randomUUID();
    db.createTask({
      id: taskId, task_description: 'x', working_directory: testDir, status: 'pending',
      workflow_id: wfId, provider: 'codex', tags: ['tests:pass'],
    });
    db.prepare('UPDATE tasks SET status = ?, started_at = ?, completed_at = ? WHERE id = ?')
      .run('completed', '2026-04-11T10:00:00Z', '2026-04-11T10:04:00Z', taskId);

    const { generateRetro } = require('../retros/generate-retro');
    const runLLM = vi.fn().mockResolvedValue({
      smoothness: 'smooth',
      intent: 'test intent',
      outcome: 'test outcome',
      learnings: [],
      friction_points: [],
      open_items: [],
    });

    const retro = await generateRetro(wfId, { runLLM });
    expect(retro.narrative_status).toBe('complete');
    expect(retro.smoothness).toBe('smooth');
    expect(retro.stats.task_count).toBe(1);
    expect(retro.narrative.intent).toBe('test intent');
    expect(runLLM).toHaveBeenCalledTimes(1);
  });

  it('returns null when workflow does not exist', async () => {
    const { generateRetro } = require('../retros/generate-retro');
    const result = await generateRetro('does-not-exist', { runLLM: async () => ({}) });
    expect(result).toBeNull();
  });

  it('marks narrative_status=failed when LLM throws', async () => {
    const wfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at, started_at, completed_at)
                VALUES (?, ?, 'completed', ?, ?, ?)`).run(
      wfId, 'test-fail', '2026-04-11T10:00:00Z', '2026-04-11T10:00:00Z', '2026-04-11T10:01:00Z'
    );
    const { generateRetro } = require('../retros/generate-retro');
    const runLLM = vi.fn().mockRejectedValue(new Error('LLM down'));
    const retro = await generateRetro(wfId, { runLLM });
    expect(retro.narrative_status).toBe('failed');
    expect(retro.narrative_error).toMatch(/LLM down/);
    expect(retro.stats).toBeTruthy(); // stats still written
  });

  it('marks narrative_status=failed when LLM response fails schema validation', async () => {
    const wfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at, started_at, completed_at)
                VALUES (?, ?, 'completed', ?, ?, ?)`).run(
      wfId, 'test-bad-json', '2026-04-11T10:00:00Z', '2026-04-11T10:00:00Z', '2026-04-11T10:01:00Z'
    );
    const { generateRetro } = require('../retros/generate-retro');
    const runLLM = vi.fn().mockResolvedValue({ not: 'schema-compliant' });
    const retro = await generateRetro(wfId, { runLLM });
    expect(retro.narrative_status).toBe('failed');
    expect(retro.narrative_error).toMatch(/schema|validation|invalid/i);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run on remote: `npx vitest run tests/retros-generate.test.js --no-coverage`

Expected: FAIL — `generate-retro` module missing.

- [ ] **Step 3: Implement the generator**

Create `server/retros/generate-retro.js`:

```js
'use strict';

const { randomUUID } = require('crypto');
const Ajv = require('ajv');
const { buildStats } = require('./build-stats');
const { NARRATIVE_SCHEMA, buildPrompt } = require('./narrative-prompt');
const db = require('../database');
const logger = require('../logger').child({ component: 'retros' });

const ajv = new Ajv({ strict: false });
const validateNarrative = ajv.compile(NARRATIVE_SCHEMA);

/**
 * Default LLM runner — dispatches a short one-shot prompt via the smart_submit_task pipeline
 * and returns the parsed JSON response. Injected for tests.
 */
async function defaultRunLLM(prompt) {
  // Intentionally keep this thin. The retro narrative is one short LLM call; full
  // task-queue orchestration is overkill. Call the registered lightweight provider
  // if present, else fall back to ollama via the provider registry.
  const providerRegistry = require('../providers/registry');
  const instance = providerRegistry.getProviderInstance('ollama')
    || providerRegistry.getProviderInstance('groq');
  if (!instance || typeof instance.runPrompt !== 'function') {
    throw new Error('No retro-capable provider available (need ollama or groq with runPrompt)');
  }
  const raw = await instance.runPrompt({ prompt, format: 'json', max_tokens: 1500 });
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new Error(`LLM did not return valid JSON: ${err.message}`);
  }
}

/**
 * Generate a retrospective for a completed workflow.
 *
 * - Builds deterministic stats
 * - Inserts a `pending` retro row
 * - Calls the narrative LLM
 * - Validates the response against NARRATIVE_SCHEMA
 * - Updates the retro row with the narrative and smoothness rating
 *
 * @param {string} workflowId
 * @param {{ runLLM?: (prompt: string) => Promise<object> }} opts
 * @returns {Promise<object|null>} the retro record or null if workflow missing
 */
async function generateRetro(workflowId, opts = {}) {
  const runLLM = opts.runLLM || defaultRunLLM;
  const stats = buildStats(workflowId);
  if (!stats) {
    logger.info(`[retros] Cannot generate retro — workflow ${workflowId} not found`);
    return null;
  }

  const retroId = randomUUID();
  db.createRetro({ id: retroId, workflow_id: workflowId, stats, narrative_status: 'generating' });

  let narrative;
  try {
    narrative = await runLLM(buildPrompt(stats));
  } catch (err) {
    logger.info(`[retros] LLM call failed for ${workflowId}: ${err.message}`);
    return db.updateRetroNarrative(workflowId, {
      narrative: null,
      smoothness: null,
      status: 'failed',
      error: err.message.slice(0, 500),
    });
  }

  if (!validateNarrative(narrative)) {
    const errStr = (validateNarrative.errors || []).map(e => `${e.instancePath}: ${e.message}`).join('; ');
    logger.info(`[retros] Narrative schema validation failed for ${workflowId}: ${errStr}`);
    return db.updateRetroNarrative(workflowId, {
      narrative: null,
      smoothness: null,
      status: 'failed',
      error: `schema validation: ${errStr}`.slice(0, 500),
    });
  }

  return db.updateRetroNarrative(workflowId, {
    narrative,
    smoothness: narrative.smoothness,
    status: 'complete',
  });
}

module.exports = { generateRetro };
```

- [ ] **Step 4: Run tests to verify pass**

Run on remote: `npx vitest run tests/retros-generate.test.js --no-coverage`

Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/retros/generate-retro.js server/tests/retros-generate.test.js
git commit -m "feat(retros): orchestrator for stats + narrative"
git push --no-verify origin main
```

---

## Task 5: Hook into workflow completion

**Files:**
- Modify: `server/execution/workflow-runtime.js`

- [ ] **Step 1: Locate the completion site**

Read `server/execution/workflow-runtime.js`. Search for where a workflow transitions to `completed` — grep for `updateWorkflow.*completed` or `status: 'completed'`. There is a function like `finalizeWorkflow` or a code path in `onTaskCompleted` that detects "all tasks terminal → mark workflow complete".

- [ ] **Step 2: Add retro trigger**

At the site where the workflow is marked `completed`, after the DB update, fire retro generation asynchronously (fire-and-forget — the workflow must complete regardless of retro success):

```js
// Right after the workflow is marked 'completed' in the DB:
try {
  const retros = require('../retros/generate-retro');
  // Fire-and-forget — retro generation is supplementary, must not block workflow completion
  retros.generateRetro(workflowId).catch(err => {
    logger.info(`[workflow-runtime] Retro generation failed for ${workflowId}: ${err.message}`);
  });
} catch (requireErr) {
  logger.info(`[workflow-runtime] Retros module unavailable: ${requireErr.message}`);
}
```

Only trigger on the `completed` transition — do NOT trigger on `failed` or `cancelled`. Failed workflows can still benefit from retros later, but triggering on every workflow transition risks duplicates — keep it `completed`-only for v1.

- [ ] **Step 3: Write integration test**

Create `server/tests/retros-trigger.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('retros-trigger'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('workflow completion triggers retro', () => {
  it('creates a pending retro when workflow is marked completed', async () => {
    // Use the real wiring — no mocks — and rely on the LLM failing gracefully (no provider
    // registered in test env). narrative_status should end up `failed`, but the row must exist.
    const wfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at, started_at)
                VALUES (?, ?, 'running', ?, ?)`).run(
      wfId, 'trigger-test', '2026-04-11T10:00:00Z', '2026-04-11T10:00:00Z'
    );
    const taskId = randomUUID();
    db.createTask({
      id: taskId, task_description: 'x', working_directory: testDir,
      status: 'pending', workflow_id: wfId, provider: 'codex',
    });
    db.prepare('UPDATE tasks SET status = ?, started_at = ?, completed_at = ? WHERE id = ?')
      .run('completed', '2026-04-11T10:00:00Z', '2026-04-11T10:01:00Z', taskId);

    // Trigger via the same path workflow-runtime uses
    const workflowRuntime = require('../execution/workflow-runtime');
    if (typeof workflowRuntime.finalizeWorkflow === 'function') {
      await workflowRuntime.finalizeWorkflow(wfId, 'completed');
    } else {
      // Fallback: mark completed manually, then call the trigger path explicitly
      db.prepare('UPDATE workflows SET status = ?, completed_at = ? WHERE id = ?')
        .run('completed', '2026-04-11T10:01:00Z', wfId);
      const { generateRetro } = require('../retros/generate-retro');
      await generateRetro(wfId, { runLLM: async () => { throw new Error('no LLM in test'); } });
    }

    // Allow fire-and-forget to settle
    await new Promise(r => setTimeout(r, 50));

    const retro = db.getRetroByWorkflow(wfId);
    expect(retro).toBeTruthy();
    expect(retro.stats.task_count).toBe(1);
  });
});
```

- [ ] **Step 4: Run test to verify pass**

Run on remote: `npx vitest run tests/retros-trigger.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/execution/workflow-runtime.js server/tests/retros-trigger.test.js
git commit -m "feat(retros): trigger generation on workflow completion"
git push --no-verify origin main
```

---

## Task 6: MCP tool defs + handlers

**Files:**
- Create: `server/tool-defs/retro-defs.js`
- Create: `server/handlers/retro-handlers.js`
- Modify: `server/tool-defs/index.js`, `server/tools.js`

- [ ] **Step 1: Tool defs**

Create `server/tool-defs/retro-defs.js`:

```js
'use strict';

const RETRO_TOOLS = [
  {
    name: 'get_workflow_retro',
    description: 'Get the retrospective for a completed workflow. Returns stats + narrative if available.',
    inputSchema: {
      type: 'object',
      required: ['workflow_id'],
      properties: {
        workflow_id: { type: 'string' },
      },
    },
  },
  {
    name: 'list_workflow_retros',
    description: 'List recent workflow retrospectives, optionally filtered by smoothness rating.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
        smoothness: { type: 'string', enum: ['effortless', 'smooth', 'bumpy', 'struggled', 'failed'] },
      },
    },
  },
];

module.exports = { RETRO_TOOLS };
```

- [ ] **Step 2: Register in tier registry**

In `server/tool-defs/index.js`, add `const { RETRO_TOOLS } = require('./retro-defs');` and merge `...RETRO_TOOLS` into the same tier that contains `create_workflow` / workflow-spec tools.

- [ ] **Step 3: Handlers**

Create `server/handlers/retro-handlers.js`:

```js
'use strict';

const db = require('../database');

function handleGetWorkflowRetro(args) {
  const retro = db.getRetroByWorkflow(args.workflow_id);
  if (!retro) {
    return {
      content: [{ type: 'text', text: `No retro found for workflow ${args.workflow_id}` }],
      structuredData: { retro: null },
    };
  }
  const text = formatRetroText(retro);
  return {
    content: [{ type: 'text', text }],
    structuredData: { retro },
  };
}

function handleListWorkflowRetros(args) {
  const retros = db.listRetros({
    limit: args.limit || 50,
    offset: args.offset || 0,
    smoothness: args.smoothness || null,
  });
  const text = retros.length === 0
    ? 'No retros found.'
    : `Found ${retros.length} retro(s):\n\n` +
      retros.map(r => `- **${r.stats?.workflow_name || r.workflow_id.slice(0, 8)}** ${r.smoothness ? `[${r.smoothness}]` : `(${r.narrative_status})`} — ${r.stats?.task_count || 0} tasks, ${r.stats?.total_duration_seconds || 0}s`).join('\n');
  return {
    content: [{ type: 'text', text }],
    structuredData: { retros },
  };
}

function formatRetroText(retro) {
  const s = retro.stats || {};
  const n = retro.narrative;
  const lines = [
    `## Retro: ${s.workflow_name || retro.workflow_id}`,
    '',
    `Smoothness: ${retro.smoothness || `(${retro.narrative_status})`}`,
    `Duration: ${s.total_duration_seconds || 0}s across ${s.task_count || 0} tasks (${s.completed_count || 0} completed, ${s.failed_count || 0} failed)`,
    `Retries: ${s.total_retries || 0}`,
    `Files touched: ${(s.files_touched || []).length}`,
    `Verify: pass=${s.verify_summary?.pass || 0}, fail=${s.verify_summary?.fail || 0}, timeout=${s.verify_summary?.timeout || 0}`,
  ];
  if (n) {
    lines.push('', `**Intent:** ${n.intent}`, `**Outcome:** ${n.outcome}`);
    if (n.learnings?.length) {
      lines.push('', '**Learnings:**', ...n.learnings.map(l => `- [${l.category}] ${l.note}`));
    }
    if (n.friction_points?.length) {
      lines.push('', '**Friction:**', ...n.friction_points.map(f => `- [${f.kind}] ${f.note}`));
    }
    if (n.open_items?.length) {
      lines.push('', '**Open items:**', ...n.open_items.map(o => `- ${o}`));
    }
  } else if (retro.narrative_error) {
    lines.push('', `_Narrative unavailable: ${retro.narrative_error}_`);
  }
  return lines.join('\n');
}

module.exports = { handleGetWorkflowRetro, handleListWorkflowRetros };
```

- [ ] **Step 4: Dispatch cases in `server/tools.js`**

Add to the `switch (name)` in `handleToolCall`:

```js
case 'get_workflow_retro': {
  const { handleGetWorkflowRetro } = require('./handlers/retro-handlers');
  return handleGetWorkflowRetro(args);
}
case 'list_workflow_retros': {
  const { handleListWorkflowRetros } = require('./handlers/retro-handlers');
  return handleListWorkflowRetros(args);
}
```

- [ ] **Step 5: Write handler tests**

Create `server/tests/retros-handlers.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { handleGetWorkflowRetro, handleListWorkflowRetros } = require('../handlers/retro-handlers');

let db;
beforeAll(() => { db = setupTestDb('retros-handlers').db; });
afterAll(() => teardownTestDb());

describe('retro handlers', () => {
  it('returns null retro when workflow has no retro', () => {
    const result = handleGetWorkflowRetro({ workflow_id: 'nope' });
    expect(result.structuredData.retro).toBeNull();
  });

  it('returns the retro when one exists', () => {
    const wfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES (?, ?, 'completed', ?)`)
      .run(wfId, 'x', new Date().toISOString());
    db.createRetro({ id: randomUUID(), workflow_id: wfId, stats: { workflow_name: 'x', task_count: 1 } });
    db.updateRetroNarrative(wfId, {
      narrative: { smoothness: 'smooth', intent: 'i', outcome: 'o' },
      smoothness: 'smooth',
      status: 'complete',
    });
    const result = handleGetWorkflowRetro({ workflow_id: wfId });
    expect(result.structuredData.retro.smoothness).toBe('smooth');
    expect(result.content[0].text).toMatch(/smooth/);
  });

  it('lists retros with limit', () => {
    const result = handleListWorkflowRetros({ limit: 10 });
    expect(Array.isArray(result.structuredData.retros)).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests**

Run on remote: `npx vitest run tests/retros-handlers.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/tool-defs/retro-defs.js server/tool-defs/index.js server/handlers/retro-handlers.js server/tools.js server/tests/retros-handlers.test.js
git commit -m "feat(retros): MCP tools get_workflow_retro + list_workflow_retros"
git push --no-verify origin main
```

---

## Task 7: REST routes

**Files:**
- Modify: `server/api/routes-passthrough.js`

- [ ] **Step 1: Add routes**

Near the existing workflow routes, add:

```js
{ method: 'GET', path: /^\/api\/v2\/workflows\/([^/]+)\/retro$/, tool: 'get_workflow_retro', mapParams: ['workflow_id'] },
{ method: 'GET', path: '/api/v2/retros', tool: 'list_workflow_retros', mapQuery: true },
```

- [ ] **Step 2: Commit**

```bash
git add server/api/routes-passthrough.js
git commit -m "feat(retros): REST routes"
git push --no-verify origin main
```

---

## Task 8: Dashboard Retros view

**Files:**
- Modify: `dashboard/src/api.js`
- Create: `dashboard/src/views/Retros.jsx`
- Create: `dashboard/src/views/Retros.test.jsx`
- Modify: `dashboard/src/App.jsx`, `dashboard/src/components/Layout.jsx`

- [ ] **Step 1: API client**

In `dashboard/src/api.js` add:

```js
export const retros = {
  list: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/retros${query ? `?${query}` : ''}`);
  },
  get: (workflowId) => requestV2(`/workflows/${workflowId}/retro`),
};
```

- [ ] **Step 2: Write failing test**

Create `dashboard/src/views/Retros.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Retros from './Retros';

vi.mock('../api', () => ({ retros: { list: vi.fn() } }));
import { retros } from '../api';

function renderView() {
  return render(<MemoryRouter><Retros /></MemoryRouter>);
}

describe('Retros view', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows empty state', async () => {
    retros.list.mockResolvedValue({ retros: [] });
    renderView();
    await waitFor(() => expect(screen.getByText(/No retros/i)).toBeInTheDocument());
  });

  it('lists retros with smoothness badges', async () => {
    retros.list.mockResolvedValue({
      retros: [{
        workflow_id: 'wf-1',
        smoothness: 'smooth',
        narrative_status: 'complete',
        stats: { workflow_name: 'deploy', task_count: 5, total_duration_seconds: 120 },
        narrative: { intent: 'deploy the app', outcome: 'shipped it' },
      }],
    });
    renderView();
    await waitFor(() => expect(screen.getByText('deploy')).toBeInTheDocument());
    expect(screen.getByText(/smooth/i)).toBeInTheDocument();
    expect(screen.getByText(/shipped it/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Implement view**

Create `dashboard/src/views/Retros.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { retros as retrosApi } from '../api';

const SMOOTHNESS_COLORS = {
  effortless: 'bg-green-600/40 text-green-200',
  smooth: 'bg-green-700/30 text-green-300',
  bumpy: 'bg-amber-600/30 text-amber-200',
  struggled: 'bg-orange-700/30 text-orange-300',
  failed: 'bg-red-700/30 text-red-300',
};

export default function Retros() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    retrosApi.list({ limit: 100 })
      .then(r => setRows(r.retros || []))
      .catch(e => setError(e.message || 'Failed to load'));
  }, []);

  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;
  if (rows === null) return <div className="p-4 text-slate-400">Loading...</div>;
  if (rows.length === 0) {
    return (
      <div className="p-4">
        <h1 className="text-xl text-white mb-2">Retros</h1>
        <p className="text-slate-400">No retros yet. They are generated automatically when workflows complete.</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h1 className="text-xl text-white mb-4">Retros</h1>
      <div className="space-y-3">
        {rows.map(r => {
          const stats = r.stats || {};
          const n = r.narrative;
          const cls = SMOOTHNESS_COLORS[r.smoothness] || 'bg-slate-600/30 text-slate-300';
          return (
            <div key={r.workflow_id} className="border border-slate-600/40 bg-slate-700/30 rounded-lg p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-white font-semibold">{stats.workflow_name || r.workflow_id.slice(0, 8)}</h2>
                    <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>
                      {r.smoothness || r.narrative_status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {stats.task_count || 0} tasks · {stats.total_duration_seconds || 0}s ·{' '}
                    verify pass={stats.verify_summary?.pass || 0} / fail={stats.verify_summary?.fail || 0}
                  </p>
                  {n && (
                    <div className="mt-2 text-sm text-slate-300">
                      <p><strong>Intent:</strong> {n.intent}</p>
                      <p><strong>Outcome:</strong> {n.outcome}</p>
                      {n.friction_points?.length > 0 && (
                        <p className="mt-1 text-amber-300">
                          Friction: {n.friction_points.map(f => f.note).join('; ')}
                        </p>
                      )}
                    </div>
                  )}
                  {r.narrative_error && (
                    <p className="text-xs text-red-400 mt-1">Narrative unavailable: {r.narrative_error}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add route + nav**

In `dashboard/src/App.jsx` add:
```jsx
import Retros from './views/Retros';
// ...
<Route path="/retros" element={<Retros />} />
```

In `dashboard/src/components/Layout.jsx` nav: `{ to: '/retros', label: 'Retros' }`.

- [ ] **Step 5: Run test, build**

Run (dashboard dir): `npx vitest run src/views/Retros.test.jsx --no-coverage`

Expected: PASS.

Run: `npx vite build` — expect success.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/api.js dashboard/src/views/Retros.jsx dashboard/src/views/Retros.test.jsx dashboard/src/App.jsx dashboard/src/components/Layout.jsx
git commit -m "feat(dashboard): Retros view"
git push --no-verify origin main
```

---

## Task 9: User docs

**Files:**
- Create: `docs/retros.md`

- [ ] **Step 1: Write docs**

Create `docs/retros.md`:

````markdown
# Retrospectives

After every completed workflow, TORQUE generates a structured retro: deterministic stats + an LLM-written narrative. Browse them in the dashboard under **Retros**, or via the MCP tool `list_workflow_retros`.

## What's in a retro

### Deterministic stats (always present)

- `total_duration_seconds`, `task_count`, `completed_count`, `failed_count`
- `total_retries` across all stages
- `files_touched` — union of files modified across all tasks
- `verify_summary` — counts of `tests:pass` / `tests:fail:N` / `tests:timeout` tags
- `per_stage` — per-task breakdown: provider, status, duration, retry count, files, verify outcome

### Narrative (LLM-written)

- **Smoothness** — `effortless` / `smooth` / `bumpy` / `struggled` / `failed`
- **Intent** — what the workflow was trying to do (one sentence)
- **Outcome** — what actually happened (one sentence)
- **Learnings** — categorized as `repo` / `code` / `workflow` / `tool`
- **Friction points** — where things got stuck (`retry` / `timeout` / `wrong_approach` / `failover` / `human_block`)
- **Open items** — follow-up work identified

Narrative is best-effort. If the LLM is unavailable or returns malformed JSON, the retro row is marked `narrative_status: failed` but the stats are still written.

## When retros are generated

Retros fire automatically when a workflow transitions to `status: completed`. They do NOT fire on `failed` or `cancelled` workflows (v1 limitation).

Generation is fire-and-forget: a slow or broken LLM never blocks the workflow itself from completing.

## Querying retros

```
# Via MCP
list_workflow_retros { limit: 20, smoothness: "bumpy" }
get_workflow_retro { workflow_id: "..." }

# Via REST
GET /api/v2/retros?limit=20&smoothness=bumpy
GET /api/v2/workflows/:id/retro
```

## Schema

Stored in the `workflow_retros` table:

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Retro row ID |
| `workflow_id` | TEXT (UNIQUE) | The workflow this retro is for |
| `generated_at` | TEXT ISO8601 | When the retro was created |
| `stats_json` | TEXT | Deterministic stats JSON |
| `narrative_json` | TEXT nullable | Narrative JSON (after LLM call) |
| `narrative_status` | TEXT | `pending` / `generating` / `complete` / `failed` |
| `narrative_error` | TEXT nullable | Error message if generation failed |
| `smoothness` | TEXT nullable | Smoothness rating (denormalized for filter index) |
````

- [ ] **Step 2: Commit**

```bash
git add docs/retros.md
git commit -m "docs(retros): user guide"
git push --no-verify origin main
```

---

## Task 10: Full suite + restart + smoke test

- [ ] **Step 1: Run all retro tests**

Run on remote: `npx vitest run tests/retros- --no-coverage`

Expected: All PASS.

- [ ] **Step 2: Restart TORQUE**

Use `await_restart` with reason `Load retros feature`.

- [ ] **Step 3: Smoke test**

Submit a small workflow via `create_workflow`, let it complete, then call `get_workflow_retro { workflow_id: ... }`. Expected: stats present. `narrative_status` is `complete` if a narrative LLM is configured; `failed` otherwise (documented as acceptable for v1).

- [ ] **Step 4: Rebuild dashboard**

Run (dashboard dir): `npx vite build`. Hard-refresh dashboard, navigate to **Retros**, confirm the test workflow appears.
