# Fabro #60: Graphs-as-Library + Remote Debugger (Rivet)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Package TORQUE's workflow runtime as an **embeddable Node.js library** — any host application can `npm install @torque/runtime`, load a workflow YAML from disk, call `runWorkflow({ args, signalHandlers, abortSignal })`, and receive streaming events. Pair it with a `torque-debugger` WebSocket protocol so the running dashboard can attach to an external process and inspect its workflows live. Inspired by Rivet's `@ironclad/rivet-node` + remote debugging.

**Architecture:** Extract the workflow execution core into `packages/torque-runtime/` with a narrow public API: `loadWorkflow`, `runWorkflow`, `startDebuggerServer(port)`. The debugger protocol emits `step_started`, `step_completed`, `state_patched`, `artifact_produced` over WebSocket, and accepts `pause`, `resume`, `inject_state_patch` messages. The TORQUE dashboard gains a "Attach to remote process" action that connects over WebSocket and renders that runtime's workflows alongside its own.

**Tech Stack:** Node.js, WebSocket (ws), pnpm workspace (or npm workspace). Builds on plans 1 (workflow-as-code), 14 (events), 29 (journal), 32 (distributed runtime).

---

## File Structure

**New files:**
- `packages/torque-runtime/package.json`
- `packages/torque-runtime/src/index.js` — public API
- `packages/torque-runtime/src/loader.js` — load + validate YAML
- `packages/torque-runtime/src/runner.js` — execute graph
- `packages/torque-runtime/src/debugger-server.js` — WS server
- `packages/torque-runtime/src/debugger-protocol.js` — message shapes
- `packages/torque-runtime/README.md`
- `packages/torque-runtime/tests/runner.test.js`
- `packages/torque-runtime/tests/debugger.test.js`
- `dashboard/src/views/AttachRemote.jsx`

**Modified files:**
- `server/index.js` — re-export package or depend on it internally
- `package.json` — add workspace + dependency

---

## Task 1: Package skeleton + loader

- [ ] **Step 1: Package.json**

Create `packages/torque-runtime/package.json`:

```json
{
  "name": "@torque/runtime",
  "version": "0.1.0",
  "description": "Embeddable TORQUE workflow runtime for Node.js.",
  "main": "src/index.js",
  "types": "src/index.d.ts",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "js-yaml": "^4.1.0",
    "ajv": "^8.12.0",
    "ws": "^8.17.0"
  },
  "peerDependencies": {},
  "license": "MIT"
}
```

- [ ] **Step 2: Loader**

Create `packages/torque-runtime/src/loader.js`:

```js
'use strict';
const fs = require('fs');
const yaml = require('js-yaml');
const Ajv = require('ajv');

const WORKFLOW_SCHEMA = {
  type: 'object',
  required: ['name', 'tasks'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    inputs: { type: 'object' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          task_description: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
          produces: { type: 'array', items: { type: 'string' } },
          consumes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const ajv = new Ajv();
const validate = ajv.compile(WORKFLOW_SCHEMA);

function loadWorkflow(pathOrSource) {
  const raw = pathOrSource.includes('\n') ? pathOrSource : fs.readFileSync(pathOrSource, 'utf8');
  const doc = yaml.load(raw);
  if (!validate(doc)) {
    const errs = validate.errors.map(e => `${e.instancePath}: ${e.message}`).join('; ');
    throw new Error(`workflow validation failed: ${errs}`);
  }
  return doc;
}

module.exports = { loadWorkflow, WORKFLOW_SCHEMA };
```

Commit: `feat(runtime): package skeleton + YAML loader with schema validation`.

---

## Task 2: Runner

- [ ] **Step 1: Tests**

