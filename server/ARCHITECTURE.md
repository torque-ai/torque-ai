# TORQUE server — DI architecture

This is the canonical reference for how TORQUE's `server/` subtree is composed. Read this before touching `container.js`, before adding a new module that depends on shared services, or before extending the universal-DI migration arc.

The migration spec lives at `docs/superpowers/specs/2026-05-04-universal-di-design.md`. This document describes the *current* shape — what new code should look like — not the historical roadmap.

## TL;DR

- The composition root is `server/container.js`. Every shared service is registered there or via subsystem aggregators (`validation/register.js`, `execution/register.js`, `factory/register.js`).
- New consumers resolve services through `defaultContainer` — usually via `resolveMethod()` from `execution/capability-resolver.js` for lazy lookup.
- Modules that own state (registries, trackers, accessors) register themselves at construction site via `defaultContainer.registerValue('name', instance)` so there's one canonical instance.
- The legacy `init({…})` + module-level `let _x = null` pattern is being phased out. Don't write new code in that shape.
- `npm run lint:di` (in `server/`) reports facade importers and other pattern violations.

## Core concepts

### The container (`server/container.js`)

A simple DI container with three operations:

```js
container.register(name, deps, factory)   // factory invoked at boot()
container.registerValue(name, value)      // pre-built instance
container.get(name)                       // resolve post-boot, throws pre-boot
container.peek(name)                      // resolve any time (values + post-boot factories)
container.override(name, value)           // replace; works pre- and post-boot
container.boot({ failFast = true })       // topo-sort + instantiate factories
```

`defaultContainer` is the singleton used everywhere. `createContainer()` makes a fresh one for tests.

### What goes in the container

**Yes:**
- Database handles, the event bus, the logger, `serverConfig`, the dashboard broadcaster — anything stateful and shared.
- Service objects with mutable internals (`processTracker`, `finalizationTracker`, `closeHandlerState`).
- Capability services that decompose larger orchestrators (`taskCanceller` decomposed from `taskManager`).

**No:**
- Pure utility functions (`parseCommand`, `sanitizeOutput`, `computeLineHash`). Just `require()` them. The lint rule `torque/no-utility-deps-in-register` enforces this.
- Module-level constants (`MAX_OUTPUT_BUFFER`). Same — `require` from where they're defined.
- Closures over another module's internals (`attemptTaskStart` reaching into task-manager's queue state). These signal that the *capability* should become a service, not that the closure should be a dep.

### Resolution patterns

#### Module-load time (before `container.boot()`)

```js
const { defaultContainer } = require('../container');
const tracker = defaultContainer.peek('processTracker');  // returns the value
```

`peek` works for `registerValue`/`override` entries even pre-boot. It returns `undefined` for factory entries that haven't been instantiated yet.

#### After boot, in service factories

```js
function createMyService(localDeps = {}) {
  // localDeps overrides win for tests; production fills from container.
  const db = localDeps.db || defaultContainer.get('db');
  // ...
}
```

Inside a `register(...)` factory callback, deps come pre-resolved as the `(deps) => ...` argument. You don't need to call `get()` yourself for declared deps.

#### Capability methods on consumer call paths — use `resolveMethod`

When a factory needs to call `taskManager.cancelTask(...)` or `taskCanceller.cancelTask(...)`, the right pattern is **lazy resolution**:

```js
const { resolveMethod } = require('./capability-resolver');

function createWorkflowRuntime(localDeps = {}) {
  const cancelTask = resolveMethod(localDeps, {
    capability: 'taskCanceller',     // container.get(name) when present
    method: 'cancelTask',            // capability[method] is the function
    legacyHandle: 'taskManager',     // localDeps[legacyHandle][method] fallback
    legacyKey: 'cancelTask',         // localDeps[legacyKey] direct override (test seam)
  });
  // cancelTask is a function. Each call resolves at runtime — registrations
  // after construction are honored automatically.
}
```

The resolver's priority chain: `localDeps[legacyKey]` → `defaultContainer.get/peek(capability)[method]` → `localDeps[legacyHandle][method]`. It throws with the full chain in the message when nothing resolves.

**Don't write the eager equivalent** (peek + bind at construction). It has known fragility: factories built before boot miss registrations permanently. The lint rule `torque/prefer-resolve-method` warns when it sees the eager shape.

### State decomposition

When two or more modules touch the same Map or accessor, that state belongs in a **service** owned by the container, not a closure passed via `init({sharedMap})`. Three reference examples:

- `server/execution/process-tracker.js` — `ProcessTracker extends Map`. Absorbs `runningProcesses`, `apiAbortControllers`, `pendingRetryTimeouts`, `taskCleanupGuard`, `stallRecoveryAttempts` into one class. Registered as `processTracker` in `container.js`.
- `server/execution/finalization-tracker.js` — similar shape for tasks inside the close-handler async pipeline.
- `server/tasks/close-handler-state.js` — accessor over module-level counter; registered as `closeHandlerState`.

The pattern: extend `Map` (or build a small class), keep domain methods on it (`start`, `touch`, `cleanup`, `idleMs`), `registerValue` it once, every consumer peeks/gets the same instance.

### Capability decomposition (the "thin composer" rule)

When a large orchestrator (`task-manager.js`) hosts behavior that consumers reach into for specific methods, extract that behavior into a **capability service**. Then make `task-manager.js` register *its own constructed handler* as the canonical container value:

```js
// In task-manager.js (the construction site):
const _cancellationHandler = createCancellationHandler({ db, logger, ... });
const { cancelTask, triggerCancellationWebhook } = _cancellationHandler;
defaultContainer.registerValue('taskCanceller', _cancellationHandler);
```

After this:
- task-manager's own `cancelTask` export is a reference to the same handler
- `defaultContainer.get('taskCanceller')` returns the same instance
- Every consumer (workflow-runtime, fallback-retry, process-lifecycle, future ones) sees one canonical object
- The `register('taskCanceller', deps, factory)` declaration in `execution/register.js` becomes the *fallback* for tests that boot the container without loading task-manager

This is **the "thin composer" rule**: capabilities have one construction site, and that site registers the instance. Each future capability extraction (taskExecutor, queueDispatcher, taskStatusUpdater) uses this template.

### The legacy `init({…})` shape

A sizable number of modules still expose:

```js
let _db = null;
let _eventBus = null;

function init(deps) {
  if (deps.db) _db = deps.db;
  if (deps.eventBus) _eventBus = deps.eventBus;
}

module.exports = { init, doSomething };
```

This is **the imperative-init pattern** the migration is replacing. Coexistence rule: when a module ships `init` plus a new `createXxx(deps) + register(container)` factory shape, the legacy `init` stays under `@deprecated` until the consumer call sites migrate.

The lint rule `torque/no-imperative-init` warns on the imperative shape; existing offenders are allowlisted in `eslint.config.js` and should shrink over time.

## Test seam

Tests can swap any registered service:

```js
const { createContainer, defaultContainer } = require('../container');

// Option A: mutate defaultContainer (works post-load, even pre-boot for value entries)
defaultContainer.override('taskCanceller', { cancelTask: vi.fn() });

// Option B: build an isolated container for the test
const isolated = createContainer();
isolated.registerValue('db', mockDb);
// ...
```

The `resolveMethod` resolver re-checks the container at every method call, so `override()` takes effect immediately — no factory rebuild required. The rule of thumb: tests reach for `override` on `defaultContainer` for incremental swaps, and `createContainer()` for full isolation.

## Aggregator `register.js` files

Three subsystem aggregators wire their modules into the default container:

- `server/validation/register.js`
- `server/execution/register.js`
- `server/factory/register.js`

Each one `require()`s every module in its subsystem (so their `register()` functions are loaded as a side effect) and then calls the subset whose declared deps are fully container-managed. Modules whose `register()` would crash `boot()` (because they declare utility-function or task-manager-closure deps) stay loadable but unwired — see each aggregator's header for the full rationale.

`container.js` calls these aggregators near the bottom of the file, just before the `module.exports`.

## Adding a new shared service — the recipe

1. **Decide if it's a service.** Stateful/shared? Yes → service. Stateless utility? No — just `require` it.
2. **Pick a construction site.** Usually the file that owns the state (or the orchestrator that's already creating an instance inline).
3. **Register at construction site.**
   ```js
   const handler = createMyHandler({ db, eventBus, logger });
   defaultContainer.registerValue('myService', handler);
   ```
4. **Add a fallback factory** in the relevant subsystem `register.js` for tests that boot without loading the construction site:
   ```js
   container.register('myService', ['db', 'eventBus', 'logger'], (deps) => createMyHandler(deps));
   ```
5. **Consumers use `resolveMethod`** for capability-style methods, or `defaultContainer.get()` directly for object-style services they hold a reference to:
   ```js
   const myMethod = resolveMethod(localDeps, {
     capability: 'myService',
     method: 'doIt',
     legacyHandle: 'taskManager',
     legacyKey: 'doIt',
   });
   ```
6. **Test it** with `defaultContainer.override('myService', mock)`.

## Metrics

`node server/scripts/di-migration-metrics.js` reports the current state:

```
container.register() calls in source         # how many factory registrations exist
Subsystem services wired at boot              # how many actually instantiate cleanly
Container values registered (instances)       # registerValue counts
Modules using imperative init({…}) pattern    # legacy shape count
Unauthorized source database.js imports       # must stay at 0
Allowed/load-bearing facade require sites     # remaining deletion blockers
DI fallback facade require sites              # migrated modules with test fallback
Test files importing database.js directly     # deferred test migration count
```

The migration is "done" when:
- `wired_at_boot ≈ register_calls` (most factories instantiate at boot)
- `imperative_init_modules == 0` (no legacy shapes left)
- `direct_database_importers == 0` (unauthorized source imports stay closed)
- `allowed_database_importers == 0` (and `database.js` facade can be deleted)

## Why this shape

Three architectural principles drove the current state:

1. **State decomposition over state distribution.** Shared maps passed by reference through `init({someMap})` were the worst kind of coupling — multiple modules mutating the same data, no encapsulated lifecycle, no observability. Wrapping shared state in classes that *register themselves* gives every consumer the same instance and a clear interface.

2. **Lazy resolution over eager binding.** Construction-time lookups are fragile when factories run before `container.boot()`. Resolving at method-call time means the latest registration always wins; tests can swap instances mid-run; the dual-path concern (two handlers from the same code, behaviorally consistent only by coincidence) disappears.

3. **Capabilities, not god-objects.** When 9 services declare `taskManager` as a register-dep, they're really depending on three or four specific methods. Extracting those methods into focused capability services (`taskCanceller`, `taskExecutor`, ...) lets consumers declare what they actually need. The orchestrator becomes a *composer* — registering the capabilities — rather than a hub everyone reaches into.

When extending the architecture, ask: am I distributing state, binding at construction, or god-objecting? If yes to any, see the principle above and the corresponding pattern.
