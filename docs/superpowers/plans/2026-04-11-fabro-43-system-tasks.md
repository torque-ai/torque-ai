# Fabro #43: Declarative System Tasks (Conductor)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a small catalog of **system tasks** that run inside the workflow runtime rather than dispatching to a provider — `inline` (run a sandboxed JS expression), `jq_transform` (reshape JSON via jq), `http_call` (basic outbound HTTP), and `human` (block until operator submits a form). These cover the "glue between LLM tasks" use cases without needing a custom worker. Inspired by Conductor's INLINE / JQ_TRANSFORM / HTTP / HUMAN tasks.

**Architecture:** A new `kind` enum value covers each system task: `inline`, `jq_transform`, `http_call`, `human`. The task-startup pipeline branches on `kind` and routes system tasks to a `system-task-runner.js` instead of the provider dispatcher. Each runner is short, pure (where possible), sandboxed, and writes its result back to the task's output. Human tasks publish a form schema to the dashboard, suspend the workflow, and resume on submission.

**Tech Stack:** Node.js, vm2 (or `node:vm` with hardening) for inline JS, node-jq, undici for http. Builds on plans 5 (parallel fanout — kind enum), 26 (crew — kind enum), 30 (signals).

---

## File Structure

**New files:**
- `server/system-tasks/system-task-runner.js` — dispatcher
- `server/system-tasks/runners/inline.js`
- `server/system-tasks/runners/jq-transform.js`
- `server/system-tasks/runners/http-call.js`
- `server/system-tasks/runners/human.js`
- `server/tests/system-task-inline.test.js`
- `server/tests/system-task-jq.test.js`
- `server/tests/system-task-http.test.js`
- `server/tests/system-task-human.test.js`

**Modified files:**
- `server/execution/task-startup.js` — branch on system task kinds
- `server/tool-defs/workflow-defs.js` — extend `kind` enum
- `dashboard/src/views/HumanTaskInbox.jsx`

---

## Task 1: Inline runner

- [ ] **Step 1: Tests**

Create `server/tests/system-task-inline.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { runInline } = require('../system-tasks/runners/inline');

describe('runInline', () => {
  it('evaluates a simple expression with input', async () => {
    const out = await runInline({ expression: 'input.a + input.b', input: { a: 1, b: 2 } });
    expect(out.result).toBe(3);
  });

  it('rejects code that uses require, process, fs, etc.', async () => {
    await expect(runInline({ expression: "require('fs')", input: {} })).rejects.toThrow();
    await expect(runInline({ expression: 'process.env', input: {} })).rejects.toThrow();
  });

  it('honors timeout', async () => {
    await expect(runInline({ expression: 'while(true){}', input: {}, timeoutMs: 50 })).rejects.toThrow(/timeout/i);
  });

  it('returns serializable result', async () => {
    const out = await runInline({ expression: '({ x: input.x * 2, y: input.y + "!" })', input: { x: 5, y: 'hi' } });
    expect(out.result).toEqual({ x: 10, y: 'hi!' });
  });

  it('exposes Math and JSON helpers in scope', async () => {
    const out = await runInline({ expression: 'Math.max(...input.nums)', input: { nums: [1, 7, 3] } });
    expect(out.result).toBe(7);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/system-tasks/runners/inline.js`:

```js
'use strict';
const vm = require('node:vm');

const SAFE_GLOBALS = ['Math', 'JSON', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'parseInt', 'parseFloat', 'isFinite', 'isNaN'];

async function runInline({ expression, input, timeoutMs = 1000 }) {
  if (typeof expression !== 'string' || expression.length === 0) {
    throw new Error('inline.expression must be a non-empty string');
  }
  // Block obvious escape hatches at the source level. The vm context already
  // hides require/process/fs but explicit denylist guards against silly cases.
  if (/\b(require|process|global|globalThis|module|fs|child_process|eval)\b/.test(expression)) {
    throw new Error('inline.expression contains forbidden identifiers');
  }

  const sandbox = { input };
  for (const k of SAFE_GLOBALS) sandbox[k] = global[k];

  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`(${expression})`);
  const result = script.runInContext(ctx, { timeout: timeoutMs });

  // Ensure result is JSON-serializable (rejects functions, undefined, etc.)
  return { result: JSON.parse(JSON.stringify(result)) };
}

module.exports = { runInline };
```

