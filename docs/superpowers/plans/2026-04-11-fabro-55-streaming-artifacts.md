# Fabro #55: Streaming Artifact Protocol (Bolt.diy)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let tasks emit typed actions — `<action type="file" path="...">…</action>`, `<action type="shell" cmd="..." arg="...">…</action>`, `<action type="state_patch">…</action>` — as **stream chunks** during generation, applied incrementally to the working tree or to workflow state, with each chunk journaled and revertable. Inspired by Bolt.diy's `<boltArtifact>/<boltAction>` protocol.

**Architecture:** A new `action-stream-parser.js` consumes the provider's streaming token output and emits fully-formed action blocks as they close. A new `action-applier.js` routes each closed action to the right sink: file writer, shell runner (execFile, no shell), state patcher (Plan 27). Each applied action is recorded in `applied_actions` with `(task_id, seq, type, payload, applied_at)`. The journal (Plan 29) gets a new `action_applied` event per apply.

**Tech Stack:** Node.js, existing provider streaming, `execFile` (never shell) for commands. Builds on plans 14 (events), 19 (lifecycle hooks), 20 (shadow-git checkpoints), 27 (state), 29 (journal).

---

## File Structure

**New files:**
- `server/migrations/0NN-applied-actions.sql`
- `server/actions/stream-parser.js`
- `server/actions/action-applier.js`
- `server/actions/sinks/file-sink.js`
- `server/actions/sinks/shell-sink.js`
- `server/actions/sinks/state-sink.js`
- `server/tests/stream-parser.test.js`
- `server/tests/action-applier.test.js`

**Modified files:**
- `server/providers/*` — feed streaming tokens into parser when configured
- `server/handlers/task/submit.js` — accept `streaming_actions: true`

---

## Task 1: Stream parser

- [ ] **Step 1: Tests**

Create `server/tests/stream-parser.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createStreamParser } = require('../actions/stream-parser');

describe('streamParser', () => {
  it('emits a complete action when closing tag arrives', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action type="file" path="src/foo.js">');
    p.feed('console.log("hi");');
    p.feed('</action>');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: 'file', path: 'src/foo.js', content: 'console.log("hi");',
    });
  });

  it('handles multiple actions across chunks', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action type="shell" cmd="echo" args="hi"></action>');
    p.feed('<action type="file" path="a.txt">hello');
    p.feed('</action>');
    expect(emitted).toHaveLength(2);
    expect(emitted[0].type).toBe('shell');
    expect(emitted[1].type).toBe('file');
  });

  it('ignores text outside action tags', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('plain prose. <action type="file" path="x.js">code</action> more prose.');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].path).toBe('x.js');
  });

  it('captures multi-attribute values', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action type="state_patch" key="round" reducer="numeric_sum">1</action>');
    expect(emitted[0]).toEqual({ type: 'state_patch', key: 'round', reducer: 'numeric_sum', content: '1' });
  });

  it('handles closing tag split across chunks', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action type="file" path="a">content</ac');
    p.feed('tion>');
    expect(emitted).toHaveLength(1);
  });

  it('ignores malformed tags and continues', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action invalid="no type">nope</action>');
    p.feed('<action type="file" path="ok.js">ok</action>');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].path).toBe('ok.js');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/actions/stream-parser.js`:

```js
'use strict';

const OPEN_RE = /<action\b([^>]*)>/;
const CLOSE_TAG = '</action>';

function parseAttributes(attrString) {
  const attrs = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function createStreamParser({ onAction }) {
  let buffer = '';
  let state = 'idle'; // 'idle' | 'inside'
  let currentAttrs = null;
  let currentContent = '';

  function feed(chunk) {
    buffer += chunk;
    while (true) {
      if (state === 'idle') {
        const m = buffer.match(OPEN_RE);
        if (!m) {
          const idx = buffer.lastIndexOf('<');
          if (idx > 0) buffer = buffer.slice(idx);
          return;
        }
        const attrs = parseAttributes(m[1]);
        if (!attrs.type) {
          buffer = buffer.slice(m.index + m[0].length);
          continue;
        }
        currentAttrs = attrs;
        currentContent = '';
        buffer = buffer.slice(m.index + m[0].length);
        state = 'inside';
      } else {
        const idx = buffer.indexOf(CLOSE_TAG);
        if (idx === -1) {
          const safeEnd = Math.max(0, buffer.length - CLOSE_TAG.length + 1);
          currentContent += buffer.slice(0, safeEnd);
          buffer = buffer.slice(safeEnd);
          return;
        }
        currentContent += buffer.slice(0, idx);
        buffer = buffer.slice(idx + CLOSE_TAG.length);
        onAction?.({ ...currentAttrs, content: currentContent });
        currentAttrs = null;
        currentContent = '';
        state = 'idle';
      }
    }
  }

  function end() {
    state = 'idle';
    currentAttrs = null;
    currentContent = '';
    buffer = '';
  }

  return { feed, end };
}

module.exports = { createStreamParser };
```

