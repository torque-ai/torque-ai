# OSS Phase 1: Container Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the DI container that will serve as the composition root for the entire TORQUE codebase. This is the foundation that all subsequent migration phases depend on.

**Architecture:** Expand the existing `container.js` (currently 90 lines, wires 3 modules) into a full service container with `boot()`, `get()`, `freeze()`, and `resetForTest()`. Uses topological sort for dependency resolution. Initially wraps existing singletons — no module refactoring in this phase.

**Tech Stack:** Node.js, Vitest, better-sqlite3

**Spec:** `docs/superpowers/specs/2026-03-21-oss-architecture-design.md` — Phase 1 section

**Depends on:** Phase 0 (credibility cleanup) — should be completed first

**Tests:** Run via `torque-remote npx vitest run` (routes to remote workstation). For targeted runs: `torque-remote npx vitest run server/tests/<file>`.

---

### Task 1: Write the container module with topological sort

Build the new container from scratch. The existing `container.js` (90 lines) will be replaced entirely.

**Files:**
- Create: `server/container.js` (rewrite)
- Create: `server/tests/container.test.js`

- [ ] **Step 1: Write failing tests for the container API**

```js
// server/tests/container.test.js
'use strict';
import { describe, it, expect, beforeEach } from 'vitest';

const { createContainer } = require('../container');

describe('container', () => {
  let container;

  beforeEach(() => {
    container = createContainer();
  });

  describe('register + get', () => {
    it('registers and retrieves a service', () => {
      container.register('logger', [], () => ({ info: () => {} }));
      container.boot();
      expect(container.get('logger')).toBeDefined();
      expect(container.get('logger').info).toBeInstanceOf(Function);
    });

    it('throws on get before boot', () => {
      container.register('logger', [], () => ({ info: () => {} }));
      expect(() => container.get('logger')).toThrow(/boot/i);
    });

    it('throws on get for unknown service', () => {
      container.boot();
      expect(() => container.get('nonexistent')).toThrow(/not registered/i);
    });
  });

  describe('dependency injection', () => {
    it('injects dependencies into factory', () => {
      container.register('config', [], () => ({ port: 3000 }));
      container.register('server', ['config'], ({ config }) => ({
        port: config.port,
        start: () => {},
      }));
      container.boot();
      expect(container.get('server').port).toBe(3000);
    });

    it('resolves transitive dependencies', () => {
      container.register('a', [], () => ({ name: 'a' }));
      container.register('b', ['a'], ({ a }) => ({ name: 'b', a }));
      container.register('c', ['b'], ({ b }) => ({ name: 'c', b }));
      container.boot();
      const c = container.get('c');
      expect(c.b.a.name).toBe('a');
    });
  });

  describe('topological sort', () => {
    it('detects circular dependencies', () => {
      container.register('a', ['b'], ({ b }) => ({}));
      container.register('b', ['a'], ({ a }) => ({}));
      expect(() => container.boot()).toThrow(/circular/i);
    });

    it('detects missing dependencies', () => {
      container.register('a', ['missing'], ({ missing }) => ({}));
      expect(() => container.boot()).toThrow(/missing/i);
    });

    it('boots services in dependency order', () => {
      const order = [];
      container.register('c', ['b'], () => { order.push('c'); return {}; });
      container.register('a', [], () => { order.push('a'); return {}; });
      container.register('b', ['a'], () => { order.push('b'); return {}; });
      container.boot();
      expect(order).toEqual(['a', 'b', 'c']);
    });
  });

  describe('freeze', () => {
    it('prevents registration after boot', () => {
      container.boot();
      expect(() => container.register('late', [], () => ({}))).toThrow(/frozen|boot/i);
    });
  });

  describe('resetForTest', () => {
    it('resets the container to a fresh state', () => {
      container.register('svc', [], () => ({ id: Math.random() }));
      container.boot();
      const id1 = container.get('svc').id;
      container.resetForTest();
      // After reset, the same factories are re-run
      container.boot();
      const id2 = container.get('svc').id;
      expect(id2).not.toBe(id1);
    });
  });

  describe('registerValue', () => {
    it('registers a pre-built value (no factory)', () => {
      container.registerValue('eventBus', { emit: () => {} });
      container.boot();
      expect(container.get('eventBus').emit).toBeInstanceOf(Function);
    });
  });

  describe('has', () => {
    it('returns true for registered services', () => {
      container.register('svc', [], () => ({}));
      expect(container.has('svc')).toBe(true);
    });

    it('returns false for unregistered services', () => {
      expect(container.has('nope')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns all registered service names', () => {
      container.register('a', [], () => ({}));
      container.register('b', ['a'], () => ({}));
      container.boot();
      expect(container.list().sort()).toEqual(['a', 'b']);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `torque-remote npx vitest run server/tests/container.test.js`
Expected: FAIL — `createContainer` is not exported from current `container.js`

- [ ] **Step 3: Implement the container**

```js
// server/container.js
'use strict';

