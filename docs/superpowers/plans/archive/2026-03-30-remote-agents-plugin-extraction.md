# Remote Agents Plugin Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the remote agent federation subsystem from the TORQUE core into `plugins/remote-agents/`, leaving a thin test-runner interface in the core that falls back to local execution when the plugin is not loaded.

**Architecture:** The core defines a `TestRunnerRegistry` — a tiny service that holds one function: `runVerifyCommand(cmd, cwd, opts) → result`. By default it runs commands locally. When the remote-agents plugin is installed, the plugin replaces this function with the full remote-or-local router. The validation modules (`post-task.js`, `build-verification.js`, `auto-verify-retry.js`) call the registry instead of importing `remote-test-routing.js` directly. All remote agent management (registry, client, server, handlers, tool-defs, bootstrap endpoint, health checks) moves into the plugin.

**Tech Stack:** Node.js, better-sqlite3, TORQUE plugin contract (install/uninstall/mcpTools/middleware/eventHandlers/configSchema)

---

## File Structure

### New files (plugin)

| File | Responsibility |
|------|---------------|
| `server/plugins/remote-agents/index.js` | Plugin entry — install/uninstall, registers test-runner override, exposes mcpTools |
| `server/plugins/remote-agents/tool-defs.js` | MCP tool definitions (moved from `tool-defs/remote-agent-defs.js`) |
| `server/plugins/remote-agents/handlers.js` | MCP tool handlers (moved from `handlers/remote-agent-handlers.js`) |
| `server/plugins/remote-agents/agent-registry.js` | RemoteAgentRegistry class (moved from `remote/agent-registry.js`) |
| `server/plugins/remote-agents/agent-client.js` | RemoteAgentClient class (moved from `remote/agent-client.js`) |
| `server/plugins/remote-agents/agent-server.js` | Standalone agent HTTP server (moved from `remote/agent-server.js`) |
| `server/plugins/remote-agents/remote-test-routing.js` | createRemoteTestRouter (moved from `remote/remote-test-routing.js`) |
| `server/plugins/remote-agents/bootstrap.js` | Workstation bootstrap endpoint (moved from `api/bootstrap.js`) |
| `server/plugins/remote-agents/tests/plugin.test.js` | Plugin integration test |

### New files (core)

| File | Responsibility |
|------|---------------|
| `server/test-runner-registry.js` | Core service: holds `runVerifyCommand` + `runRemoteOrLocal` functions. Default = local-only. Plugin overrides via `register()`. |

### Modified files (core — remove remote imports)

| File | Change |
|------|--------|
| `server/index.js` | Remove `RemoteAgentRegistry` import, remove `agentRegistry` init, remove validation `.init({ agentRegistry })` calls. Add `remote-agents` to `DEFAULT_PLUGIN_NAMES`. Create `TestRunnerRegistry` and pass to validation modules. |
| `server/validation/post-task.js` | Replace `createRemoteTestRouter` import with `TestRunnerRegistry` consumption. Remove `_agentRegistry` field. |
| `server/validation/build-verification.js` | Same as post-task.js. |
| `server/validation/auto-verify-retry.js` | Same as post-task.js. |
| `server/handlers/automation-handlers.js` | Replace `createRemoteTestRouter` import with `TestRunnerRegistry` consumption. |
| `server/tools.js` | Remove `remote-agent-defs` spread and `remote-agent-handlers` require. |
| `server/maintenance/scheduler.js` | Remove `getAgentRegistry` dependency; plugin registers its own health-check timer. |
| `server/api/routes.js` | Remove `/api/agents/*` route entries (plugin registers via middleware). |
| `server/api/v2-core-handlers.js` | Remove `remoteAgentHandlers` import and `runRemoteCommandCore`/`runTestsCore` handlers (plugin registers). |
| `server/api/v2-dispatch.js` | Remove `remoteAgentHandlers` import and `handleV2CpRunRemoteCommand`/`handleV2CpRunTests` entries. |
| `server/api/v2-infrastructure-handlers.js` | Remove `_listAgents`, `_getAgent`, `_healthCheckAgent` functions and associated raw SQL queries. |
| `server/container.js` | Register `testRunnerRegistry` service. |

### Deleted files

| File | Reason |
|------|--------|
| `server/remote/agent-registry.js` | Moved to plugin |
| `server/remote/agent-client.js` | Moved to plugin |
| `server/remote/agent-server.js` | Moved to plugin |
| `server/remote/remote-test-routing.js` | Moved to plugin |
| `server/handlers/remote-agent-handlers.js` | Moved to plugin |
| `server/tool-defs/remote-agent-defs.js` | Moved to plugin |
| `server/api/bootstrap.js` | Moved to plugin |

### Test files to move