Run tests → PASS. Commit: `feat(system-tasks): inline runner with sandboxed JS evaluation`.

---

## Task 2: JQ transform runner

- [ ] **Step 1: Tests**

Create `server/tests/system-task-jq.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { runJqTransform } = require('../system-tasks/runners/jq-transform');

describe('runJqTransform', () => {
  it('selects field with jq', async () => {
    const out = await runJqTransform({ filter: '.name', input: { name: 'alice', age: 30 } });
    expect(out.result).toBe('alice');
  });

  it('builds new shape from input', async () => {
    const out = await runJqTransform({ filter: '{ display: (.name + " (" + (.age|tostring) + ")") }', input: { name: 'a', age: 5 } });
    expect(out.result).toEqual({ display: 'a (5)' });
  });

  it('arrays + map work', async () => {
    const out = await runJqTransform({ filter: '[.[] | .v]', input: [{v:1},{v:2},{v:3}] });
    expect(out.result).toEqual([1,2,3]);
  });

  it('throws on malformed filter', async () => {
    await expect(runJqTransform({ filter: '.[invalid', input: {} })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/system-tasks/runners/jq-transform.js`:

```js
'use strict';
const jq = require('node-jq');

async function runJqTransform({ filter, input }) {
  if (typeof filter !== 'string') throw new Error('jq.filter required');
  const out = await jq.run(filter, input, { input: 'json', output: 'json' });
  return { result: out };
}

module.exports = { runJqTransform };
```

Run tests → PASS. Commit: `feat(system-tasks): jq_transform runner`.

---

## Task 3: HTTP call runner

- [ ] **Step 1: Tests**

Create `server/tests/system-task-http.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runHttpCall } = require('../system-tasks/runners/http-call');

describe('runHttpCall', () => {
  it('GETs a URL and returns status + body', async () => {
    global.fetch = vi.fn(async () => ({
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
    }));
    const out = await runHttpCall({ method: 'GET', url: 'https://example.com/x' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
  });

  it('rejects non-allowlisted hosts when allowlist set', async () => {
    await expect(runHttpCall({ method: 'GET', url: 'https://evil.example.com/', allowlist: ['api.openai.com'] })).rejects.toThrow(/not allowlisted/i);
  });

  it('honors timeout', async () => {
    global.fetch = vi.fn(() => new Promise(() => {})); // never resolves
    await expect(runHttpCall({ method: 'GET', url: 'https://x', timeoutMs: 50 })).rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/system-tasks/runners/http-call.js`:

```js
'use strict';

async function runHttpCall({ method = 'GET', url, headers = {}, body = null, timeoutMs = 30000, allowlist = null }) {
  if (!url) throw new Error('http_call.url required');
  if (allowlist && Array.isArray(allowlist)) {
    let host;
    try { host = new URL(url).hostname; } catch { throw new Error('http_call.url is not a valid URL'); }
    if (!allowlist.includes(host)) throw new Error(`Host ${host} not allowlisted`);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`http_call timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(t);
  }

  const contentType = res.headers.get('content-type') || '';
  let parsed;
  if (contentType.includes('application/json')) {
    try { parsed = await res.json(); } catch { parsed = await res.text(); }
  } else {
    parsed = await res.text();
  }
  return { status: res.status, body: parsed };
}

module.exports = { runHttpCall };
```

Commit: `feat(system-tasks): http_call runner with allowlist + timeout`.

---

## Task 4: Human task runner

- [ ] **Step 1: Tests**

Create `server/tests/system-task-human.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createHumanTaskRunner } = require('../system-tasks/runners/human');

