# Universal DI Migration — Design Spec

**Date:** 2026-05-04
**Author:** session-driven (audit cluster follow-up)
**Status:** Draft for approval

> This spec describes the architectural arc to convert TORQUE from imperative
> hand-wired composition to universal container-resolved dependency injection.
> Implementation work begins only after this spec is approved.

---

## TL;DR

The container at `server/container.js` is already a real, capable DI container
with declarative deps, topological sort, boot/freeze lifecycle, and test-reset
support. Roughly 30 services are correctly registered and ~46 source files
correctly resolve from it.

The architectural pain — `task-manager.js` (1256 lines after the in-flight
extraction work) and `factory/loop-controller.js` (14 192 lines) — is **not**
caused by missing infrastructure. It is caused by **module-author conventions
that bypass the container**: most modules expose `init({…dozens of deps…})`
and rely on a god-file to hand-assemble those deps and call init in the right
order. The result is composition god-files that scale linearly with the number
of modules they wire.

This spec proposes a six-phase migration that converts every internal module
to register itself with the container using declarative deps, eliminates the
hand-wired `init({…})` pattern, and makes the legacy `database.js` facade
removable.

Total estimated effort: **8–12 sessions** with a clear rollback at every phase.

---

## Goals

1. **One composition shape.** Every internal module looks like this and only
   like this:
   ```js
   container.register('serviceName', ['dep1', 'dep2'], ({ dep1, dep2 }) =>
     createServiceName({ dep1, dep2 })
   );
   ```
   No more `module.exports.init({ db, logger, dashboard, processQueue, … })`.

2. **Container is the single resolver.** Modules ask the container by name
   for what they need. They do not import each other directly for runtime
   dependencies (constants and pure utilities can still be required).

3. **Composition god-files vanish.** `task-manager.js`'s `initSubModules`
   block (~330 lines) and the corresponding sections of `factory/loop-controller.js`
   become a flat list of registrations distributed across feature directories.