| From | To |
|------|-----|
| `server/tests/remote-agent-handlers.test.js` | `server/plugins/remote-agents/tests/handlers.test.js` |
| `server/tests/remote-agent-server.test.js` | `server/plugins/remote-agents/tests/agent-server.test.js` |
| `server/tests/remote-command-rest.test.js` | `server/plugins/remote-agents/tests/command-rest.test.js` |
| `server/tests/remote-command-tools.test.js` | `server/plugins/remote-agents/tests/command-tools.test.js` |
| `server/tests/remote-test-integration.test.js` | `server/plugins/remote-agents/tests/integration.test.js` |
| `server/tests/remote-test-routing-env.test.js` | `server/plugins/remote-agents/tests/routing-env.test.js` |
| `server/tests/remote-test-routing.test.js` | `server/plugins/remote-agents/tests/routing.test.js` |
| `server/tests/agent-client-tls.test.js` | `server/plugins/remote-agents/tests/agent-client-tls.test.js` |
| `server/tests/agent-registry-security.test.js` | `server/plugins/remote-agents/tests/agent-registry-security.test.js` |
| `server/tests/remote/agent-client.test.js` | `server/plugins/remote-agents/tests/agent-client.test.js` |
| `server/tests/remote/agent-registry.test.js` | `server/plugins/remote-agents/tests/agent-registry.test.js` |
| `server/tests/remote/remote-agent-handlers.test.js` | `server/plugins/remote-agents/tests/remote-agent-handlers.test.js` |
| `server/tests/remote/remote-routing.test.js` | `server/plugins/remote-agents/tests/remote-routing.test.js` |
| `server/tests/remote/integration.test.js` | `server/plugins/remote-agents/tests/remote-integration.test.js` |

---

## Task 1: Create TestRunnerRegistry (core service)

**Files:**
- Create: `server/test-runner-registry.js`
- Test: `server/tests/test-runner-registry.test.js`

This is the seam between core and plugin. A tiny service that holds two functions: `runVerifyCommand` and `runRemoteOrLocal`. Default implementations run locally. The plugin overrides them.

- [ ] **Step 1: Write the test for the default local-only behavior**

```js
// server/tests/test-runner-registry.test.js
'use strict';

const { describe, it, expect, vi, beforeEach } = require('vitest');

// We'll mock child_process for the local fallback
vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: 'ok',
    stderr: '',
  })),
  spawn: vi.fn(() => {
    const EventEmitter = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = vi.fn();
    child.stderr.setEncoding = vi.fn();
    child.kill = vi.fn();
    // Simulate immediate success
    setTimeout(() => {
      child.emit('close', 0);
    }, 5);
    return child;
  }),
}));

const { createTestRunnerRegistry } = require('../test-runner-registry');

describe('TestRunnerRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = createTestRunnerRegistry();
  });

  it('should have default local-only runVerifyCommand', async () => {
    const result = await registry.runVerifyCommand('echo hello', '/tmp', {});
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('remote', false);
  });

  it('should have default local-only runRemoteOrLocal', async () => {
    const result = await registry.runRemoteOrLocal('echo', ['hello'], '/tmp', {});
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('remote', false);
  });

  it('should allow overriding runVerifyCommand', async () => {
    const custom = vi.fn().mockResolvedValue({
      success: true, output: 'custom', error: '', exitCode: 0, durationMs: 1, remote: true,
    });
    registry.register({ runVerifyCommand: custom });

    const result = await registry.runVerifyCommand('test cmd', '/tmp', {});
    expect(result.remote).toBe(true);
    expect(custom).toHaveBeenCalledWith('test cmd', '/tmp', {});
  });

  it('should allow overriding runRemoteOrLocal', async () => {
    const custom = vi.fn().mockResolvedValue({
      success: true, output: 'custom', error: '', exitCode: 0, durationMs: 1, remote: true,
    });
    registry.register({ runRemoteOrLocal: custom });

    const result = await registry.runRemoteOrLocal('npx', ['vitest'], '/tmp', {});
    expect(result.remote).toBe(true);
    expect(custom).toHaveBeenCalledWith('npx', ['vitest'], '/tmp', {});
  });

  it('should allow unregistering back to local defaults', async () => {
    const custom = vi.fn().mockResolvedValue({
      success: true, output: '', error: '', exitCode: 0, durationMs: 0, remote: true,
    });
    registry.register({ runVerifyCommand: custom });
    registry.unregister();

    const result = await registry.runVerifyCommand('echo test', '/tmp', {});
    expect(result.remote).toBe(false);
  });

  it('should return empty success for blank verify command', async () => {
    const result = await registry.runVerifyCommand('', '/tmp', {});
    expect(result.success).toBe(true);
    expect(result.durationMs).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/test-runner-registry.test.js`
Expected: FAIL — module `../test-runner-registry` not found.

- [ ] **Step 3: Write the implementation**

