# Fabro #9: Workflow Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Schedule workflow specs to run on a cron — `torque schedule create --workflow-spec workflows/nightly-factory.yaml --cron "0 2 * * *"`. TORQUE already has task-level scheduling; this extends the scheduler to dispatch `run_workflow_spec` instead of `submit_task` when the schedule fires.

**Architecture:** The existing `scheduled_tasks` table has a `task_payload` JSON column. Add a `payload_kind` discriminator: `task` (existing) vs `workflow_spec`. When the scheduler fires a row with `payload_kind: workflow_spec`, it calls `handleRunWorkflowSpec` instead of `handleSubmitTask`. New MCP tool `schedule_workflow_spec` mirrors `schedule_task` but accepts a spec path.

**Depends on Plan 1 (workflow-as-code).**

---

## File Structure

**Modified files:**
- `server/db/schema-tables.js` — add `payload_kind` column to `scheduled_tasks`
- `server/db/scheduling-automation.js` (or wherever scheduled_tasks CRUD lives) — accept `payload_kind`
- `server/execution/schedule-runner.js` — branch on `payload_kind`
- `server/handlers/schedule-handlers.js` — new `handleScheduleWorkflowSpec`
- `server/tool-defs/automation-defs.js` (or wherever schedule_task is defined) — add `schedule_workflow_spec`
- `server/tools.js` — dispatch case
- `docs/scheduling.md`

**New files:**
- `server/tests/schedule-workflow-spec.test.js`

---

## Task 1: Schema migration

- [ ] **Step 1: Add column**

In `server/db/schema-tables.js`, alter `scheduled_tasks`:

```sql
ALTER TABLE scheduled_tasks ADD COLUMN payload_kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE scheduled_tasks ADD COLUMN spec_path TEXT;
```

- [ ] **Step 2: Commit**

```bash
git add server/db/schema-tables.js
git commit -m "feat(scheduling): add payload_kind column to scheduled_tasks"
git push --no-verify origin main
```

---

## Task 2: CRUD + handler

- [ ] **Step 1: Tool def**

In `server/tool-defs/automation-defs.js` (or wherever `schedule_task` is defined), add:

```js
{
  name: 'schedule_workflow_spec',
  description: 'Schedule a workflow spec to run on a cron schedule. Equivalent to schedule_task but dispatches run_workflow_spec instead of submit_task.',
  inputSchema: {
    type: 'object',
    required: ['name', 'cron', 'spec_path'],
    properties: {
      name: { type: 'string', description: 'Schedule name (unique).' },
      cron: { type: 'string', description: 'Cron expression (e.g., "0 2 * * *" for 2am daily).' },
      spec_path: { type: 'string', description: 'Path to workflow spec YAML, relative to working_directory or absolute.' },
      working_directory: { type: 'string' },
      enabled: { type: 'boolean', default: true },
      timezone: { type: 'string', description: 'IANA timezone (e.g., "America/Denver"). Defaults to system tz.' },
    },
  },
},
```

- [ ] **Step 2: Handler**

In `server/handlers/schedule-handlers.js` (create if not present, mirroring existing schedule_task handler):

```js
'use strict';

const { randomUUID } = require('crypto');
const path = require('path');
const db = require('../database');
const { ErrorCodes, makeError } = require('./shared');

function handleScheduleWorkflowSpec(args) {
  if (!args.name || !args.cron || !args.spec_path) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name, cron, and spec_path are required');
  }

  const specAbs = path.isAbsolute(args.spec_path)
    ? args.spec_path
    : path.join(args.working_directory || process.cwd(), args.spec_path);

  // Validate the spec parses before scheduling
  const { parseSpec } = require('../workflow-spec');
  const parsed = parseSpec(specAbs);
  if (!parsed.ok) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Spec ${specAbs} does not parse:\n- ${parsed.errors.join('\n- ')}`
    );
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO scheduled_tasks (id, name, cron, payload_kind, spec_path, task_payload, enabled, timezone, created_at)
    VALUES (?, ?, ?, 'workflow_spec', ?, NULL, ?, ?, ?)
  `).run(id, args.name, args.cron, specAbs, args.enabled === false ? 0 : 1, args.timezone || null, new Date().toISOString());

  return {
    content: [{ type: 'text', text: `Scheduled workflow spec '${args.name}' (id ${id}) to run on '${args.cron}'.` }],
    structuredData: { schedule_id: id, name: args.name, cron: args.cron, spec_path: specAbs },
  };
}

module.exports = { handleScheduleWorkflowSpec };
```

- [ ] **Step 3: Dispatch case in `server/tools.js`**

Add to `handleToolCall`:

```js
case 'schedule_workflow_spec': {
  const { handleScheduleWorkflowSpec } = require('./handlers/schedule-handlers');
  return handleScheduleWorkflowSpec(args);
}
```

- [ ] **Step 4: Commit**

