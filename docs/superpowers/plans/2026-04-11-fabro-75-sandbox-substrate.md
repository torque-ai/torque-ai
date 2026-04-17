# Fabro #75: Sandbox Substrate (E2B + Modal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give TORQUE a first-class **sandbox primitive** — an isolated execution environment with filesystem, terminal, and code-exec APIs, lifecycle control (create/pause/resume/destroy), streaming output, and pluggable backends (E2B, Modal, local Docker, local process). Verify commands, Plan 42 debug sessions, and Plan 43 shell system-tasks can opt into running in a sandbox instead of against the host. Inspired by E2B + Modal Sandbox.

**Architecture:** A `Sandbox` abstraction with a narrow interface: `create(options)`, `runCommand`, `fs.read/write/list`, `snapshot`, `destroy`. Pluggable **backends** implement it: `local-process-backend.js` (fallback), `docker-backend.js`, `e2b-backend.js`, `modal-backend.js`. Tasks select a backend via `sandbox: { backend: 'e2b', image: 'node22', timeout_ms: 600_000 }`. Every backend uses `execFile`-style arg arrays — no shell interpolation.

**Tech Stack:** Node.js, E2B SDK / Modal SDK / Dockerode / `child_process.execFile`. Builds on plans 42 (debug), 43 (system tasks), 52 (connections).

---

## File Structure

**New files:**
- `server/sandbox/sandbox-interface.js` — contract doc
- `server/sandbox/backends/local-process.js`
- `server/sandbox/backends/docker-backend.js`
- `server/sandbox/backends/e2b-backend.js`
- `server/sandbox/backends/modal-backend.js`
- `server/sandbox/sandbox-manager.js` — registry + lease tracking
- `server/tests/sandbox-manager.test.js`
- `server/tests/local-process-backend.test.js`

**Modified files:**
- `server/system-tasks/runners/shell.js` (Plan 43) — run inside sandbox when configured
- `server/validation/auto-verify-retry.js` — optional sandbox execution
- `server/handlers/mcp-tools.js` — `create_sandbox`, `sandbox_run`, `sandbox_read`, `sandbox_write`, `destroy_sandbox`

---

## Task 1: Interface + local backend

- [x] **Step 1: Interface contract**

Create `server/sandbox/sandbox-interface.js`:

```js
'use strict';

// Contract every sandbox backend implements. Each method listed here as a reminder;
// backends are plain objects with these function-shaped keys.
//
// create({ image?, cwd?, env?, timeoutMs?, name? }) → { sandboxId, backend }
// runCommand(sandboxId, { cmd, args, cwd?, env?, stdin?, timeoutMs? }) → { stdout, stderr, exitCode }
// fs.read(sandboxId, path) → Buffer
// fs.write(sandboxId, path, content) → { bytes }
// fs.list(sandboxId, path) → [{ name, type, size }]
// destroy(sandboxId) → { destroyed }
// snapshot(sandboxId) → { imageId }
//
// IMPORTANT: runCommand takes cmd + args array separately. No shell interpolation.

module.exports = { /* marker only */ };
```

- [x] **Step 2: Local backend tests**

Create `server/tests/local-process-backend.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLocalProcessBackend } = require('../sandbox/backends/local-process');

describe('localProcessBackend', () => {
  let backend, dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
    backend = createLocalProcessBackend({ workDir: dir });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('create + runCommand runs in sandbox cwd', async () => {
    const { sandboxId } = await backend.create({ name: 'test' });
    const { stdout, exitCode } = await backend.runCommand(sandboxId, {
      cmd: 'node', args: ['-e', 'console.log("hi")'],
    });
    expect(stdout.trim()).toBe('hi');
    expect(exitCode).toBe(0);
  });

  it('fs.write + fs.read roundtrips a file', async () => {
    const { sandboxId } = await backend.create({});
    await backend.fs.write(sandboxId, 'a.txt', 'hello');
    const buf = await backend.fs.read(sandboxId, 'a.txt');
    expect(buf.toString()).toBe('hello');
  });

  it('fs.list enumerates written files', async () => {
    const { sandboxId } = await backend.create({});
    await backend.fs.write(sandboxId, 'x.txt', '1');
    await backend.fs.write(sandboxId, 'y.txt', '2');
    const files = await backend.fs.list(sandboxId, '.');
    expect(files.map(f => f.name).sort()).toEqual(['x.txt', 'y.txt']);
  });

  it('destroy removes sandbox directory', async () => {
    const { sandboxId } = await backend.create({});
    await backend.fs.write(sandboxId, 'a.txt', 'x');
    await backend.destroy(sandboxId);
    await expect(backend.runCommand(sandboxId, { cmd: 'ls' })).rejects.toThrow(/not found/i);
  });

  it('runCommand rejects cwd that escapes the sandbox', async () => {
    const { sandboxId } = await backend.create({});
    await expect(backend.runCommand(sandboxId, { cmd: 'ls', cwd: '/etc' })).rejects.toThrow(/escape/i);
  });

  it('runCommand honors timeoutMs', async () => {
    const { sandboxId } = await backend.create({});
    const slowCmd = process.platform === 'win32' ? 'ping' : 'sleep';
    const slowArgs = process.platform === 'win32' ? ['-n', '10', '127.0.0.1'] : ['5'];
    await expect(backend.runCommand(sandboxId, { cmd: slowCmd, args: slowArgs, timeoutMs: 100 })).rejects.toThrow(/timeout/i);
  });
});
```