```js
// server/test-runner-registry.js
'use strict';

const { spawn } = require('child_process');

/**
 * Creates a test runner registry — the seam between core validation modules
 * and the optional remote-agents plugin.
 *
 * Default behavior: run commands locally via spawn (shell mode).
 * When the remote-agents plugin is loaded, it calls register() to override
 * with remote-or-local routing.
 */
function createTestRunnerRegistry() {
  let _overrides = null;

  /**
   * Default local verify-command runner.
   * Executes the command string via the platform shell and returns a result object.
   */
  async function _localRunVerifyCommand(verifyCommand, cwd, options = {}) {
    const command = typeof verifyCommand === 'string' ? verifyCommand.trim() : '';
    if (!command) {
      return { success: true, output: '', error: '', exitCode: 0, durationMs: 0, remote: false };
    }

    const timeout = options.timeout || 300000;
    const startMs = Date.now();

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(command, {
        cwd,
        windowsHide: true,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      const MAX_BUF = 10 * 1024 * 1024;
      child.stdout.on('data', (d) => { if (stdout.length < MAX_BUF) stdout += d; });
      child.stderr.on('data', (d) => { if (stderr.length < MAX_BUF) stderr += d; });

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          success: !timedOut && code === 0,
          output: stdout,
          error: timedOut ? `Verify command timed out after ${Math.round(timeout / 1000)}s` : stderr,
          exitCode: timedOut ? 124 : (code ?? 1),
          durationMs: Date.now() - startMs,
          remote: false,
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          success: false,
          output: stdout,
          error: err.message || 'spawn error',
          exitCode: 1,
          durationMs: Date.now() - startMs,
          remote: false,
          timedOut: false,
        });
      });
    });
  }

  /**
   * Default local command runner using spawnSync.
   */
  function _localRunRemoteOrLocal(command, args, cwd, options = {}) {
    const { spawnSync } = require('child_process');
    const startMs = Date.now();
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: options.timeout || 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: true,
    });

    return Promise.resolve({
      success: result.status === 0,
      output: result.stdout || '',
      error: result.stderr || '',
      exitCode: result.status ?? 1,
      durationMs: Date.now() - startMs,
      remote: false,
    });
  }

  function runVerifyCommand(verifyCommand, cwd, options) {
    if (_overrides && _overrides.runVerifyCommand) {
      return _overrides.runVerifyCommand(verifyCommand, cwd, options);
    }
    return _localRunVerifyCommand(verifyCommand, cwd, options);
  }

  function runRemoteOrLocal(command, args, cwd, options) {
    if (_overrides && _overrides.runRemoteOrLocal) {
      return _overrides.runRemoteOrLocal(command, args, cwd, options);
    }
    return _localRunRemoteOrLocal(command, args, cwd, options);
  }

  function register(overrides) {
    _overrides = overrides;
  }

  function unregister() {
    _overrides = null;
  }

  return { runVerifyCommand, runRemoteOrLocal, register, unregister };
}

module.exports = { createTestRunnerRegistry };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/test-runner-registry.test.js`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/test-runner-registry.js server/tests/test-runner-registry.test.js
git commit -m "feat: add TestRunnerRegistry — core seam for remote-agents plugin extraction"
```

---

## Task 2: Wire TestRunnerRegistry into container and validation modules

**Files:**
- Modify: `server/container.js` (~line 334 area, registerValue block)
- Modify: `server/index.js` (~lines 60, 773-779)
- Modify: `server/validation/post-task.js` (~lines 55, 62-64, 75-95)
- Modify: `server/validation/build-verification.js` (~lines 19, 24-40)
- Modify: `server/validation/auto-verify-retry.js` (~lines 22, 55-70)
- Modify: `server/handlers/automation-handlers.js` (~lines 24, 59-68)
- Test: Run existing validation tests to confirm no regressions.

This task introduces the registry to the existing code **without removing remote-agents yet**. Both paths work — the remote-agents code still exists and the plugin hasn't been created. This is the safe intermediate step.

- [ ] **Step 1: Register TestRunnerRegistry in container.js**

In `server/container.js`, in the `registerValue` block (around line 334-338), add:

```js
const { createTestRunnerRegistry } = require('./test-runner-registry');
_defaultContainer.registerValue('testRunnerRegistry', createTestRunnerRegistry());
```

- [ ] **Step 2: Create the registry in index.js and pass to validation modules**

In `server/index.js`, at the top imports (after line 25), add:

```js
const { createTestRunnerRegistry } = require('./test-runner-registry');
```

At line ~60 (where `let agentRegistry = null;` is), add below it:

```js
let testRunnerRegistry = null;
```

At line ~773-779 (where agentRegistry is created and passed to validation), change to:

```js
  // Initialize test runner registry (core seam — remote-agents plugin overrides this)
  testRunnerRegistry = defaultContainer.get('testRunnerRegistry')
    || createTestRunnerRegistry();

  // Initialize remote agent registry (needs raw better-sqlite3 instance)
  agentRegistry = new RemoteAgentRegistry(db.getDbInstance());

  // Wire remote routing into the test runner registry
  const { createRemoteTestRouter } = require('./remote/remote-test-routing');
  const remoteRouter = createRemoteTestRouter({ agentRegistry, db, logger });
  testRunnerRegistry.register({
    runVerifyCommand: remoteRouter.runVerifyCommand,
    runRemoteOrLocal: remoteRouter.runRemoteOrLocal,
  });

  // Pass testRunnerRegistry to verification modules for test routing
  require('./validation/auto-verify-retry').init({ testRunnerRegistry });
  require('./validation/post-task').init({ testRunnerRegistry });
  require('./validation/build-verification').init({ testRunnerRegistry });