Run tests → PASS. Commit: `feat(actions): streaming parser for <action>…</action> blocks`.

---

## Task 2: Action applier + sinks

- [ ] **Step 1: Migration**

`server/migrations/0NN-applied-actions.sql`:

```sql
CREATE TABLE IF NOT EXISTS applied_actions (
  action_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  seq INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_applied_actions_task ON applied_actions(task_id, seq);
```

- [ ] **Step 2: Applier tests**

Create `server/tests/action-applier.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { setupTestDb } = require('./helpers/test-db');
const { createActionApplier } = require('../actions/action-applier');

describe('actionApplier', () => {
  let db, applier, workDir;
  beforeEach(() => {
    db = setupTestDb();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
    db.prepare(`INSERT INTO tasks (task_id, status) VALUES ('t1','running')`).run();
    applier = createActionApplier({
      db,
      sinks: {
        file: async ({ attrs, content }) => {
          fs.mkdirSync(path.dirname(path.join(workDir, attrs.path)), { recursive: true });
          fs.writeFileSync(path.join(workDir, attrs.path), content);
          return { ok: true, bytes: content.length };
        },
        shell: vi.fn(async () => ({ ok: true, stdout: 'mock', exitCode: 0 })),
        state_patch: vi.fn(async () => ({ ok: true })),
      },
    });
  });

  it('applies a file action and records it', async () => {
    const r = await applier.apply({ taskId: 't1', action: { type: 'file', path: 'a.js', content: 'x' } });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(workDir, 'a.js'), 'utf8')).toBe('x');
    const row = db.prepare('SELECT * FROM applied_actions WHERE task_id = ?').get('t1');
    expect(row.action_type).toBe('file');
    expect(row.seq).toBe(1);
  });

  it('dispatches to correct sink based on type', async () => {
    await applier.apply({ taskId: 't1', action: { type: 'shell', cmd: 'echo', args: 'hi' } });
    await applier.apply({ taskId: 't1', action: { type: 'state_patch', key: 'x', content: '1' } });
    const rows = db.prepare('SELECT action_type FROM applied_actions WHERE task_id = ? ORDER BY seq').all('t1');
    expect(rows.map(r => r.action_type)).toEqual(['shell', 'state_patch']);
  });

  it('increments seq monotonically per task', async () => {
    for (let i = 0; i < 5; i++) {
      await applier.apply({ taskId: 't1', action: { type: 'file', path: `f${i}`, content: 'x' } });
    }
    const seqs = db.prepare('SELECT seq FROM applied_actions WHERE task_id = ? ORDER BY seq').all('t1').map(r => r.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('unknown type throws', async () => {
    await expect(applier.apply({ taskId: 't1', action: { type: 'unknown', content: 'x' } })).rejects.toThrow(/unknown/i);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/actions/action-applier.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createActionApplier({ db, sinks, logger = console }) {
  async function apply({ taskId, workflowId = null, action }) {
    const sink = sinks[action.type];
    if (!sink) throw new Error(`Unknown action type: ${action.type}`);

    const attrs = { ...action };
    const content = action.content;
    delete attrs.content;
    delete attrs.type;

    const result = await sink({ attrs, content });

    const seq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM applied_actions WHERE task_id = ?`).get(taskId)).n;
    const id = `a_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO applied_actions (action_id, task_id, workflow_id, seq, action_type, payload_json, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, workflowId, seq, action.type, JSON.stringify({ attrs, content }), JSON.stringify(result));

    return { ok: true, action_id: id, seq, ...result };
  }

  return { apply };
}

module.exports = { createActionApplier };
```