- [x] **Step 3: Implement local backend**

Create `server/sandbox/backends/local-process.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const pExecFile = promisify(execFile);

function createLocalProcessBackend({ workDir }) {
  const sandboxes = new Map();

  function resolveIn(sbRoot, p) {
    const abs = path.resolve(sbRoot, p || '.');
    if (!abs.startsWith(path.resolve(sbRoot))) {
      throw new Error(`path escape attempt: ${p}`);
    }
    return abs;
  }

  function get(sandboxId) {
    const sb = sandboxes.get(sandboxId);
    if (!sb) throw new Error(`sandbox not found: ${sandboxId}`);
    return sb;
  }

  async function create({ name = null } = {}) {
    const id = `sb_${randomUUID().slice(0, 12)}`;
    const root = path.join(workDir, id);
    fs.mkdirSync(root, { recursive: true });
    sandboxes.set(id, { root, created_at: Date.now(), name });
    return { sandboxId: id, backend: 'local-process' };
  }

  async function runCommand(sandboxId, { cmd, args = [], cwd = null, env = null, timeoutMs = 30000 }) {
    const sb = get(sandboxId);
    const effectiveCwd = cwd ? resolveIn(sb.root, cwd) : sb.root;
    try {
      const { stdout, stderr } = await pExecFile(cmd, args, {
        cwd: effectiveCwd, env: { ...process.env, ...(env || {}) }, timeout: timeoutMs,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      if (err.killed) throw new Error(`runCommand timeout after ${timeoutMs}ms`);
      return { stdout: err.stdout || '', stderr: err.stderr || err.message, exitCode: err.code || 1 };
    }
  }

  const fsApi = {
    async read(sandboxId, p) {
      const sb = get(sandboxId);
      return fs.readFileSync(resolveIn(sb.root, p));
    },
    async write(sandboxId, p, content) {
      const sb = get(sandboxId);
      const abs = resolveIn(sb.root, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return { bytes: Buffer.byteLength(content) };
    },
    async list(sandboxId, p) {
      const sb = get(sandboxId);
      return fs.readdirSync(resolveIn(sb.root, p), { withFileTypes: true })
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
    },
  };

  async function destroy(sandboxId) {
    const sb = get(sandboxId);
    fs.rmSync(sb.root, { recursive: true, force: true });
    sandboxes.delete(sandboxId);
    return { destroyed: true };
  }

  async function snapshot() { throw new Error('local-process backend does not support snapshots'); }

  return { create, runCommand, fs: fsApi, destroy, snapshot };
}

module.exports = { createLocalProcessBackend };
```

Run tests → PASS. Commit: `feat(sandbox): local-process backend with cwd escape guard`.

---

## Task 2: Manager

- [x] **Step 1: Tests**

Create `server/tests/sandbox-manager.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { createSandboxManager } = require('../sandbox/sandbox-manager');

describe('sandboxManager', () => {
  it('registerBackend + create routes to the named backend', async () => {
    const fakeBackend = { create: vi.fn(async () => ({ sandboxId: 'sb-1', backend: 'fake' })) };
    const mgr = createSandboxManager();
    mgr.registerBackend('fake', fakeBackend);
    const sb = await mgr.create({ backend: 'fake', image: 'x' });
    expect(sb.sandboxId).toBe('sb-1');
    expect(fakeBackend.create).toHaveBeenCalledWith({ image: 'x' });
  });

  it('throws on unknown backend', async () => {
    const mgr = createSandboxManager();
    await expect(mgr.create({ backend: 'nope' })).rejects.toThrow(/unknown/i);
  });

  it('list returns all active sandboxes; destroy removes them', async () => {
    let counter = 0;
    const backend = {
      create: vi.fn(async () => ({ sandboxId: `sb-${counter++}`, backend: 'fake' })),
      destroy: vi.fn(async () => ({ destroyed: true })),
    };
    const mgr = createSandboxManager();
    mgr.registerBackend('fake', backend);
    const a = await mgr.create({ backend: 'fake' });
    await mgr.create({ backend: 'fake' });
    expect(mgr.list().length).toBe(2);
    await mgr.destroy(a.sandboxId);
    expect(mgr.list().length).toBe(1);
  });
});
```

- [x] **Step 2: Implement**

Create `server/sandbox/sandbox-manager.js`:

```js
'use strict';

function createSandboxManager() {
  const backends = new Map();
  const active = new Map();

  function registerBackend(name, backend) { backends.set(name, backend); }

  async function create({ backend = 'local-process', ...options }) {
    const impl = backends.get(backend);
    if (!impl) throw new Error(`unknown backend: ${backend}`);
    const result = await impl.create(options);
    active.set(result.sandboxId, { backend, created_at: Date.now(), meta: options });
    return result;
  }

  function getBackendFor(sandboxId) {
    const row = active.get(sandboxId);
    if (!row) throw new Error(`sandbox not found: ${sandboxId}`);
    return backends.get(row.backend);
  }

  async function runCommand(sandboxId, opts)  { return getBackendFor(sandboxId).runCommand(sandboxId, opts); }
  async function readFile(sandboxId, p)       { return getBackendFor(sandboxId).fs.read(sandboxId, p); }
  async function writeFile(sandboxId, p, c)   { return getBackendFor(sandboxId).fs.write(sandboxId, p, c); }
  async function listDir(sandboxId, p)        { return getBackendFor(sandboxId).fs.list(sandboxId, p); }
  async function snapshot(sandboxId)          { return getBackendFor(sandboxId).snapshot(sandboxId); }
  async function destroy(sandboxId) {
    await getBackendFor(sandboxId).destroy(sandboxId);
    active.delete(sandboxId);
    return { destroyed: true };
  }

  function list() {
    return Array.from(active.entries()).map(([id, row]) => ({ sandbox_id: id, ...row }));
  }

  return { registerBackend, create, runCommand, readFile, writeFile, listDir, snapshot, destroy, list };
}

module.exports = { createSandboxManager };
```

Run tests → PASS. Commit: `feat(sandbox): manager + backend registry`.

---

## Task 3: E2B adapter + MCP + use-sites

- [ ] **Step 1: E2B backend**

Create `server/sandbox/backends/e2b-backend.js` — thin wrapper around `@e2b/code-interpreter`. Requires `E2B_API_KEY`. Implements the same `{ create, runCommand, fs, destroy, snapshot }` surface. See E2B SDK docs; the adapter forwards `runCommand` to the SDK's `commands.run` with the same arg shape, forwards `fs.read/write/list` to `files.read/write/list`, and calls `kill()` on destroy.

- [ ] **Step 2: Container + MCP tools**

```js
container.factory('sandboxManager', (c) => {
  const { createSandboxManager } = require('./sandbox/sandbox-manager');
  const { createLocalProcessBackend } = require('./sandbox/backends/local-process');
  const { createE2BBackend } = require('./sandbox/backends/e2b-backend');
  const mgr = createSandboxManager();
  mgr.registerBackend('local-process', createLocalProcessBackend({ workDir: '.torque/sandbox' }));
  if (process.env.E2B_API_KEY) mgr.registerBackend('e2b', createE2BBackend({ apiKey: process.env.E2B_API_KEY }));
  return mgr;
});
```

MCP tools:

```js
create_sandbox: { description: 'Create a sandbox using the configured backend.', inputSchema: { type: 'object', properties: { backend: {type:'string'}, image: {type:'string'}, timeout_ms: {type:'integer'} } } },
sandbox_run: { description: 'Run a command inside a sandbox. Takes argv array; no shell interpolation.', inputSchema: { type: 'object', required: ['sandbox_id','cmd'], properties: { sandbox_id: {type:'string'}, cmd: {type:'string'}, args: { type: 'array', items:{type:'string'} }, cwd: {type:'string'}, env: {type:'object'}, timeout_ms: {type:'integer'} } } },
sandbox_read: { description: 'Read a file from a sandbox.', inputSchema: { type: 'object', required: ['sandbox_id','path'], properties: { sandbox_id: {type:'string'}, path: {type:'string'} } } },
sandbox_write: { description: 'Write content to a file in a sandbox.', inputSchema: { type: 'object', required: ['sandbox_id','path','content'], properties: { sandbox_id: {type:'string'}, path: {type:'string'}, content: {type:'string'} } } },
destroy_sandbox: { description: 'Destroy a sandbox and free resources.', inputSchema: { type: 'object', required: ['sandbox_id'], properties: { sandbox_id: {type:'string'} } } },
```

- [ ] **Step 3: Opt-in for verify + debug**

In `server/validation/auto-verify-retry.js`: when task metadata has `verify_in_sandbox: true`, create a sandbox, copy workspace into it, run the verify command via `runCommand`, tear down. In Plan 42 debug-session-runtime: attach a long-lived sandbox to each session for reproducing bugs safely.

`await_restart`. Smoke: `create_sandbox({backend:'local-process'})`, `sandbox_run({cmd:'node', args:['-v']})`, confirm stdout. With `E2B_API_KEY` set, `create_sandbox({backend:'e2b'})` — confirm it spins up a remote microVM.

Commit: `feat(sandbox): E2B adapter + MCP surface + verify/debug opt-in`.