```

Also export testRunnerRegistry at line ~960 and ~1376 area alongside `getAgentRegistry`:

```js
getTestRunnerRegistry: () => testRunnerRegistry,
```

```js
function getTestRunnerRegistry() {
  return testRunnerRegistry;
}
```

Add to module.exports.

- [ ] **Step 3: Update post-task.js to consume testRunnerRegistry**

In `server/validation/post-task.js`:

Remove line 55 (`const { createRemoteTestRouter } = require('../remote/remote-test-routing');`).

Change the module-level variables (lines ~58-64):

```js
let _testRunnerRegistry = null;
```

Remove `_agentRegistry` and `_router`.

Update `init()` (line ~75) — add `testRunnerRegistry` to accepted deps:

```js
if (deps.testRunnerRegistry) _testRunnerRegistry = deps.testRunnerRegistry;
// Keep backward compat: if agentRegistry is passed (legacy), create a local router
if (deps.agentRegistry !== undefined && !deps.testRunnerRegistry) {
  const { createRemoteTestRouter } = require('../remote/remote-test-routing');
  const router = createRemoteTestRouter({ agentRegistry: deps.agentRegistry, db, logger });
  _testRunnerRegistry = { runVerifyCommand: router.runVerifyCommand, runRemoteOrLocal: router.runRemoteOrLocal };
}
```

Update `getRouter()` (line ~87) to return the registry:

```js
function getRouter() {
  if (_testRunnerRegistry) return _testRunnerRegistry;
  // Fallback: local-only
  const { createTestRunnerRegistry } = require('../test-runner-registry');
  _testRunnerRegistry = createTestRunnerRegistry();
  return _testRunnerRegistry;
}
```

All existing calls to `router.runVerifyCommand(...)` continue to work unchanged.

- [ ] **Step 4: Update build-verification.js similarly**

In `server/validation/build-verification.js`:

Remove line 19 (`const { createRemoteTestRouter } = require('../remote/remote-test-routing');`).

Replace `_agentRegistry` and `_router` with `_testRunnerRegistry`:

```js
let _testRunnerRegistry = null;
```

Update `init()`:
```js
if (deps.testRunnerRegistry) _testRunnerRegistry = deps.testRunnerRegistry;
if (deps.agentRegistry !== undefined && !deps.testRunnerRegistry) {
  const { createRemoteTestRouter } = require('../remote/remote-test-routing');
  _testRunnerRegistry = createRemoteTestRouter({ agentRegistry: deps.agentRegistry, db, logger });
}
_router = null; // clear any cached router
```

Update `getRouter()`:
```js
function getRouter() {
  if (_testRunnerRegistry) return _testRunnerRegistry;
  const { createTestRunnerRegistry } = require('../test-runner-registry');
  _testRunnerRegistry = createTestRunnerRegistry();
  return _testRunnerRegistry;
}
```

- [ ] **Step 5: Update auto-verify-retry.js similarly**

In `server/validation/auto-verify-retry.js`:

Remove line 22 (`const { createRemoteTestRouter } = require('../remote/remote-test-routing');`).

Add at module level: `let _testRunnerRegistry = null;`

In the `init()` function (if one exists) or in the function that creates the router, accept `testRunnerRegistry` from deps and use it as the router.

The key call at line ~163 (`router.runVerifyCommand(...)`) stays unchanged — just the source of `router` changes.

- [ ] **Step 6: Update automation-handlers.js**

In `server/handlers/automation-handlers.js`:

Replace line 24 (`const { createRemoteTestRouter } = require('../remote/remote-test-routing');`) with:

```js
function _getTestRunnerRegistry() {
  try {
    const { getTestRunnerRegistry } = require('../index');
    return getTestRunnerRegistry();
  } catch {
    const { createTestRunnerRegistry } = require('../test-runner-registry');
    return createTestRunnerRegistry();
  }
}
```

Replace the router creation at line ~68 to use `_getTestRunnerRegistry()`.

- [ ] **Step 7: Run existing tests to verify no regressions**

Run: `cd server && npx vitest run tests/remote-test-routing.test.js tests/remote-agent-handlers.test.js tests/remote-test-integration.test.js`

Then run the validation module tests:
Run: `cd server && npx vitest run --reporter=verbose 2>&1 | head -100`

Expected: All existing tests pass. The remote routing still works because index.js still creates the RemoteAgentRegistry and registers it.

- [ ] **Step 8: Commit**

```bash
git add server/container.js server/index.js server/validation/post-task.js server/validation/build-verification.js server/validation/auto-verify-retry.js server/handlers/automation-handlers.js
git commit -m "refactor: wire TestRunnerRegistry into validation pipeline — backward compatible"
```

---

## Task 3: Create the remote-agents plugin

**Files:**
- Create: `server/plugins/remote-agents/index.js`
- Create: `server/plugins/remote-agents/tool-defs.js`
- Create: `server/plugins/remote-agents/handlers.js`
- Move: `server/remote/agent-registry.js` → `server/plugins/remote-agents/agent-registry.js`
- Move: `server/remote/agent-client.js` → `server/plugins/remote-agents/agent-client.js`
- Move: `server/remote/agent-server.js` → `server/plugins/remote-agents/agent-server.js`
- Move: `server/remote/remote-test-routing.js` → `server/plugins/remote-agents/remote-test-routing.js`
- Move: `server/api/bootstrap.js` → `server/plugins/remote-agents/bootstrap.js`
- Test: `server/plugins/remote-agents/tests/plugin.test.js`

- [ ] **Step 1: Write the plugin integration test**

```js
// server/plugins/remote-agents/tests/plugin.test.js
'use strict';

const { describe, it, expect, vi, beforeEach } = require('vitest');
const { validatePlugin } = require('../../plugin-contract');