/**
 * server/container.js — DI container and composition root for TORQUE.
 *
 * Every module registers as a factory with declared dependencies.
 * boot() resolves the dependency graph via topological sort and
 * instantiates all services in the correct order.
 *
 * API:
 *   createContainer()   → new container instance
 *   .register(name, deps, factory)  — register a factory
 *   .registerValue(name, value)     — register a pre-built value
 *   .boot()             — resolve deps, run factories, freeze
 *   .get(name)          — retrieve an instantiated service
 *   .has(name)          — check if a service is registered
 *   .list()             — list all registered service names
 *   .resetForTest()     — reset to pre-boot state (keeps registrations)
 *   .freeze()           — prevent further registrations (called by boot)
 */

const logger = require('./logger').child({ component: 'container' });

/**
 * Topological sort using Kahn's algorithm.
 * Returns service names in dependency-first order.
 * Throws on circular deps or missing deps.
 *
 * @param {Map<string, string[]>} graph - Map of service name → dependency names
 * @returns {string[]} Sorted service names
 */
function topoSort(graph) {
  // Validate all deps exist
  for (const [name, deps] of graph) {
    for (const dep of deps) {
      if (!graph.has(dep)) {
        throw new Error(
          `Container: service '${name}' depends on '${dep}' which is not registered`
        );
      }
    }
  }

  // In-degree = number of unresolved dependencies each node has.
  // "A depends on B" means B must come before A, so A's in-degree = A's dep count.
  const inDeg = new Map();
  for (const name of graph.keys()) {
    inDeg.set(name, 0);
  }
  for (const [name, deps] of graph) {
    inDeg.set(name, deps.length);
  }

  // Queue starts with nodes that have no dependencies
  const queue = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }

  // Build reverse adjacency: for each dep, which services depend on it?
  const dependents = new Map();
  for (const name of graph.keys()) {
    dependents.set(name, []);
  }
  for (const [name, deps] of graph) {
    for (const dep of deps) {
      dependents.get(dep).push(name);
    }
  }

  const sorted = [];
  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);
    for (const dependent of dependents.get(current)) {
      const newDeg = inDeg.get(dependent) - 1;
      inDeg.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== graph.size) {
    const remaining = [...graph.keys()].filter(n => !sorted.includes(n));
    throw new Error(
      `Container: circular dependency detected among: ${remaining.join(', ')}`
    );
  }

  return sorted;
}

/**
 * Create a new DI container.
 * @returns {object} Container instance
 */