Create `packages/torque-runtime/tests/runner.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { createRunner } = require('../src/runner');

describe('createRunner.runWorkflow', () => {
  it('runs tasks in dependency order', async () => {
    const order = [];
    const executeStep = vi.fn(async (task) => { order.push(task.id); return { output: `done-${task.id}` }; });
    const runner = createRunner({ executeStep });
    const result = await runner.runWorkflow({
      workflow: {
        name: 'test',
        tasks: [
          { id: 'a' },
          { id: 'b', depends_on: ['a'] },
          { id: 'c', depends_on: ['a'] },
          { id: 'd', depends_on: ['b', 'c'] },
        ],
      },
      args: {},
    });
    // 'a' first, then 'b' and 'c' in any order, then 'd'
    expect(order[0]).toBe('a');
    expect(order[3]).toBe('d');
    expect(result.outputs.a).toBe('done-a');
    expect(result.status).toBe('completed');
  });

  it('emits step_started / step_completed events', async () => {
    const events = [];
    const runner = createRunner({
      executeStep: async (t) => ({ output: 'x' }),
      onEvent: (e) => events.push(e),
    });
    await runner.runWorkflow({ workflow: { name: 'x', tasks: [{ id: 'a' }, { id: 'b' }] }, args: {} });
    const types = events.map(e => e.type);
    expect(types).toContain('step_started');
    expect(types).toContain('step_completed');
    expect(types.filter(t => t === 'step_completed').length).toBe(2);
  });

  it('honors abortSignal', async () => {
    const ctrl = new AbortController();
    const runner = createRunner({
      executeStep: async () => { await new Promise(r => setTimeout(r, 100)); return { output: 'x' }; },
    });
    setTimeout(() => ctrl.abort(), 20);
    const result = await runner.runWorkflow({
      workflow: { name: 'x', tasks: [{ id: 'a' }, { id: 'b', depends_on: ['a'] }] },
      args: {}, abortSignal: ctrl.signal,
    });
    expect(result.status).toBe('aborted');
  });

  it('marks workflow failed if any step throws', async () => {
    const runner = createRunner({
      executeStep: async (t) => { if (t.id === 'b') throw new Error('boom'); return { output: 'x' }; },
    });
    const result = await runner.runWorkflow({
      workflow: { name: 'x', tasks: [{ id: 'a' }, { id: 'b', depends_on: ['a'] }] },
      args: {},
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/boom/);
  });
});
```

- [ ] **Step 2: Implement**

Create `packages/torque-runtime/src/runner.js`:

```js
'use strict';

function createRunner({ executeStep, onEvent = () => {} }) {
  async function runWorkflow({ workflow, args = {}, abortSignal }) {
    const { tasks } = workflow;
    const outputs = {};
    const pending = new Map(tasks.map(t => [t.id, { task: t, deps: new Set(t.depends_on || []) }]));
    const completed = new Set();

    onEvent({ type: 'workflow_started', workflow: workflow.name });

    while (pending.size > 0) {
      if (abortSignal?.aborted) {
        return { status: 'aborted', outputs };
      }
      const ready = [...pending.values()].filter(p => [...p.deps].every(d => completed.has(d)));
      if (ready.length === 0) {
        return { status: 'failed', error: 'cyclic or unresolved dependencies', outputs };
      }
      const results = await Promise.all(ready.map(async ({ task }) => {
        onEvent({ type: 'step_started', step: task.id });
        try {
          const out = await executeStep({ ...task, args, upstream: outputs });
          onEvent({ type: 'step_completed', step: task.id, output: out.output });
          return { id: task.id, output: out.output };
        } catch (err) {
          onEvent({ type: 'step_failed', step: task.id, error: err.message });
          throw Object.assign(err, { stepId: task.id });
        }
      })).catch(err => ({ err }));
      if (results.err) {
        return { status: 'failed', error: results.err.message, failed_step: results.err.stepId, outputs };
      }
      for (const r of results) {
        outputs[r.id] = r.output;
        completed.add(r.id);
        pending.delete(r.id);
      }
    }
    onEvent({ type: 'workflow_completed', outputs });
    return { status: 'completed', outputs };
  }

  return { runWorkflow };
}

module.exports = { createRunner };
```

Run tests → PASS. Commit: `feat(runtime): in-process runner with dependency scheduling + events`.

---

## Task 3: Debugger server + public API

- [ ] **Step 1: Debugger tests**

Create `packages/torque-runtime/tests/debugger.test.js`:

```js
'use strict';
const { describe, it, expect, vi, beforeAll, afterAll } = require('vitest');
const WebSocket = require('ws');
const { startDebuggerServer } = require('../src/debugger-server');

describe('debuggerServer', () => {
  let server, port;
  beforeAll(async () => {
    port = 18765;
    server = await startDebuggerServer({ port });
  });
  afterAll(() => server?.close());

  function connect() {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on('open', () => resolve(ws));
    });
  }

  it('broadcasts emitted events to connected clients', async () => {
    const ws = await connect();
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    server.emit({ type: 'step_started', step: 'a' });
    server.emit({ type: 'step_completed', step: 'a', output: 'x' });
    await new Promise(r => setTimeout(r, 100));

    expect(received.length).toBe(2);
    expect(received[0].type).toBe('step_started');
    ws.close();
  });

  it('receives client commands via onCommand handler', async () => {
    const handler = vi.fn();
    server.onCommand(handler);

    const ws = await connect();
    ws.send(JSON.stringify({ type: 'pause', workflow_id: 'wf-1' }));
    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'pause' }));
    ws.close();
  });
});
```