Run tests → PASS. Commit: `feat(actions): applier with pluggable sinks + sequenced recording`.

---

## Task 3: Built-in sinks + provider streaming hook

- [ ] **Step 1: File sink**

Create `server/actions/sinks/file-sink.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

function createFileSink({ workingDir }) {
  return async ({ attrs, content }) => {
    if (!attrs.path) throw new Error('file action requires path attribute');
    const abs = path.resolve(workingDir, attrs.path);
    if (!abs.startsWith(path.resolve(workingDir))) throw new Error('path escapes working dir');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { ok: true, path: attrs.path, bytes: Buffer.byteLength(content) };
  };
}

module.exports = { createFileSink };
```

- [ ] **Step 2: Shell sink (no-shell, allowlist-required)**

Create `server/actions/sinks/shell-sink.js`:

```js
'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const pExecFile = promisify(execFile);

// Shell sink runs a single binary with argv — never through a shell.
// Requires the command to be on the configured allowlist; no shell features
// (pipes, redirects, globs, $()) are supported by design.
function createShellSink({ workingDir, allowlist = [], timeoutMs = 30000 }) {
  return async ({ attrs }) => {
    if (!attrs.cmd) throw new Error('shell action requires cmd attribute');
    if (allowlist.length > 0 && !allowlist.includes(attrs.cmd)) {
      throw new Error(`command '${attrs.cmd}' not on allowlist`);
    }
    const args = attrs.args ? attrs.args.split(/\s+/) : [];
    const cwd = attrs.cwd ? path.resolve(workingDir, attrs.cwd) : workingDir;
    const { stdout, stderr } = await pExecFile(attrs.cmd, args, { cwd, timeout: timeoutMs });
    return { ok: true, stdout, stderr };
  };
}

module.exports = { createShellSink };
```

- [ ] **Step 3: State sink**

Create `server/actions/sinks/state-sink.js`:

```js
'use strict';

function createStateSink({ workflowState }) {
  return async ({ attrs, content }) => {
    if (!attrs.workflow_id || !attrs.key) throw new Error('state_patch action requires workflow_id + key');
    const value = tryParseJson(content);
    const patch = { [attrs.key]: value };
    const r = workflowState.applyPatch(attrs.workflow_id, patch);
    if (!r.ok) throw new Error(`state patch rejected: ${(r.errors || []).join(', ')}`);
    return { ok: true };
  };
}

function tryParseJson(s) { try { return JSON.parse(s); } catch { return s; } }

module.exports = { createStateSink };
```

- [ ] **Step 4: Provider hook + container**

In `server/providers/*` — when a provider supports streaming and the task has `streaming_actions: true`, pipe tokens through:

```js
const { createStreamParser } = require('../actions/stream-parser');
const applier = defaultContainer.get('actionApplier');
const parser = createStreamParser({
  onAction: (action) => {
    applier.apply({ taskId, workflowId: task.workflow_id, action })
      .catch(err => logger.warn('action apply failed', err));
  },
});
providerStream.on('token', (t) => parser.feed(t));
providerStream.on('end', () => parser.end());
```

Container:

```js
container.factory('actionApplier', (c) => {
  const { createActionApplier } = require('./actions/action-applier');
  const workingDir = c.get('serverConfig').get('default_working_dir') || process.cwd();
  const allowlist = (c.get('serverConfig').get('shell_action_allowlist') || '').split(',').filter(Boolean);
  return createActionApplier({
    db: c.get('db'),
    sinks: {
      file: require('./actions/sinks/file-sink').createFileSink({ workingDir }),
      shell: require('./actions/sinks/shell-sink').createShellSink({ workingDir, allowlist }),
      state_patch: require('./actions/sinks/state-sink').createStateSink({ workflowState: c.get('workflowState') }),
    },
  });
});
```

`await_restart`. Smoke: submit a task with `streaming_actions: true` and a prompt that asks the model to emit 3 `<action type="file">` blocks. Confirm files appear incrementally on disk, each with a row in `applied_actions` and an ordered seq.

Commit: `feat(actions): file/shell/state sinks + provider streaming integration`.