function createContainer() {
  /** @type {Map<string, { deps: string[], factory: Function|null, value: any }>} */
  const _registry = new Map();

  /** @type {Map<string, any>} */
  const _instances = new Map();

  let _booted = false;

  function register(name, deps, factory) {
    if (_booted) {
      throw new Error(`Container is frozen after boot() — cannot register '${name}'`);
    }
    if (_registry.has(name)) {
      logger.warn(`Container: overwriting registration for '${name}'`);
    }
    _registry.set(name, { deps, factory, value: undefined });
  }

  function registerValue(name, value) {
    if (_booted) {
      throw new Error(`Container is frozen after boot() — cannot register '${name}'`);
    }
    _registry.set(name, { deps: [], factory: null, value });
  }

  function boot() {
    if (_booted) {
      logger.warn('Container: boot() called multiple times — skipping');
      return;
    }

    // Build dependency graph (only factory-based entries need sorting)
    const graph = new Map();
    for (const [name, entry] of _registry) {
      graph.set(name, entry.deps);
    }

    // Topological sort — throws on circular or missing deps
    const order = topoSort(graph);

    // Instantiate in order
    for (const name of order) {
      const entry = _registry.get(name);
      if (entry.factory) {
        // Build deps object
        const deps = {};
        for (const depName of entry.deps) {
          deps[depName] = _instances.get(depName);
        }
        try {
          _instances.set(name, entry.factory(deps));
        } catch (err) {
          const depNames = entry.deps.join(', ') || 'none';
          logger.error(`Container: factory for '${name}' threw (deps: ${depNames}): ${err.message}`);
          throw err;
        }
      } else {
        // Pre-built value
        _instances.set(name, entry.value);
      }
    }

    _booted = true;
    logger.info(`Container: booted ${_instances.size} services`);
  }

  function get(name) {
    if (!_booted) {
      throw new Error(
        `Container: get('${name}') called before boot() — ` +
        `ensure container.boot() is called during startup`
      );
    }
    if (!_instances.has(name)) {
      throw new Error(`Container: service '${name}' is not registered`);
    }
    return _instances.get(name);
  }

  function has(name) {
    return _registry.has(name);
  }

  function list() {
    return [..._instances.keys()];
  }

  function freeze() {
    if (!_booted) {
      throw new Error('Container: cannot freeze before boot() — call boot() first');
    }
    // boot() already sets _booted = true, so freeze() is a no-op after boot.
    // It exists as an explicit API for callers that want to signal intent.
  }

  function resetForTest() {
    _instances.clear();
    _booted = false;
  }

  return { register, registerValue, boot, get, has, list, freeze, resetForTest };
}

// ── Legacy compatibility ────────────────────────────────────────────────────
// The old container.js exported { initModules, getModule }.
// During migration, callers that still use initModules/getModule work through
// a default container instance.

const _defaultContainer = createContainer();

/**
 * Legacy: Initialize core infrastructure modules.
 * Wraps old initModules(db, serverConfig) behavior using the new container.
 */
function initModules(db, serverConfig) {
  // Register as pre-built values (these are already-initialized singletons)
  if (!_defaultContainer.has('db')) {
    _defaultContainer.registerValue('db', db);
  }
  if (!_defaultContainer.has('serverConfig')) {
    _defaultContainer.registerValue('serverConfig', serverConfig);
  }

  // Wire config (existing behavior)
  serverConfig.init({ db });
  logger.info('Container: config.js wired via init(deps)');

  // Provider config and registry
  const providerCfg = require('./providers/config');
  providerCfg.init({ db });
  if (!_defaultContainer.has('providerCfg')) {
    _defaultContainer.registerValue('providerCfg', providerCfg);
  }

  const providerRegistry = require('./providers/registry');
  providerRegistry.init({ db });
  if (!_defaultContainer.has('providerRegistry')) {
    _defaultContainer.registerValue('providerRegistry', providerRegistry);
  }

  // MCP protocol
  const mcpProtocol = require('./mcp-protocol');
  if (!_defaultContainer.has('mcpProtocol')) {
    _defaultContainer.registerValue('mcpProtocol', mcpProtocol);
  }

  logger.info('Container: core modules initialized (legacy path)');
}

/**
 * Legacy: Retrieve a module registered during initModules().
 */
function getModule(name) {
  try {
    return _defaultContainer.get(name);
  } catch {
    return undefined;
  }
}