describe('humanTaskRunner', () => {
  let db, runner;
  beforeEach(() => {
    db = setupTestDb();
    runner = createHumanTaskRunner({ db });
  });

  it('open creates a pending human task with form schema', () => {
    const id = runner.open({
      taskId: 'task-1', formTitle: 'Approve release',
      formSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
    });
    const row = db.prepare('SELECT * FROM human_tasks WHERE human_task_id = ?').get(id);
    expect(row.task_id).toBe('task-1');
    expect(row.status).toBe('pending');
    expect(JSON.parse(row.form_schema_json).type).toBe('object');
  });

  it('submit stores response and marks completed', () => {
    const id = runner.open({ taskId: 't1', formTitle: 't', formSchema: { type: 'object' } });
    runner.submit(id, { approved: true });
    const row = db.prepare('SELECT * FROM human_tasks WHERE human_task_id = ?').get(id);
    expect(row.status).toBe('completed');
    expect(JSON.parse(row.response_json).approved).toBe(true);
  });

  it('listPending returns only pending', () => {
    const a = runner.open({ taskId: 't1', formTitle: 'a', formSchema: {} });
    const b = runner.open({ taskId: 't2', formTitle: 'b', formSchema: {} });
    runner.submit(a, { ok: true });
    expect(runner.listPending().map(r => r.human_task_id)).toEqual([b]);
  });
});
```

- [ ] **Step 2: Migration + implement**

`server/migrations/0NN-human-tasks.sql`:

```sql
CREATE TABLE IF NOT EXISTS human_tasks (
  human_task_id TEXT PRIMARY KEY,
  task_id TEXT,
  workflow_id TEXT,
  form_title TEXT,
  form_description TEXT,
  form_schema_json TEXT,
  response_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_human_tasks_status ON human_tasks(status);
```

Create `server/system-tasks/runners/human.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createHumanTaskRunner({ db }) {
  function open({ taskId, workflowId = null, formTitle, formDescription = null, formSchema }) {
    const id = `ht_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO human_tasks (human_task_id, task_id, workflow_id, form_title, form_description, form_schema_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, taskId, workflowId, formTitle, formDescription, JSON.stringify(formSchema || {}));
    return id;
  }

  function submit(humanTaskId, response) {
    db.prepare(`
      UPDATE human_tasks SET response_json = ?, status = 'completed', completed_at = datetime('now')
      WHERE human_task_id = ?
    `).run(JSON.stringify(response || {}), humanTaskId);
  }

  function get(id) {
    return db.prepare('SELECT * FROM human_tasks WHERE human_task_id = ?').get(id);
  }

  function listPending() {
    return db.prepare(`SELECT * FROM human_tasks WHERE status = 'pending' ORDER BY opened_at`).all();
  }

  return { open, submit, get, listPending };
}

module.exports = { createHumanTaskRunner };
```

Run tests → PASS. Commit: `feat(system-tasks): human task runner with form schema + submission`.

---

## Task 5: Wire into task-startup

- [ ] **Step 1: Extend kind enum**

In `server/tool-defs/workflow-defs.js` extend the `kind` enum:

```js
kind: { type: 'string', enum: ['agent', 'parallel_fanout', 'merge', 'crew', 'inline', 'jq_transform', 'http_call', 'human'] },
```

Add corresponding metadata fields:

```js
inline: { type: 'object', properties: { expression: { type: 'string' } } },
jq_transform: { type: 'object', properties: { filter: { type: 'string' } } },
http_call: { type: 'object', properties: { method: { type: 'string' }, url: { type: 'string' }, headers: { type: 'object' }, body: {} } },
human: { type: 'object', properties: { form_title: { type: 'string' }, form_description: { type: 'string' }, form_schema: { type: 'object' } } },
```

- [ ] **Step 2: Dispatcher**

Create `server/system-tasks/system-task-runner.js`:

```js
'use strict';
const { runInline } = require('./runners/inline');
const { runJqTransform } = require('./runners/jq-transform');
const { runHttpCall } = require('./runners/http-call');

async function runSystemTask({ task, taskMeta, container, db }) {
  const kind = taskMeta.kind;
  const completed = (output) => {
    db.prepare(`UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now') WHERE task_id = ?`)
      .run(typeof output === 'string' ? output : JSON.stringify(output), task.task_id);
  };

  switch (kind) {
    case 'inline': {
      const cfg = taskMeta.inline || {};
      const out = await runInline({ expression: cfg.expression, input: cfg.input || {}, timeoutMs: cfg.timeout_ms });
      completed(out);
      return { systemTask: true, kind };
    }
    case 'jq_transform': {
      const cfg = taskMeta.jq_transform || {};
      const out = await runJqTransform({ filter: cfg.filter, input: cfg.input || {} });
      completed(out);
      return { systemTask: true, kind };
    }
    case 'http_call': {
      const cfg = taskMeta.http_call || {};
      const out = await runHttpCall(cfg);
      completed(out);
      return { systemTask: true, kind };
    }
    case 'human': {
      const cfg = taskMeta.human || {};
      const runner = container.get('humanTaskRunner');
      runner.open({
        taskId: task.task_id, workflowId: task.workflow_id,
        formTitle: cfg.form_title, formDescription: cfg.form_description, formSchema: cfg.form_schema,
      });
      // Leave the task in 'running' state — submission marks it completed
      db.prepare(`UPDATE tasks SET status = 'awaiting_human' WHERE task_id = ?`).run(task.task_id);
      return { systemTask: true, kind, awaitingHuman: true };
    }
    default:
      throw new Error(`Unknown system task kind: ${kind}`);
  }
}

module.exports = { runSystemTask };
```

In `server/execution/task-startup.js` after metadata is parsed:

```js
const SYSTEM_KINDS = ['inline', 'jq_transform', 'http_call', 'human'];
if (SYSTEM_KINDS.includes(taskMeta.kind)) {
  const { runSystemTask } = require('../system-tasks/system-task-runner');
  return await runSystemTask({ task, taskMeta, container: defaultContainer, db });
}
```

Container:

```js
container.factory('humanTaskRunner', (c) => require('./system-tasks/runners/human').createHumanTaskRunner({ db: c.get('db') }));
```

Commit: `feat(system-tasks): branch task-startup on system task kinds`.

---

## Task 6: Human task inbox dashboard + REST resume

- [ ] **Step 1: REST**

In `server/api/routes/human-tasks.js`:

```js
router.get('/', (req, res) => {
  res.json({ pending: defaultContainer.get('humanTaskRunner').listPending() });
});

router.post('/:id/submit', express.json(), (req, res) => {
  const runner = defaultContainer.get('humanTaskRunner');
  const ht = runner.get(req.params.id);
  if (!ht) return res.status(404).json({ error: 'unknown' });
  runner.submit(req.params.id, req.body || {});

  // Mark the parent task completed and unblock workflow
  const db = defaultContainer.get('db');
  db.prepare(`UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now') WHERE task_id = ?`)
    .run(JSON.stringify(req.body || {}), ht.task_id);

  // Re-trigger scheduler tick
  defaultContainer.get('queueScheduler').tick();
  res.json({ ok: true });
});
```

- [ ] **Step 2: Dashboard inbox**

Create `dashboard/src/views/HumanTaskInbox.jsx` listing pending forms with title, description, dynamically-rendered form fields from `form_schema_json`, and Submit button.

`await_restart`. Smoke: workflow with 3 nodes — `agent` → `human` (with simple `{approved: bool}` form) → `inline` (uses `$state.approved` to branch). Confirm dashboard surfaces the form, submission unblocks downstream node.

Commit: `feat(system-tasks): human task inbox + form submission resumes workflow`.