// Mock the logger
vi.mock('../../../logger', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('remote-agents plugin', () => {
  let plugin;

  beforeEach(() => {
    vi.resetModules();
    const { createPlugin } = require('../index');
    plugin = createPlugin();
  });

  it('should satisfy the plugin contract', () => {
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('remote-agents');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should return empty mcpTools before install', () => {
    expect(plugin.mcpTools()).toEqual([]);
  });

  it('should return tools after install with mock container', () => {
    const mockDb = {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    };
    const mockContainer = {
      get: vi.fn((name) => {
        if (name === 'db') return { getDbInstance: () => mockDb };
        if (name === 'testRunnerRegistry') return {
          register: vi.fn(),
          unregister: vi.fn(),
          runVerifyCommand: vi.fn(),
          runRemoteOrLocal: vi.fn(),
        };
        return null;
      }),
    };

    plugin.install(mockContainer);
    const tools = plugin.mcpTools();
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('register_remote_agent');
    expect(toolNames).toContain('list_remote_agents');
    expect(toolNames).toContain('remove_remote_agent');
    expect(toolNames).toContain('check_remote_agent_health');
    expect(toolNames).toContain('get_remote_agent');
    expect(toolNames).toContain('run_remote_command');
  });

  it('should register test runner override on install', () => {
    const registerFn = vi.fn();
    const mockDb = {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    };
    const mockContainer = {
      get: vi.fn((name) => {
        if (name === 'db') return { getDbInstance: () => mockDb };
        if (name === 'testRunnerRegistry') return {
          register: registerFn,
          unregister: vi.fn(),
          runVerifyCommand: vi.fn(),
          runRemoteOrLocal: vi.fn(),
        };
        return null;
      }),
    };

    plugin.install(mockContainer);
    expect(registerFn).toHaveBeenCalledTimes(1);
  });

  it('should unregister test runner on uninstall', () => {
    const unregisterFn = vi.fn();
    const mockDb = {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    };
    const mockContainer = {
      get: vi.fn((name) => {
        if (name === 'db') return { getDbInstance: () => mockDb };
        if (name === 'testRunnerRegistry') return {
          register: vi.fn(),
          unregister: unregisterFn,
          runVerifyCommand: vi.fn(),
          runRemoteOrLocal: vi.fn(),
        };
        return null;
      }),
    };

    plugin.install(mockContainer);
    plugin.uninstall();
    expect(unregisterFn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run plugins/remote-agents/tests/plugin.test.js`
Expected: FAIL — module `../index` not found.

- [ ] **Step 3: Copy source files into plugin directory**

```bash
mkdir -p server/plugins/remote-agents/tests
cp server/remote/agent-registry.js server/plugins/remote-agents/agent-registry.js
cp server/remote/agent-client.js server/plugins/remote-agents/agent-client.js
cp server/remote/agent-server.js server/plugins/remote-agents/agent-server.js
cp server/remote/remote-test-routing.js server/plugins/remote-agents/remote-test-routing.js
cp server/api/bootstrap.js server/plugins/remote-agents/bootstrap.js
```

- [ ] **Step 4: Fix internal require paths in copied files**

In each copied file, update `require('../logger')` to `require('../../logger')`, `require('../workstation/model')` to `require('../../workstation/model')`, etc. The files moved one directory deeper.

Specifically:
- `agent-registry.js`: `require('../logger')` → `require('../../logger')`, `require('./agent-client')` stays the same (same relative directory).
- `agent-client.js`: `require('../logger')` → `require('../../logger')`.
- `remote-test-routing.js`: `require('../workstation/model')` → `require('../../workstation/model')`.
- `agent-server.js`: No TORQUE-internal requires (standalone), no changes needed.
- `bootstrap.js`: Check for any internal requires and update.

- [ ] **Step 5: Create plugin tool-defs.js**

Copy `server/tool-defs/remote-agent-defs.js` into `server/plugins/remote-agents/tool-defs.js`. Add `run_remote_command` and `run_tests` tool defs from `remote-agent-handlers.js` if they aren't already in the defs file. The existing `remote-agent-defs.js` has 5 tools: `register_remote_agent`, `list_remote_agents`, `get_remote_agent`, `remove_remote_agent`, `check_remote_agent_health`. Check `remote-agent-handlers.js` for any additional tool names (like `run_remote_command`) and include those definitions.

- [ ] **Step 6: Create plugin handlers.js**

Move the content of `server/handlers/remote-agent-handlers.js` into `server/plugins/remote-agents/handlers.js`. Update the require paths:
- `require('./error-codes')` → `require('../../handlers/error-codes')`
- `require('../remote/remote-test-routing')` → `require('./remote-test-routing')`
- `require('../db/project-config-core')` → `require('../../db/project-config-core')`
- `require('../logger')` → `require('../../logger')`
- `require('../validation/post-task')` → `require('../../validation/post-task')`
- `require('../index')` → change to accept registry via `createHandlers(deps)` pattern instead

Refactor from using `_getRegistry()` (which calls `require('../index').getAgentRegistry()`) to accepting the registry as a constructor argument:

```js
function createHandlers({ agentRegistry }) {
  // Replace all _getRegistry() calls with agentRegistry
  // ... existing handler functions, using agentRegistry directly ...
  return { handleRegisterRemoteAgent, handleListRemoteAgents, /* ... all handlers */ };
}
module.exports = { createHandlers };
```

- [ ] **Step 7: Create plugin index.js**

```js
// server/plugins/remote-agents/index.js
'use strict';

const allToolDefs = require('./tool-defs');
const { createHandlers } = require('./handlers');
const { RemoteAgentRegistry } = require('./agent-registry');
const { createRemoteTestRouter } = require('./remote-test-routing');

const PLUGIN_NAME = 'remote-agents';
const PLUGIN_VERSION = '1.0.0';

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') return null;
  try { return container.get(name); } catch { return null; }
}

function resolveRawDb(dbService) {
  const rawDb = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('remote-agents plugin requires db service with prepare()');
  }
  return rawDb;
}

function createPlugin() {
  let db = null;
  let agentRegistry = null;
  let testRunnerRegistry = null;
  let handlers = null;
  let healthCheckTimer = null;
  let installed = false;

  function install(container) {
    let dbService = getContainerService(container, 'db');
    if (!dbService) {
      try { dbService = require('../../database'); } catch { /* not available */ }
    }
    db = resolveRawDb(dbService);

    // Create agent registry
    agentRegistry = new RemoteAgentRegistry(db);

    // Get the test runner registry from container and register our remote router
    testRunnerRegistry = getContainerService(container, 'testRunnerRegistry');
    if (testRunnerRegistry) {
      const logger = require('../../logger').child({ component: 'remote-agents-plugin' });
      const router = createRemoteTestRouter({ agentRegistry, db: dbService, logger });
      testRunnerRegistry.register({
        runVerifyCommand: router.runVerifyCommand,
        runRemoteOrLocal: router.runRemoteOrLocal,
      });
    }

    // Create handlers with the agent registry
    handlers = createHandlers({ agentRegistry, db });

    // Start periodic health checks (every 60s)
    healthCheckTimer = setInterval(() => {
      agentRegistry.runHealthChecks().catch(() => {});
    }, 60000);

    installed = true;
  }

  function uninstall() {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }
    if (testRunnerRegistry) {
      testRunnerRegistry.unregister();
    }
    db = null;
    agentRegistry = null;
    testRunnerRegistry = null;
    handlers = null;
    installed = false;
  }

  function mcpTools() {
    if (!installed || !handlers) return [];
    return allToolDefs.map((toolDef) => ({
      ...toolDef,
      handler: handlers[toolDef.name],
    }));
  }

  function middleware() {
    // Could register /api/agents/* REST routes here in the future.
    // For now, the REST routes will be removed from core and the plugin
    // only exposes tools via MCP.
    return [];
  }

  function eventHandlers() {
    return {};
  }

  function configSchema() {
    return { type: 'object', properties: {} };
  }

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install,
    uninstall,
    mcpTools,
    middleware,
    eventHandlers,
    configSchema,
    // Expose for external access (e.g., maintenance scheduler, REST handlers)
    getAgentRegistry: () => agentRegistry,
  };
}

module.exports = { createPlugin };
module.exports.createPlugin = createPlugin;
```

- [ ] **Step 8: Run plugin test to verify it passes**

Run: `cd server && npx vitest run plugins/remote-agents/tests/plugin.test.js`
Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add server/plugins/remote-agents/
git commit -m "feat: create remote-agents plugin with tool-defs, handlers, and registry"
```

---

## Task 4: Remove remote-agents from core

**Files:**
- Modify: `server/index.js` — remove RemoteAgentRegistry import, agentRegistry creation, manual validation wiring. Add `'remote-agents'` to `DEFAULT_PLUGIN_NAMES`.
- Modify: `server/tools.js` — remove `remote-agent-defs` and `remote-agent-handlers` entries.
- Modify: `server/api/routes.js` — remove `/api/agents/*` route entries.
- Modify: `server/api/v2-core-handlers.js` — remove `remoteAgentHandlers` import and handlers.
- Modify: `server/api/v2-dispatch.js` — remove `remoteAgentHandlers` import and dispatch entries.
- Modify: `server/api/v2-infrastructure-handlers.js` — remove `_listAgents`, `_getAgent`, remote-agent related functions.
- Modify: `server/maintenance/scheduler.js` — remove `getAgentRegistry` dependency and remote agent health check block.
- Delete: `server/remote/agent-registry.js`
- Delete: `server/remote/agent-client.js`
- Delete: `server/remote/agent-server.js`
- Delete: `server/remote/remote-test-routing.js`
- Delete: `server/handlers/remote-agent-handlers.js`
- Delete: `server/tool-defs/remote-agent-defs.js`
- Delete: `server/api/bootstrap.js`

- [ ] **Step 1: Add `remote-agents` to DEFAULT_PLUGIN_NAMES in index.js**

In `server/index.js` line 56, change:

```js
const DEFAULT_PLUGIN_NAMES = Object.freeze(['snapscope', 'version-control']);
```

to:

```js
const DEFAULT_PLUGIN_NAMES = Object.freeze(['snapscope', 'version-control', 'remote-agents']);
```

- [ ] **Step 2: Remove RemoteAgentRegistry from index.js**

Remove line 36: `const { RemoteAgentRegistry } = require('./remote/agent-registry');`

Remove line 60: `let agentRegistry = null;`

Remove lines ~773-779 (the agentRegistry creation and validation init with agentRegistry). The plugin now handles this in its `install()`.

Keep the `testRunnerRegistry` creation and the validation `.init({ testRunnerRegistry })` calls — these are now the only thing index.js does for test routing.

Remove the `getAgentRegistry` export and function (lines ~960, ~1373-1376). Any code that was calling `getAgentRegistry()` should now go through the plugin.

- [ ] **Step 3: Remove remote-agent entries from tools.js**

In `server/tools.js`, remove:
- Line ~43: `...require('./tool-defs/remote-agent-defs'),`
- Line ~125: `require('./handlers/remote-agent-handlers'),`

- [ ] **Step 4: Remove /api/agents routes from api/routes.js**

In `server/api/routes.js`, remove lines ~1193-1198:
```js
  // Remote Agents
  { method: 'POST', path: '/api/agents', tool: 'register_remote_agent', mapBody: true },
  { method: 'GET', path: '/api/agents', tool: 'list_remote_agents' },
  { method: 'DELETE', path: /^\/api\/agents\/([^/]+)$/, tool: 'remove_remote_agent', mapParams: ['agent_id'] },
  { method: 'GET', path: /^\/api\/agents\/([^/]+)\/health$/, tool: 'check_remote_agent_health', mapParams: ['agent_id'] },
  { method: 'GET', path: /^\/api\/agents\/([^/]+)$/, tool: 'get_remote_agent', mapParams: ['agent_id'] },
```

- [ ] **Step 5: Remove remoteAgentHandlers from v2-core-handlers.js**

Remove line 17: `const remoteAgentHandlers = require('../handlers/remote-agent-handlers');`

Remove the `runRemoteCommandCore` and `runTestsCore` handler functions that reference it (around lines ~1076-1097). Replace with stubs that return 404/not-available if the plugin isn't loaded, or remove the v2 route entries entirely (next step).

- [ ] **Step 6: Remove remoteAgentHandlers from v2-dispatch.js**

Remove line 25: `const remoteAgentHandlers = require('../handlers/remote-agent-handlers');`

Remove lines ~352-353:
```js
  handleV2CpRunRemoteCommand: remoteAgentHandlers.handleRunRemoteCommand,
  handleV2CpRunTests: remoteAgentHandlers.handleRunTests,
```

- [ ] **Step 7: Remove remote-agent functions from v2-infrastructure-handlers.js**

Remove `_listAgents`, `_getAgent`, `_healthCheckAgent` functions and associated raw SQL queries that reference `remote_agents` table. The plugin manages its own data access.

- [ ] **Step 8: Remove getAgentRegistry from maintenance/scheduler.js**

In `server/maintenance/scheduler.js`, remove the `getAgentRegistry` parameter from `init()` and remove the health check block (~lines 112-117):

```js
      // Run remote agent health checks
      const agentRegistry = getAgentRegistry();
      if (agentRegistry) {
        agentRegistry.runHealthChecks().catch(err => {
          debugLog(`Remote agent health check error: ${err.message}`);
        });
      }
```

The plugin runs its own health check timer now.

- [ ] **Step 9: Remove the maintenance scheduler's getAgentRegistry from index.js init call**

In `server/index.js`, the `maintenanceScheduler.init()` call (~line 954) passes `getAgentRegistry`. Remove that property from the options object.

- [ ] **Step 10: Delete old remote files**

```bash
rm server/remote/agent-registry.js
rm server/remote/agent-client.js
rm server/remote/agent-server.js
rm server/remote/remote-test-routing.js
rm server/handlers/remote-agent-handlers.js
rm server/tool-defs/remote-agent-defs.js
rm server/api/bootstrap.js
```

Check if `server/remote/` is now empty. If so, remove the directory:
```bash
rmdir server/remote/ 2>/dev/null || true
```

- [ ] **Step 11: Run the full test suite to check for broken imports**

Run: `cd server && npx vitest run --reporter=verbose 2>&1 | tail -30`

Fix any broken `require()` paths. Common issues:
- Tests that import from `../remote/...` need to be redirected to the plugin path or moved (Task 5).
- Tests that mock `../remote/remote-test-routing` in validation tests need the mock path updated to `../test-runner-registry`.

- [ ] **Step 12: Commit**

```bash
git add -A server/
git commit -m "refactor: extract remote-agents into plugin, remove from core

Remote agent federation (registry, client, server, handlers, test routing,
bootstrap) now lives in plugins/remote-agents/. Core validation modules
use TestRunnerRegistry interface — local-only by default, overridden when
plugin is loaded."
```

---

## Task 5: Move and fix test files

**Files:**
- Move: All test files listed in the "Test files to move" table above.
- Modify: Update `require()` paths in each moved test.
- Modify: Any remaining tests in `server/tests/` that mock `remote-test-routing` — update to mock `test-runner-registry` instead.

- [ ] **Step 1: Move test files to plugin**

```bash
# Copy tests into plugin
cp server/tests/remote-agent-handlers.test.js server/plugins/remote-agents/tests/handlers.test.js
cp server/tests/remote-agent-server.test.js server/plugins/remote-agents/tests/agent-server.test.js
cp server/tests/remote-command-rest.test.js server/plugins/remote-agents/tests/command-rest.test.js
cp server/tests/remote-command-tools.test.js server/plugins/remote-agents/tests/command-tools.test.js
cp server/tests/remote-test-integration.test.js server/plugins/remote-agents/tests/integration.test.js
cp server/tests/remote-test-routing-env.test.js server/plugins/remote-agents/tests/routing-env.test.js
cp server/tests/remote-test-routing.test.js server/plugins/remote-agents/tests/routing.test.js
cp server/tests/agent-client-tls.test.js server/plugins/remote-agents/tests/agent-client-tls.test.js
cp server/tests/agent-registry-security.test.js server/plugins/remote-agents/tests/agent-registry-security.test.js
cp server/tests/remote/agent-client.test.js server/plugins/remote-agents/tests/agent-client.test.js
cp server/tests/remote/agent-registry.test.js server/plugins/remote-agents/tests/agent-registry.test.js
cp server/tests/remote/remote-agent-handlers.test.js server/plugins/remote-agents/tests/remote-agent-handlers.test.js
cp server/tests/remote/remote-routing.test.js server/plugins/remote-agents/tests/remote-routing.test.js
cp server/tests/remote/integration.test.js server/plugins/remote-agents/tests/remote-integration.test.js
```

- [ ] **Step 2: Update require paths in each moved test file**

Each test file will need path updates. The pattern is:
- `require('../remote/agent-registry')` → `require('../agent-registry')`
- `require('../remote/agent-client')` → `require('../agent-client')`
- `require('../remote/remote-test-routing')` → `require('../remote-test-routing')`
- `require('../handlers/remote-agent-handlers')` → `require('../handlers')`
- `require('../index')` → `require('../../../index')`
- `require('../logger')` → `require('../../../logger')`
- etc.

Go file by file. Read the imports, update the relative paths.

- [ ] **Step 3: Delete old test files from server/tests/**

```bash
rm server/tests/remote-agent-handlers.test.js
rm server/tests/remote-agent-server.test.js
rm server/tests/remote-command-rest.test.js
rm server/tests/remote-command-tools.test.js
rm server/tests/remote-test-integration.test.js
rm server/tests/remote-test-routing-env.test.js
rm server/tests/remote-test-routing.test.js
rm server/tests/agent-client-tls.test.js
rm server/tests/agent-registry-security.test.js
rm -rf server/tests/remote/
```

- [ ] **Step 4: Update validation tests that mock remote-test-routing**

Search `server/tests/` for any test that mocks `../remote/remote-test-routing`. These tests need to mock `../test-runner-registry` instead, or inject a mock `testRunnerRegistry` via the module's `init()`.

Run: `grep -r "remote-test-routing\|remote/remote" server/tests/ --include="*.test.js" -l`

For each hit, update the mock to target the new path.

- [ ] **Step 5: Run the full test suite**

Run: `cd server && npx vitest run 2>&1 | tail -30`

Expected: All tests pass. Fix any remaining broken imports.

- [ ] **Step 6: Run the plugin tests specifically**

Run: `cd server && npx vitest run plugins/remote-agents/tests/ --reporter=verbose`

Expected: All plugin tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A server/tests/ server/plugins/remote-agents/tests/
git commit -m "test: move remote-agent tests into plugin, update mock paths"
```

---

## Task 6: Update CLAUDE.md and verify end-to-end

**Files:**
- Modify: `CLAUDE.md` — update Remote Agents section to note it's a plugin.
- Modify: `server/plugins/remote-agents/index.js` — if any issues found during E2E.
- Test: Manual startup + tool list verification.

- [ ] **Step 1: Update CLAUDE.md**

In the Providers section, add a note that remote agent federation is now a plugin:

```markdown
### Remote Agent Federation (Plugin)

Remote agent registration, health checks, and distributed test routing are provided
by the `remote-agents` plugin (loaded by default). To disable, remove `'remote-agents'`
from `DEFAULT_PLUGIN_NAMES` in `server/index.js`.
```

- [ ] **Step 2: Start the server and verify tools are registered**

Start TORQUE and verify the remote-agent MCP tools appear:

Run: `curl -s http://127.0.0.1:3457/api/health | head -5`
Run: `curl -s http://127.0.0.1:3457/api/tools | grep -c remote`

Expected: Health check returns OK. Remote agent tools are present (registered via plugin).

- [ ] **Step 3: Verify the plugin loaded**

Check server logs for: `[plugin-loader] Loaded plugin: remote-agents v1.0.0`

- [ ] **Step 4: Verify test routing still works**

Submit a task with a verify_command and confirm verification runs (locally or remotely depending on workstation config).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md to reflect remote-agents plugin extraction"
```

---

## Summary

| Task | What | Commits |
|------|------|---------|
| 1 | Create `TestRunnerRegistry` (core seam) | 1 |
| 2 | Wire registry into validation modules (backward compatible) | 1 |
| 3 | Create `plugins/remote-agents/` with all moved code | 1 |
| 4 | Remove remote-agents from core, enable plugin by default | 1 |
| 5 | Move and fix test files | 1 |
| 6 | Update docs and E2E verify | 1 |

**Net effect:** ~2,760 lines of source + ~3,500 lines of tests moved out of core into a self-contained plugin. Core gains ~120 lines (`test-runner-registry.js`). The plugin loads by default so existing behavior is unchanged.