```bash
git add server/tool-defs/automation-defs.js server/handlers/schedule-handlers.js server/tools.js
git commit -m "feat(scheduling): schedule_workflow_spec tool + handler"
git push --no-verify origin main
```

---

## Task 3: Schedule runner branches on payload_kind

- [ ] **Step 1: Locate the firing logic**

Read `server/execution/schedule-runner.js`. Find where the cron tick reads a row from `scheduled_tasks` and dispatches it (likely calls `handleSubmitTask` or similar).

- [ ] **Step 2: Branch on payload_kind**

```js
async function fireScheduledRow(row) {
  if (row.payload_kind === 'workflow_spec') {
    if (!row.spec_path) {
      logger.warn(`[schedule] Row ${row.id} has payload_kind=workflow_spec but no spec_path; skipping`);
      return;
    }
    const { handleRunWorkflowSpec } = require('../handlers/workflow-spec-handlers');
    return handleRunWorkflowSpec({ spec_path: row.spec_path });
  }

  // Default: existing task payload path
  const payload = row.task_payload ? JSON.parse(row.task_payload) : {};
  const { handleSubmitTask } = require('../handlers/task');
  return handleSubmitTask(payload);
}
```

(If the existing function is named differently, integrate at the equivalent dispatch point.)

- [ ] **Step 3: Test**

Create `server/tests/schedule-workflow-spec.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { handleScheduleWorkflowSpec } = require('../handlers/schedule-handlers');

let db, testDir;
beforeAll(() => { const e = setupTestDb('schedule-ws'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('schedule_workflow_spec', () => {
  it('creates a scheduled row with payload_kind=workflow_spec', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const specPath = path.join(wfDir, 's.yaml');
    fs.writeFileSync(specPath, 'version: 1\nname: s\ntasks:\n  - node_id: a\n    task: x\n');

    const result = handleScheduleWorkflowSpec({
      name: 'nightly',
      cron: '0 2 * * *',
      spec_path: specPath,
    });
    expect(result.isError).toBeFalsy();
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(result.structuredData.schedule_id);
    expect(row.payload_kind).toBe('workflow_spec');
    expect(row.spec_path).toBe(specPath);
    expect(row.cron).toBe('0 2 * * *');
  });

  it('rejects spec that does not parse', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const badPath = path.join(wfDir, 'bad.yaml');
    fs.writeFileSync(badPath, 'not: valid');
    const result = handleScheduleWorkflowSpec({
      name: 'bad',
      cron: '* * * * *',
      spec_path: badPath,
    });
    expect(result.isError).toBe(true);
  });
});
```

Run: `npx vitest run tests/schedule-workflow-spec.test.js --no-coverage` → PASS.

- [ ] **Step 4: Commit**

```bash
git add server/execution/schedule-runner.js server/tests/schedule-workflow-spec.test.js
git commit -m "feat(scheduling): runner dispatches workflow specs by payload_kind"
git push --no-verify origin main
```

---

## Task 4: REST passthrough + dashboard surface

- [ ] **Step 1: REST route**

In `server/api/routes-passthrough.js`:

```js
{ method: 'POST', path: '/api/v2/schedules/workflow-spec', tool: 'schedule_workflow_spec', mapBody: true },
```

- [ ] **Step 2: Dashboard already lists schedules — verify the new payload_kind shows up**

Open the dashboard's Schedules view (likely `dashboard/src/views/Schedules.jsx`). If it currently displays `task_payload.task_description`, add a branch for `payload_kind === 'workflow_spec'` showing `spec_path`.

- [ ] **Step 3: Commit + restart**

```bash
git add server/api/routes-passthrough.js dashboard/src/views/Schedules.jsx
git commit -m "feat(scheduling): REST + dashboard support for scheduled workflow specs"
git push --no-verify origin main
```

`await_restart`. Then via MCP: `schedule_workflow_spec { name: "smoke", cron: "* * * * *", spec_path: "workflows/example-plan-implement.yaml" }`. Within a minute, the workflow should fire. List workflows and confirm a new one was created.

- [ ] **Step 4: Docs**

Create or append `docs/scheduling.md`:

````markdown
## Scheduled workflow specs

Schedule a workflow spec to run on a cron:

```bash
schedule_workflow_spec {
  name: "nightly-factory",
  cron: "0 2 * * *",
  spec_path: "workflows/nightly-factory.yaml",
  timezone: "America/Denver"
}
```

The schedule runner dispatches `run_workflow_spec` when the cron fires, creating a fresh workflow each time.

Differences from `schedule_task`:
- Payload is a YAML spec path, not a task payload object
- Spec is parsed/validated at schedule time — if it doesn't parse, scheduling is rejected
- Each fire creates a new workflow ID (no de-duplication; if you want at-most-one-running, gate it via the spec itself)
````

```bash
git add docs/scheduling.md
git commit -m "docs(scheduling): scheduled workflow specs guide"
git push --no-verify origin main
```