- [ ] **Step 2: Implement**

Create `packages/torque-runtime/src/debugger-server.js`:

```js
'use strict';
const WebSocket = require('ws');

async function startDebuggerServer({ port = 9876 } = {}) {
  const wss = new WebSocket.Server({ port });
  const clients = new Set();
  const commandHandlers = [];

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        for (const h of commandHandlers) h(msg);
      } catch { /* ignore malformed */ }
    });
    ws.on('close', () => clients.delete(ws));
  });

  await new Promise(resolve => wss.on('listening', resolve));

  return {
    port,
    emit(event) {
      const payload = JSON.stringify(event);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    },
    onCommand(handler) { commandHandlers.push(handler); },
    close() { wss.close(); },
  };
}

module.exports = { startDebuggerServer };
```

- [ ] **Step 3: Public API**

Create `packages/torque-runtime/src/index.js`:

```js
'use strict';
const { loadWorkflow } = require('./loader');
const { createRunner } = require('./runner');
const { startDebuggerServer } = require('./debugger-server');

async function runWorkflow({ path, source, executeStep, args, abortSignal, debuggerPort }) {
  const workflow = loadWorkflow(path || source);
  let debug = null;
  if (debuggerPort) {
    debug = await startDebuggerServer({ port: debuggerPort });
    // Allow external dashboard to pause — not implemented in this minimal version
  }
  const runner = createRunner({
    executeStep,
    onEvent: (e) => debug?.emit(e),
  });
  try {
    return await runner.runWorkflow({ workflow, args, abortSignal });
  } finally {
    debug?.close();
  }
}

module.exports = { loadWorkflow, runWorkflow, createRunner, startDebuggerServer };
```

Commit: `feat(runtime): debugger WebSocket server + public runWorkflow API`.

---

## Task 4: Dashboard "Attach to remote" view

- [ ] **Step 1: Dashboard**

Create `dashboard/src/views/AttachRemote.jsx`:

```jsx
import { useState, useRef } from 'react';

export default function AttachRemote() {
  const [url, setUrl] = useState('ws://localhost:9876');
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState([]);
  const wsRef = useRef(null);

  function connect() {
    const ws = new WebSocket(url);
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => setEvents(prev => [...prev, JSON.parse(e.data)]);
    ws.onclose = () => setConnected(false);
    wsRef.current = ws;
  }

  function disconnect() {
    wsRef.current?.close();
  }

  function sendCommand(cmd) {
    wsRef.current?.send(JSON.stringify(cmd));
  }

  return (
    <div className="p-4 max-w-5xl">
      <h2 className="text-xl font-semibold mb-2">Attach to remote @torque/runtime</h2>
      <div className="flex gap-2 mb-3">
        <input value={url} onChange={e => setUrl(e.target.value)} className="border rounded px-2 py-1 flex-1" />
        {!connected
          ? <button onClick={connect} className="px-3 py-1 bg-blue-600 text-white rounded">Connect</button>
          : <button onClick={disconnect} className="px-3 py-1 bg-red-600 text-white rounded">Disconnect</button>}
        <button onClick={() => sendCommand({ type: 'pause' })} disabled={!connected} className="px-3 py-1 bg-yellow-600 text-white rounded">Pause</button>
      </div>
      <div className="bg-gray-900 text-gray-100 p-3 rounded text-xs font-mono max-h-[60vh] overflow-auto">
        {events.map((e, i) => (
          <div key={i}>
            <span className="text-gray-400">{e.type}</span> {JSON.stringify(e).slice(0, 200)}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Docs + README**

Create `packages/torque-runtime/README.md` with install + basic example:

````markdown
# @torque/runtime

Embed TORQUE workflows in any Node.js app.

## Install

```bash
npm install @torque/runtime
```

## Example

```js
const { runWorkflow } = require('@torque/runtime');

await runWorkflow({
  path: './my-workflow.yaml',
  args: { repo_name: 'my-app' },
  executeStep: async ({ id, task_description, upstream }) => {
    // You decide how each step runs — LLM call, shell, HTTP, etc.
    return { output: `[${id}] handled: ${task_description}` };
  },
  debuggerPort: 9876, // optional — lets TORQUE dashboard attach
});
```

With `debuggerPort`, open the TORQUE dashboard → "Attach to remote" → `ws://localhost:9876` to stream live events.
````

`await_restart`. Smoke: `cd packages/torque-runtime && npm test`. Then write a small standalone Node script that calls `runWorkflow` with `debuggerPort`, attach the dashboard, confirm events stream live.

Commit: `feat(runtime): dashboard attach-to-remote view + README`.