4. **Tests get container overrides instead of `require.cache` surgery.**
   Replace `vi.mock('../foo', …)` and `installCjsModuleMock(…)` patterns with
   `container.override('foo', mockFoo)` (a new method we'll add).

5. **Legacy facade `database.js` is deletable.** When no source file imports
   it directly, drop the file. The 46-entry allowlist in
   `scripts/check-no-direct-db-import.js` becomes empty and the script
   becomes a "this should never violate" CI gate.

6. **New module additions are pluggable.** Adding a feature involves
   registering it with the container. No edits to god-files. The contract
   for "a TORQUE service" matches the existing `server/plugins/plugin-contract.js`
   so internal modules and external plugins look identical at the boundary.

## Non-goals

- **TypeScript migration.** Out of scope. JSDoc contracts only.
- **Replacing `event-bus`, `eventBus`, or the existing pub-sub topology.** The
  bus stays; the container provides handles to it.
- **Decomposing `factory/loop-controller.js` line-count.** That file shrinks
  as a *consequence* of the migration but is not the direct target. A separate
  arc will tackle the remaining domain-logic decomposition.
- **Replacing the plugin loader.** Plugins keep their current shape. We
  *converge* internal modules toward the plugin contract, not the other way.
- **Performance optimization.** A factor-of-2 perf hit on container.get()
  would still be invisible. Container caching covers correctness; perf is
  not a goal here.

---

## Why now (and not before)

Several conditions are now true that weren't earlier in the codebase's life:

- **Container already exists** with topo-sort and a working boot phase
  (`server/container.js`). Earlier the container was either missing or
  boot-order was hand-managed.
- **Most sub-modules already export `createXxx` factories** (326 reported by
  `check-no-direct-db-import.js`'s factory count). The shape is *almost*
  right; we just need to register them.
- **The legacy facade migration is policy-complete** — no source file *adds*
  a new direct database.js import. Existing offenders are allowlisted with
  documented reasons. We can methodically clear that allowlist now.
- **The audit (2026-05-04) is fresh.** The recent sprawl-audit work and
  task-manager-decompose branch (5 commits, −207 lines) prove that
  "extract one cohesive concern at a time" is workable but slow. The
  migration accelerates this by giving every module a clean home in
  the container instead.

If we leave the existing pattern in place, the audit-cluster cleanup we've
been doing will keep producing modest wins (5–10% per pass) but the
1256-line `task-manager.js` and 14k-line `loop-controller.js` floors
won't move because the wiring is what holds them together.

---

## Current state — the actual data

### Container.js inventory

The default container as of this writing registers these services declaratively:

| Service | Deps | Status |
|---------|------|--------|
| `db` (registered by index.js) | — | value |
| `logger` (registered by index.js) | — | value |
| `serverConfig` | — | value |
| `eventBus` | — | value |
| `familyTemplates` | db | factory |
| `actionRegistry` | — | factory |
| `testRunnerRegistry` | — | factory |
| `constructionCache` | db | factory |
| `executor` | actionRegistry | factory |
| `sharedFactoryStore` | db, serverConfig | factory |
| `registeredSpecialists` | — | factory |
| `runDirManager` | db | factory |
| `providerScoring` | db | factory |
| `providerCircuitBreakerStore` | db | factory |
| `circuitBreaker` | eventBus, providerCircuitBreakerStore | factory |
| `parkResumeHandler` | db, eventBus, logger | factory |
| `failoverActivator` | eventBus, logger, circuitBreaker | factory |
| `canaryScheduler` | eventBus, logger, circuitBreaker | factory |
| ~10–15 more | various | factory |

These are the **good citizens**. They demonstrate that the pattern works.

### Modules that bypass the container — categories

A module bypasses the container if it either (a) is imported directly by
runtime code via `require('./other-module')` and that other module returns
behavior, or (b) exposes an `init({…})` method that callers must invoke
with hand-assembled deps.

Categories observed:

1. **Hand-wired init pattern (the main target).** `task-manager.js`'s
   `initSubModules` calls `.init(deps)` on ~25 modules. Each of those modules
   exposes `init` as a public function. Examples:
   - `execution/task-startup.js` — `init({db, dashboard, serverConfig, providerRegistry, …35 deps…})`
   - `execution/task-finalizer.js` — `init({db, safeUpdateTaskStatus, sanitizeTaskOutput, extractModifiedFiles, …12 deps…})`
   - `validation/post-task.js` — `init({db, getModifiedFiles, parseGitStatusLine, sanitizeLLMOutput})`
   - `providers/execution.js` — `init({db, dashboard, runningProcesses, apiAbortControllers, safeUpdateTaskStatus, …~30 deps…})`
   - All of `_workflowRuntimeModule`, `_completionPipeline`, `_closePhases`,
     `_safeguardGates`, `_autoVerifyRetry`, `_retryFramework`,
     `_queueScheduler`, `_taskFinalizer`, `_processStreams`, `_processLifecycle`,
     `_promptsModule`, `_commandBuilders`, `_orphanCleanup`, `_instanceManager`,
     `_outputSafeguards`, `_planProjectResolver`, `_taskExecutionHooks`,
     `_fileContextBuilder`, `_providerRouter`, etc.
   - `factory/loop-controller.js` repeats the same pattern for ~30 more
     factory-side modules.

2. **Legacy facade users (allowlisted).** 46 source files use
   `require('./database')` directly. The allowlist in
   `scripts/check-no-direct-db-import.js` documents why each is exempt:
   - **Composition roots** (5 files): index, container, schema, throughput-metrics,
     factory/loop-instances, factory/worktrees, eslint-rules fixture.
   - **Raw SQL users** (8 files): mcp/sse, config, ci/watcher, hooks/event-dispatch,
     execution/strategic-hooks, execution/task-finalizer, handlers/concurrency-handlers,
     handlers/provider-crud-handlers, handlers/competitive-feature-handlers,
     handlers/automation-handlers, handlers/experiment-handlers,
     plugins/snapscope/handlers/compliance.
   - **Heaviest facade consumers** (final migration targets): api-server,
     dashboard/server, task-manager, api/v2-analytics-handlers,
     api/v2-infrastructure-handlers, dashboard/routes/analytics,
     dashboard/routes/infrastructure, api/v2-core-handlers,
     transports/sse/session.

3. **Test mocks via require.cache surgery.** ~50 test files use either
   `vi.mock(modulePath, …)`, `vi.doMock(modulePath, …)`,
   `installCjsModuleMock(modulePath, …)`, or direct `require.cache[…] = …`
   manipulation. Indicates the modules under test don't accept their deps
   as parameters — they consume them via require.

### What's already correct (don't break it)

- The `defaultContainer` instance exported from `server/container.js` is
  the single source of truth for the running server. Tests sometimes create
  fresh `createContainer()` instances; this stays.
- The `unwrapDb(db)` helper that handles both module-shaped and
  raw-better-sqlite3 db registrations. The pattern works.
- The plugin contract (`server/plugins/plugin-contract.js`). External
  plugins use it; we want internal modules to converge toward it, not
  diverge.
- The DI lint rule `npm run lint:di` (in `server/`). The migration shrinks
  its allowlist; we don't replace the rule.

---

## Design

### The new module shape

Every migrated module exposes exactly one factory and a registration helper.
No `init`, no module-level state, no late-binding setters.

**Before (current pattern, abridged):**
```js
// server/execution/task-finalizer.js (current shape)
let _db, _safeUpdateTaskStatus, _sanitizeTaskOutput, _extractModifiedFiles;
let _handleRetryLogic, _handleSafeguardChecks, /* …8 more… */;

function init(deps) {
  _db = deps.db;
  _safeUpdateTaskStatus = deps.safeUpdateTaskStatus;
  // …12 more assignments…
}

function finalizeTask(taskId, ctx) {
  // uses _db, _safeUpdateTaskStatus, etc.
}

module.exports = { init, finalizeTask };
```

**After (target pattern):**
```js
// server/execution/task-finalizer.js (target shape)
'use strict';

function createTaskFinalizer({ db, safeUpdateTaskStatus, sanitizeTaskOutput,
                               extractModifiedFiles, handleRetryLogic,
                               handleSafeguardChecks, /* … */ }) {
  function finalizeTask(taskId, ctx) {
    // uses parameters via closure — no module state
  }
  return { finalizeTask };
}

function register(container) {
  container.register(
    'taskFinalizer',
    ['db', 'safeUpdateTaskStatus', 'sanitizeTaskOutput',
     'extractModifiedFiles', 'handleRetryLogic', 'handleSafeguardChecks',
     /* … */],
    createTaskFinalizer
  );
}

module.exports = { createTaskFinalizer, register };
```

The composition root then becomes:
```js
// server/container.js (the migration end-state)
require('./execution/task-finalizer').register(_defaultContainer);
require('./execution/task-startup').register(_defaultContainer);
// … one line per module …
_defaultContainer.boot();
_defaultContainer.freeze();
```

### Why this shape (the tradeoffs)

We considered four alternatives:

| Approach | Verdict |
|----------|---------|
| **Decorator-based registration** (`@injectable` etc.) | Rejected — requires Babel/TypeScript and our codebase is JS only. |
| **Auto-discovery** (scan dir, register everything) | Rejected — magic; breaks tree-shaking and explicit-import discipline. |
| **Service locator at call site** (`container.get('db')` inside functions) | Rejected — hides deps in implementations, defeats topo-sort, breaks tests. |
| **Declarative deps + factory + per-module register()** (chosen) | The container already supports it; ~30 services prove it works; tests can substitute deps cleanly. |

The chosen shape:
- Keeps deps explicit (visible in the registration call)
- Survives circular-import detection at boot time
- Lets tests substitute any dep without touching `require.cache`
- Mirrors the existing `server/plugins/plugin-contract.js` install function shape
- Is the minimal change to the container API — only one new method (`override`)

### Container API extensions

The current container is mostly sufficient. Two additions are required:

**1. `container.override(name, value)` — for tests.**

```js
function override(name, value) {
  if (_frozen) throw new Error('Container: cannot override after freeze()');
  _instances.set(name, value);  // injected even if no factory registered
}
```

Replaces `vi.mock('../foo', …)`. Tests do:
```js
const container = createContainer();
require('./db/task-core').register(container);
container.override('db', mockDb);
container.boot();
const taskCore = container.get('taskCore');
```

**2. `container.boot({ failFast = true })` — controlled error behavior.**

Currently `boot()` throws synchronously on factory failure. We need an
opt-in mode that lets index.js:init() catch a partial-boot and fall back
to a degraded-mode startup (e.g. when the database is unreadable). The
existing behavior stays the default; only `failFast: false` changes it.

**Decisions deferred to the implementation plan, not this spec:**

- Should `register` enforce that `name` is camelCase? (probably yes, lint
  rule)
- Should the container emit boot/shutdown events on `eventBus`? (probably
  yes, but optional)
- Should we add an `await container.shutdown()` step that runs disposers in
  reverse-topo order? (probably yes for graceful restart-barrier work,
  but not required for migration correctness)

### What about modules that need pre-boot lookups?

A few modules currently call code at module-load time before any DI exists.
For example:
- `task-manager.js` line 1: `require('./free-quota-tracker')` was a
  module-level side-effect (now extracted to `tasks/free-quota-tracker-singleton.js`).
- The `db` proxy at the top of `task-manager.js` — `new Proxy({}, …)` —
  resolves `db` lazily via the container *each* call. Tests rely on this
  proxy being stable across calls.

The migration handles these as follows:

- **Strict module-level state goes through the container.** No more
  `let _x = null` at module scope unless it's a constant.
- **Lazy resolution stays available** via `container.get(name)` inside the
  factory closure, not at module load. The proxy pattern in
  `task-manager.js`'s `db` is replaced by container.get('db') at the
  call sites that need it; module-load-time access is forbidden by lint rule.
- **The few legitimate pre-boot uses** (e.g. logger setup, constants) keep
  working because they don't require the container. The lint rule allowlists
  `./logger`, `./constants`, `./utils/*` (pure functions), and `./types`.

### Test isolation pattern

The replacement for `vi.mock` and `installCjsModuleMock`:

```js
// Old test pattern (current — fragile)
vi.mock('../task-manager-delegations', () => ({
  executeOllamaTask: vi.fn(() => ({ started: true })),
}));
const taskManager = require('../task-manager');

// New test pattern (target)
const { createContainer } = require('../container');
const { register: registerTaskCore } = require('../db/task-core');
// … register what the test needs …

const container = createContainer();
registerTaskCore(container);
container.override('db', { /* mock db */ });
container.override('executeOllamaTask', vi.fn(() => ({ started: true })));
container.boot();

const taskCore = container.get('taskCore');
```

Benefits over `vi.mock`:
- No `require.cache` mutation, no global state leak between tests
- Mock targets match registered names, not file paths (path-rename-proof)
- Test setup is explicit about which deps it provides; missing deps fail
  loudly at boot()
- Per-test container = per-test isolation

Cost:
- ~50 test files need rewrites. We migrate a test alongside its target
  module, not as a separate phase.

### Naming convention

Container keys are stable contracts; renaming them is a breaking change
for tests and for any in-flight migration. The naming rule:

- **camelCase**, no separators (`taskCore`, not `task-core` or `task_core`)
- **Verb-noun for actions, noun for stores** (`finalizeTask` is a service
  that exposes a method; `taskCore` is a store)
- **No abbreviations except where established** (`db`, `mcp`, not `database`,
  `messageControlProtocol`)
- **No `Service` / `Manager` suffix.** Module name = registered name.

This is enforceable by lint (proposed in Phase 1).

---

## Migration phases

Six phases. Each phase ends in a working main; nothing is left in a half-done
state. Each phase has its own worktree branch (per repo policy).

### Phase 0 — Spec approval (this doc)

Approve this spec. Adjust priorities or scope based on user feedback.

**Deliverable:** signed-off design document committed to
`docs/superpowers/specs/`.
**Cutover:** docs-only branch, no restart barrier needed.

### Phase 1 — Container API expansion + lint scaffolding

Land the container additions and the conventions enforcement *before* any
module migration. This is the foundation.

**Work:**
- Add `container.override(name, value)` (~10 LOC + tests)
- Add `container.boot({ failFast: false })` mode (~15 LOC + tests)
- Add lint rule `torque/no-imperative-init` that flags
  `module.exports.init = function (…) { _state = …; }` patterns. Allowlists
  the existing offenders so the rule is non-blocking until Phase N.
- Add lint rule `torque/no-module-level-side-effects` that flags
  module-load-time mutation outside of pure constants. Same allowlist
  approach.
- Add CI metric: count of registered services, count of `init({…})` modules.
  Track the curve over the migration.

**Deliverable:** container API expanded; two new lint rules in advisory mode;
no behavioral change.
**Cutover:** docs+lint-only changes; rebase-friendly.
**Estimated effort:** 1 session.

### Phase 2 — Pilot subsystem: `validation/`

Pick the smallest cohesive subsystem that demonstrates the migration. The
`validation/` directory is ~6 files (post-task, output-safeguards,
close-phases, safeguard-gates, auto-verify-retry, hashline-verify, etc.).
Their `init({…})` deps are mostly db + a few helper functions.

**Work:**
- For each file in `validation/`:
  1. Convert `init({…})` to `createXxx({…})` factory shape
  2. Add a `register(container)` function
  3. Move corresponding registration into a per-subsystem registration
     file `validation/register.js` that loops over the modules
- Update task-manager.js to call `registerValidation(container)` instead
  of the per-module `init()` calls
- Migrate the `validation/*` test files to the container-override pattern
- Confirm the rest of the system still works (the migrated modules still
  expose their public API the same way)

**Deliverable:** `validation/` is fully container-resident; tests use
container.override; task-manager.js's `initSubModules` shrinks by ~6
init calls.
**Cutover:** server-code branch — restart barrier required.
**Estimated effort:** 2 sessions (one for the migration, one for tests +
review).

**Pilot learning (2026-05-04, safeguard-gates.js — first migrated module):**
The migration cannot be fully atomic at module granularity. When you
migrate `safeguard-gates.js` to the factory shape, `task-manager.js` is
still importing it via `const _safeguardGates = require('./validation/
safeguard-gates'); const { handleSafeguardChecks } = _safeguardGates;`
at module-load time. The factory pattern returns the service at boot
time, not module-load time, so simply renaming `init` to `createXxx`
breaks the destructure.

**Conclusion adopted:** each migrated module exposes BOTH shapes during
the transition — the new `createXxx({…}) + register(container)` for new
consumers and the old `init({…}) + named exports` for the still-imperative
consumers. The legacy shape is removed in the same commit that migrates
the last consumer, not before. This is the only kind of coexistence the
spec endorses — short-lived, per-module, with a clear delete-by point.

**Decision gate:** if the pilot reveals fundamental problems with the new
shape, we revisit the design before continuing. The pilot is the safety
valve for the rest of the arc.

### Phase 3 — `execution/` subsystem

The `execution/` directory is the largest concentration of `init({…})`
modules (~15 files: queue-scheduler, task-startup, task-finalizer,
process-lifecycle, process-streams, process-tracker, command-builders,
provider-router, file-context-builder, fallback-retry, workflow-runtime,
workflow-resume, retry-framework, sandbox-revert-detection,
completion-pipeline, etc.).

This is the heart of the task-running engine. Migration here is the
biggest leverage point — it's what shrinks `task-manager.js` the most.

**Work:**
- Migrate every `execution/*.js` to factory + register shape
- Add `execution/register.js` that loops registrations
- Update task-manager.js
- Tests converted alongside

**Deliverable:** task-manager.js shrinks from ~1256 lines to ~600–800 lines
(depending on how much state stays).
**Cutover:** server-code branch — restart barrier required. Run full
test suite remotely.
**Estimated effort:** 3 sessions.

### Phase 4 — `factory/` subsystem

`factory/loop-controller.js` (14 192 lines) is its own beast. Phase 4
focuses on the *wiring* in factory: the `init({…})` calls that loop-controller
makes to its sibling modules (factory-tick, plan-executor, architect-runner,
worktree-auto-commit, internal-task-submit, startup-reconciler, etc.).

**Important:** Phase 4 does *not* attempt to decompose loop-controller.js's
14k lines of domain logic. That is a separate arc. Phase 4 only converts
its *deps acquisition* from imperative to container-resolved. Loop-controller
still has its huge body, but it asks the container for what it needs
instead of having a god-init pre-stuff every dep.

**Work:**
- Migrate `factory/*.js` modules to factory + register
- Add `factory/register.js`
- Loop-controller.js consumes via container.get inside its functions
  instead of via top-level `let _x = null` + `init` setters
- This may shrink loop-controller.js by ~1000 lines (remove init() and
  module-level setters); the remaining ~13k is domain logic for a future
  arc.

**Deliverable:** factory subsystem is container-resident.
**Cutover:** server-code branch — restart barrier required. This is the
highest-risk phase given factory's footprint; cutover requires the
remote test suite green.
**Estimated effort:** 2 sessions.

### Phase 5 — Remaining subsystems + facade migration

The remaining `init({…})` callsites:
- `dashboard/server.js`
- `api-server.js`
- `mcp/sse.js`
- `handlers/*.js` (the few that have `init`)
- `policy-engine/*.js`
- `routing/*.js`

Each is small individually. Bundle them in one phase.

In parallel, drive the legacy `database.js` allowlist toward zero:
- For each allowlisted file, identify what `db.X` calls it makes
- Either route those calls through the right db-sub-module via the
  container, or extract the raw-SQL pattern into a tiny db sub-module
  with a clean interface
- Remove the file from the allowlist
- When the allowlist is empty, the script becomes a hard CI gate
  (currently advisory)

**Deliverable:** every internal module is container-resident. Allowlist
is empty. `database.js` has zero source-side importers (tests still use it
until Phase 6).
**Cutover:** server-code branch — restart barrier required.
**Estimated effort:** 2 sessions.

### Phase 6 — Test migration + facade deletion

With no source files importing `database.js`, the facade can finally be
deleted. But tests still use it (`require('../database')` in ~46 test files).

Two ways to handle this:
- **(a)** Migrate tests to container-resident pattern as part of this phase
- **(b)** Keep tests on the facade (rename it `database.test-only.js` and
  carve out an exception)

Recommend **(a)** — finishes the arc cleanly. ~46 test-file migrations is
finite work and makes tests structurally sounder.

**Work:**
- Convert every `require('../database')` test to use a fresh container
- Replace remaining `vi.mock` patterns at module-path with container.override
- Delete `server/database.js`
- Update CLAUDE.md "Architecture — DI Container" section to reflect the
  finished state

**Deliverable:** legacy facade removed; tests use container-overrides.
**Cutover:** server-code branch — restart barrier required.
**Estimated effort:** 2 sessions.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Boot-order surprise** — a factory needs a service that wasn't registered yet | Medium | High (boot crash) | Topo-sort already detects this; we'll see it as a clear error message at boot, not at first request |
| **Hidden circular dep** revealed when modules try to consume each other through the container | Medium | High | Container detects cycles at boot. If revealed, break with lazy resolution: `function fooThing() { return container.get('bar').foo(); }` instead of resolving at factory time |
| **Test-suite drift** — old tests fail in subtle ways during migration | High | Medium | Migrate tests *with* their target module in the same commit. Don't bulk-migrate tests separately |
| **Performance regression** from container lookup overhead | Low | Low | Container caches via `_instances` Map; lookup is `Map.get` — micro-overhead. Measurable but negligible |
| **Plugin contract divergence** — internal modules drift from external plugins | Medium | Low | Run a periodic audit (Phase 5+) confirming the shapes converge. The shapes don't have to be *identical* — register() is the abstraction layer |
| **Allowlist regression** — someone adds a new allowlisted file mid-arc | Medium | Medium | Phase 1 lint rule fires advisory warnings; Phase 5 makes them errors. Pre-merge gate prevents new entries |
| **One service blocks multiple phases** — e.g. `task-manager.js` gates phases 3, 5, 6 | High | Medium | Phase 4 explicitly preserves loop-controller.js's domain logic so it doesn't gate decomposition work |
| **Dashboard/runtime restart drag** — many phases require restart barriers | Certain | Low | Standard worktree-cutover flow handles this; the only operational concern is in-flight ollama tasks (we hit this twice already) |

---

## Open questions for review

These are the spec-level decisions where I'd take your direction over my
recommendation. Each one is a fork that affects the rest of the plan:

**Q1: Should the migration converge internal modules to the existing plugin
contract (`name`, `install`, `uninstall`, `mcpTools`, `eventHandlers`,
`configSchema`), or keep internal-vs-plugin as separate shapes that share
the container?**

My recommendation: **keep them separate** during the migration; consider
unifying afterwards as a follow-up. The plugin contract has plugin-specific
fields (mcpTools, configSchema) that internal modules don't need. Forcing
convergence now bloats internal registrations.

**Q2: Should we add an explicit `dispose()` / shutdown phase to the
container, or is `index.js`'s current shutdown sequence sufficient?**

My recommendation: **add it** in Phase 1. The current shutdown sequence
is `task-manager.shutdown()` which is itself a god-function. A
container-managed shutdown that runs disposers in reverse-topo order
mirrors the boot flow and gives modules a clean place to clean up
intervals and handlers.

**Q3: Should we adopt this in a single arc per the phase plan above, or
strangler-pattern with both shapes coexisting indefinitely?**

My recommendation: **single arc** with the phase plan. Coexistence
indefinitely re-creates the current pain — modules that are half-migrated
add cognitive overhead. The phases are short enough that we can finish
in 8–12 sessions.

**Q4: For the legacy `database.js` facade — do we delete the file or keep
it as a thin re-exporter for backward compat with downstream
projects/forks/scripts?**

My recommendation: **delete it**. There are no downstream consumers we
need to support; the audit-memory note revision documented this. A
re-exporter just preserves the smell.

**Q5: Test migration — do we migrate every test or only ones whose target
modules migrate?**

My recommendation: **only ones whose target migrates**, in the same
commit/branch. Bulk test migration creates a cliff that tends to be
deferred indefinitely.

---

## What this spec is NOT promising

So future-me reading this doesn't get confused:

- This spec doesn't promise `factory/loop-controller.js` becomes <1k lines.
  It promises that loop-controller.js no longer hand-wires its deps;
  the remaining size is domain logic that's a separate arc.
- This spec doesn't promise eliminating `module.exports`. CommonJS stays.
- This spec doesn't promise a configuration-driven container (e.g. JSON-
  defined registrations). Per-module `register()` calls are the contract.
- This spec doesn't promise removing the existing `defaultContainer`
  singleton. Tests use fresh containers; production uses defaultContainer.

---

## Appendix A — Sample migration: `validation/post-task.js`

To make the contract concrete, here's what a single-module migration looks
like, end-to-end. This is an illustrative diff, not a final design.

**Current (~30 LOC of init scaffolding):**
```js
// server/validation/post-task.js (today)
let _db, _getModifiedFiles, _parseGitStatusLine, _sanitizeLLMOutput;

function init({ db, getModifiedFiles, parseGitStatusLine, sanitizeLLMOutput }) {
  _db = db;
  _getModifiedFiles = getModifiedFiles;
  _parseGitStatusLine = parseGitStatusLine;
  _sanitizeLLMOutput = sanitizeLLMOutput;
}

function cleanupJunkFiles(taskId, files) {
  // uses _db, _getModifiedFiles, etc.
}

// …more functions…

module.exports = { init, cleanupJunkFiles, /* … */ };
```

**Migrated (factory + register, no module state):**
```js
// server/validation/post-task.js (target)
'use strict';

function createPostTask({ db, getModifiedFiles, parseGitStatusLine, sanitizeLLMOutput }) {
  function cleanupJunkFiles(taskId, files) {
    // uses parameters via closure
  }
  // …more functions…
  return { cleanupJunkFiles, /* … */ };
}

function register(container) {
  container.register(
    'postTaskValidation',
    ['db', 'getModifiedFiles', 'parseGitStatusLine', 'sanitizeLLMOutput'],
    createPostTask
  );
}

module.exports = { createPostTask, register };
```

**task-manager.js change (loses 5 lines):**
```diff
- _postTaskModule.init({
-   db,
-   getModifiedFiles,
-   parseGitStatusLine,
-   sanitizeLLMOutput,
- });
```
(`getModifiedFiles`, `parseGitStatusLine`, `sanitizeLLMOutput` themselves
need to be registered as services first — they're currently exported from
`utils/git.js` and `utils/sanitize.js`. Phase 2 catches them as it migrates
their consumers.)

**Container.js change (gains 1 line):**
```diff
+ require('./validation/post-task').register(_defaultContainer);
```

**Test change (replaces vi.mock with container.override):**
```diff
- vi.mock('../db', () => ({ /* mock */ }));
- const postTask = require('./post-task');
- postTask.init({ db: mockDb, getModifiedFiles: vi.fn(), … });

+ const { createContainer } = require('../container');
+ const container = createContainer();
+ container.registerValue('db', mockDb);
+ container.registerValue('getModifiedFiles', vi.fn());
+ require('./post-task').register(container);
+ container.boot();
+ const postTask = container.get('postTaskValidation');
```

---

## Appendix B — Effort estimate breakdown

| Phase | Sessions | Cumulative |
|-------|---------:|-----------:|
| 0. Spec approval | 0.5 | 0.5 |
| 1. Container API + lint | 1 | 1.5 |
| 2. Pilot — `validation/` | 2 | 3.5 |
| 3. `execution/` migration | 3 | 6.5 |
| 4. `factory/` migration | 2 | 8.5 |
| 5. Remaining + facade allowlist drive-down | 2 | 10.5 |
| 6. Test migration + facade deletion | 2 | 12.5 |

Real schedules have slack. **Plan for 12, expect 8–14.**

---

## Approval checklist

Before Phase 1 begins:

- [ ] Q1–Q5 above answered
- [ ] Phase ordering confirmed (or revised)
- [ ] Effort estimate accepted as a budget, not a contract
- [ ] CLAUDE.md update plan agreed (when do we update the architecture
      section — staged per phase, or once at the end?)
- [ ] Naming convention (camelCase, no Service suffix) accepted
- [ ] `container.override` API name accepted (alternative: `container.set`,
      `container.injectForTest`)

Once the checklist is green, the implementation plan is authored via the
superpowers `writing-plans` skill, with one plan file per phase.

---

*This spec is the planning artifact for the universal DI migration arc.
Implementation begins after approval.*