module.exports = {
  // New API
  createContainer,
  // Legacy compatibility
  initModules,
  getModule,
  // Default instance (used by index.js during incremental migration)
  defaultContainer: _defaultContainer,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `torque-remote npx vitest run server/tests/container.test.js`
Expected: All tests pass

- [ ] **Step 5: Run the full test suite to verify no regressions**

Run: `torque-remote npx vitest run`
Expected: All existing tests pass — the legacy `initModules`/`getModule` API is preserved.

- [ ] **Step 6: Commit**

```bash
git add server/container.js server/tests/container.test.js
git commit -m "feat: implement DI container with topological sort and legacy compat"
```

---

### Task 2: Convert event-bus to factory pattern

`event-bus.js` is currently a singleton module. Convert it to a factory so it can be registered in the container. Keep backward compat by exporting a default instance.

**Files:**
- Modify: `server/event-bus.js`
- Create: `server/tests/event-bus.test.js`

- [ ] **Step 1: Write failing test for the factory**

```js
// server/tests/event-bus.test.js
'use strict';
import { describe, it, expect, vi } from 'vitest';

const { createEventBus } = require('../event-bus');

describe('createEventBus', () => {
  it('creates independent event bus instances', () => {
    const bus1 = createEventBus();
    const bus2 = createEventBus();

    const fn1 = vi.fn();
    const fn2 = vi.fn();

    bus1.onQueueChanged(fn1);
    bus2.onQueueChanged(fn2);

    bus1.emitQueueChanged();

    expect(fn1).toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('supports all event types', () => {
    const bus = createEventBus();
    const events = [
      ['onQueueChanged', 'emitQueueChanged', undefined],
      ['onShutdown', 'emitShutdown', 'test-reason'],
      ['onTaskUpdated', 'emitTaskUpdated', { id: '1' }],
      ['onTaskEvent', 'emitTaskEvent', { type: 'cancel' }],
      ['onModelDiscovered', 'emitModelDiscovered', { model: 'test' }],
      ['onModelRemoved', 'emitModelRemoved', { model: 'test' }],
    ];

    for (const [onMethod, emitMethod, data] of events) {
      const fn = vi.fn();
      bus[onMethod](fn);
      bus[emitMethod](data);
      expect(fn).toHaveBeenCalled();
    }
  });

  it('has removeAllListeners', () => {
    const bus = createEventBus();
    const fn = vi.fn();
    bus.onTaskUpdated(fn);
    bus.removeAllListeners();
    bus.emitTaskUpdated({});
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/event-bus.test.js`
Expected: FAIL — `createEventBus` is not exported

- [ ] **Step 3: Add factory export to event-bus.js**

Modify `server/event-bus.js` — wrap the existing code in a factory function and export both the factory and the default singleton:

```js
'use strict';
const { EventEmitter } = require('events');

/**
 * Create a new event bus instance.
 * @returns {object} Event bus with typed on/emit methods
 */
function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    onQueueChanged: (fn) => emitter.on('queue-changed', fn),
    emitQueueChanged: () => {
      emitter.emit('queue-changed');
      process.emit('torque:queue-changed');
    },
    onShutdown: (fn) => emitter.on('shutdown', fn),
    emitShutdown: (reason) => emitter.emit('shutdown', reason),
    onTaskUpdated: (fn) => emitter.on('task-updated', fn),
    emitTaskUpdated: (data) => emitter.emit('task-updated', data),
    onTaskEvent: (fn) => emitter.on('task-event', fn),
    emitTaskEvent: (data) => emitter.emit('task-event', data),
    onModelDiscovered: (fn) => emitter.on('model-discovered', fn),
    emitModelDiscovered: (data) => emitter.emit('model-discovered', data),
    onModelRemoved: (fn) => emitter.on('model-removed', fn),
    emitModelRemoved: (data) => emitter.emit('model-removed', data),
    listeners: (event) => emitter.listeners(event),
    removeListener: (event, fn) => emitter.removeListener(event, fn),
    removeAllListeners: () => emitter.removeAllListeners(),
  };
}

// Default singleton — existing code that does require('./event-bus') gets this
const defaultBus = createEventBus();

module.exports = {
  ...defaultBus,
  createEventBus,
};
```

- [ ] **Step 4: Run the event-bus test**

Run: `torque-remote npx vitest run server/tests/event-bus.test.js`
Expected: All pass

- [ ] **Step 5: Run full test suite to confirm no regressions**

Run: `torque-remote npx vitest run`
Expected: All existing tests pass — the default singleton is preserved via spread.

- [ ] **Step 6: Commit**

```bash
git add server/event-bus.js server/tests/event-bus.test.js
git commit -m "feat: add createEventBus factory alongside default singleton"
```

---

### Task 3: Add no-direct-database-import lint rule

Add a grep-based check that warns when migrated modules import `database.js` directly. This will be enforced in CI and used during development to catch regressions.

**Files:**
- Create: `server/scripts/check-no-direct-db-import.js`
- Modify: `server/package.json` (add script)

- [ ] **Step 1: Write the lint script**

```js
// server/scripts/check-no-direct-db-import.js
'use strict';

/**
 * CI lint rule: detect files that import database.js directly
 * when they should use the DI container.
 *
 * Usage: node scripts/check-no-direct-db-import.js [--strict]
 *
 * In non-strict mode (default during migration), prints warnings.
 * In strict mode (after Phase 5 cutover), exits with code 1 on violations.
 *
 * Files are excluded via a whitelist of known-unmigrated modules.
 */

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..');

// Files that are ALLOWED to import database.js (shrinks as migration progresses)
// After Phase 5, this list should be empty and --strict should be the default.
const ALLOWED = new Set([
  // Core — will be migrated last
  'database.js',
  'container.js',
  'index.js',
  // Legacy consumers — migrated in Phase 2-4
  'config.js',
  'discovery.js',
  'tools.js',
  'dashboard-server.js',
  'api-server.core.js',
  'mcp-sse.js',
  'task-manager.js',
]);

const DB_IMPORT_PATTERN = /require\s*\(\s*['"]\..*database['"]\s*\)/;

function scan() {
  const violations = [];
  const warnings = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.tmp' || entry.name === '.cache') continue;
      if (entry.name === 'tests') continue; // Tests are exempt until Phase 5

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.name.endsWith('.js')) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      if (!DB_IMPORT_PATTERN.test(content)) continue;

      const relativePath = path.relative(SERVER_DIR, fullPath).replace(/\\/g, '/');
      const baseName = path.basename(fullPath);

      if (ALLOWED.has(baseName) || ALLOWED.has(relativePath)) {
        // Known unmigrated — track but don't warn
        continue;
      }

      violations.push(relativePath);
    }
  }

  walk(SERVER_DIR);
  return violations;
}

const strict = process.argv.includes('--strict');
const violations = scan();

if (violations.length > 0) {
  console.log(`\n⚠ ${violations.length} file(s) import database.js directly:\n`);
  for (const v of violations) {
    console.log(`  ${v}`);
  }
  console.log('\nThese should use the DI container instead.\n');

  if (strict) {
    process.exit(1);
  }
} else {
  console.log('✓ No unauthorized direct database imports found.');
}
```

- [ ] **Step 2: Add npm script**

Add to `server/package.json` scripts:

```json
"lint:di": "node scripts/check-no-direct-db-import.js"
```

- [ ] **Step 3: Run the lint script to establish baseline**

Run: `cd server && node scripts/check-no-direct-db-import.js`
Expected: Reports violations (all the non-whitelisted files that currently import database.js). This is expected — they'll be migrated in Phase 2-4.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/check-no-direct-db-import.js server/package.json
git commit -m "feat: add DI migration lint rule for direct database imports"
```

---

### Task 4: Wire container into index.js startup

Connect the new container to the existing startup flow. The container wraps existing singletons initially — no behavior changes.

**Files:**
- Modify: `server/index.js:20,39,47+`

- [ ] **Step 1: Add container import to index.js**

At the top of `server/index.js`, add the container import alongside the existing requires:

```js
// After line 19 (const db = require('./database');)
// Add:
const { defaultContainer } = require('./container');
```

- [ ] **Step 2: Register core singletons in init()**

Inside the `init()` function (line 512), after `db.init()` (line 537), register the already-initialized singletons with the container:

```js
// After db.init() and before taskManager.initEarlyDeps():
// Register core singletons so container.get() works for future migrated modules
if (!defaultContainer.has('db')) {
  defaultContainer.registerValue('db', db);
  defaultContainer.registerValue('eventBus', eventBus);
  defaultContainer.registerValue('logger', logger);
  defaultContainer.registerValue('serverConfig', serverConfig);
  defaultContainer.registerValue('taskManager', taskManager);
  defaultContainer.registerValue('dashboard', dashboard);
}
```

- [ ] **Step 3: Boot the container after all singletons are registered**

After the existing initialization code (after `taskManager.initSubModules()`, around line 586), boot the container:

```js
// Boot the container — makes registered services available via container.get()
// During migration, this is additive — existing require() patterns still work.
// boot() is internally idempotent — safe to call multiple times.
try {
  defaultContainer.boot();
} catch (err) {
  logger.error(`Container boot failed: ${err.message}`);
  // Non-fatal during migration — existing require() paths still work
}
```

- [ ] **Step 4: Run the full test suite**

Run: `torque-remote npx vitest run`
Expected: All tests pass — the container wraps existing singletons without changing behavior.

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat: wire DI container into server startup (wraps existing singletons)"
```

---

### Task 5: Remove stale Phase 3 migration comments

Now that the container is in place and the migration is actually happening, remove the aspirational comments that reference a future "Phase 3" migration.

**Files:**
- Modify: `server/index.js:20`
- Modify: `server/api-server.core.js:12`
- Modify: `server/mcp-sse.js:16`
- Modify: `server/task-manager.js:12`
- Modify: `server/config.js:200`
- Modify: `server/discovery.js:34,38`
- Modify: `server/tools.js:382`
- Modify: `server/dashboard-server.js:30`
- Modify: `server/container.js` (old phase comments already replaced in Task 1)

- [ ] **Step 1: Find all Phase 3 migration comments**

Run: `grep -rn "Phase 3.*migrate\|Phase 2\.3\|Phase 2\.4" server/*.js server/container.js | grep -v node_modules | grep -v tests/`

- [ ] **Step 2: Remove each comment**

In each file, remove the `// Phase 3: migrate to container.js init(deps) pattern` comment from the `require('./database')` line. The require stays (for now) — just the aspirational comment goes.

Example:
```js
// OLD: const db = require('./database'); // Phase 3: migrate to container.js init(deps) pattern
// NEW:
const db = require('./database');
```

Apply to all files found in Step 1: `index.js`, `api-server.core.js`, `mcp-sse.js`, `task-manager.js`, `config.js`, `discovery.js` (2 occurrences), `tools.js`, `dashboard-server.js`.

- [ ] **Step 3: Verify no remaining Phase 3 migration comments**

Run: `grep -rn "Phase 3.*migrate" server/*.js server/container.js | grep -v node_modules | grep -v tests/`
Expected: No matches

- [ ] **Step 4: Run the full test suite**

Run: `torque-remote npx vitest run`
Expected: All tests pass — comment removal only.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/api-server.core.js server/mcp-sse.js server/task-manager.js server/config.js server/discovery.js server/tools.js server/dashboard-server.js
git commit -m "chore: remove stale Phase 3 migration comments (migration is now in progress)"
```

---

### Task 6: Final verification

- [ ] **Step 1: Verify container tests pass**

Run: `torque-remote npx vitest run server/tests/container.test.js server/tests/event-bus.test.js`
Expected: All pass

- [ ] **Step 2: Verify full test suite**

Run: `torque-remote npx vitest run`
Expected: All pass

- [ ] **Step 3: Verify lint rule reports current state**

Run: `cd server && node scripts/check-no-direct-db-import.js`
Expected: Reports violations for unmigrated modules (expected baseline)

- [ ] **Step 4: Verify container.js exports both new and legacy APIs**

```bash
node -e "const c = require('./server/container'); console.log('createContainer:', typeof c.createContainer); console.log('initModules:', typeof c.initModules); console.log('getModule:', typeof c.getModule); console.log('defaultContainer:', typeof c.defaultContainer);"
```

Expected: All four print their types (function, function, function, object)
