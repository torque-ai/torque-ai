# OSS Architecture Remediation — Design Spec

**Date:** 2026-03-21
**Goal:** Prepare the TORQUE codebase for open-source review by fixing architectural problems and removing personal data. Full dependency graph rewrite with proper DI, god file decomposition, and credibility cleanup.
**Approach:** Incremental migration — every commit leaves the codebase in a working state with all tests passing.

---

## 1. Target Container Architecture

### Current State

- `database.js` is a god-object facade that merges 47 sub-modules (`db/*.js` + 2 `policy-engine/*.js`) into one flat namespace
- 262 files `require('./database')` directly (101 source + 161 test)
- 64 files `require('./task-manager')` directly
- `container.js` exists but only wires 3 modules (config, providerCfg, providerRegistry)
- DB sub-modules receive the SQLite handle via `setDb(db)` — a mutable setter pattern
- `_wireCrossModuleDI()` wires ~30 cross-module setter injections on top of `setDb` (the hardest part of migration)
- 4 db sub-modules circularly `require('../database')`: `throughput-metrics.js`, `host-management.js`, `schema.js`, `provider-routing-core.js`
- Multiple `// Phase 3: migrate to container.js init(deps) pattern` comments acknowledge the debt

### Target State

Every module becomes a **factory function** that declares its dependencies as parameters and returns its public API:

```js
// server/db/host-management.js
module.exports = function createHostManagement({ db, logger, eventBus, taskCore, projectConfigCore }) {
  // taskCore.getTask replaces the old setGetTask(getTask) setter
  function addHost(name, url) { /* ... */ }
  function removeHost(id) { /* ... */ }
  return { addHost, removeHost, listHosts };
};
```

No module imports another module at the top level via `require()` for cross-module dependencies. All wiring happens in the container. The `setDb()` + `setGetTask()` + `setDbFunctions()` setter pattern is eliminated entirely — factory params replace all setters.

### Container API

```js
// server/container.js
const container = {
  boot()    // Wire all services in dependency order, then freeze
  get(name) // Retrieve a registered service (throws before boot or if unknown)
  freeze()  // Prevent further registrations
  resetForTest(opts) // Re-boot with fresh in-memory DB (replaces database.resetForTest)
};
```

### Startup Flow

```
index.js (thin entry point)
  └─ container.boot()
       ├─ Phase 1: Infrastructure
       │    ├─ logger
       │    ├─ event-bus (factory, not singleton require)
       │    └─ database connection (raw SQLite handle)
       ├─ Phase 2: Data layer
       │    ├─ Stateless db utilities (config-keys, query-filters, schema-seeds, etc.)
       │    ├─ Tier A: db-only modules (26 with setDb)
       │    └─ Tier B: cross-wired modules (replacing _wireCrossModuleDI setter chains)
       ├─ Phase 3: Domain services
       │    ├─ task-manager (receives db modules it needs, not the facade)
       │    ├─ discovery
       │    ├─ provider registry + individual providers
       │    ├─ free-quota-tracker
       │    ├─ execution modules (26 files in execution/)
       │    └─ config
       ├─ Phase 4: Transports & handlers
       │    ├─ mcp-stdio
       │    ├─ mcp-sse
       │    ├─ api-server (REST)
       │    ├─ dashboard
       │    ├─ handler modules (78 files in handlers/)
       │    └─ policy engine (17 files in policy-engine/)
       └─ freeze()
```

### Dependency Rules

1. **DB modules** (`db/*.js`) depend only on: raw SQLite connection, logger, event-bus, other db modules
2. **Domain services** depend on: db modules, logger, event-bus, other services
3. **Execution modules** depend on: domain services, db modules
4. **Transports** depend on: domain services, logger, event-bus
5. **Handlers** depend on: domain services, db modules (not transports)
6. **No module imports another module's singleton** — all deps come through factory params
7. **`database.js` facade remains** as backward compat during migration, removed in Phase 5

---

## 2. God File Decomposition

The DI migration forces these breakups — you can't write a clean factory for a 3000-line file.

### Files over 1500 lines (non-test, non-schema)

| File | Lines | Action |
|------|-------|--------|
| `api-server.core.js` | 3213 | Split (see below) |
| `db/provider-routing-core.js` | 3054 | Split in Phase 2 |
| `db/project-config-core.js` | 2486 | Split in Phase 2 |
| `db/scheduling-automation.js` | 2112 | Split in Phase 2 |
| `task-manager.js` | 2079 | Split (see below) |
| `db/task-metadata.js` | 2017 | Split in Phase 2 |
| `mcp/index.js` | 2007 | Split in Phase 4 |
| `mcp-sse.js` | 1893 | Split (see below) |
| `handlers/workflow/index.js` | 1756 | Split in Phase 4 |
| `tool-defs/advanced-defs.js` | 1739 | Stays (declarative definitions) |
| `db/file-tracking.js` | 1738 | Split in Phase 2 |
| `handlers/automation-batch-orchestration.js` | 1704 | Split in Phase 4 |
| `index.js` | 1663 | Split (see below) |
| `validation/post-task.js` | 1628 | Split in Phase 4 |
| `tool-defs/validation-defs.js` | 1617 | Stays (declarative definitions) |
| `db/host-management.js` | 1519 | Split in Phase 2 |

### `api-server.core.js` (3213 lines) → 3 files

| New File | Responsibility |
|----------|---------------|
| `api/server.js` | HTTP server lifecycle (create, listen, shutdown) |
| `api/route-registry.js` | Route mounting and middleware chain |
| `api/legacy-routes.js` | v1 route handlers (existing `api/routes.js` absorbs) |

The v2 handlers already live in `api/v2-*.js` — no change needed.

### `mcp-sse.js` (1893 lines) → 3 files

| New File | Responsibility |
|----------|---------------|
| `transports/sse/server.js` | HTTP server, connection lifecycle, keepalive |
| `transports/sse/session.js` | Session state, event queue, dedup, priority eviction |
| `transports/sse/protocol.js` | JSON-RPC dispatch, tool call routing |

### `task-manager.js` (2079 lines) → 2 files

| New File | Responsibility |
|----------|---------------|
| `services/task-lifecycle.js` | Create, cancel, complete, status transitions |
| `services/task-execution.js` | Spawn processes, monitor, retry, provider routing |

Provider registration (currently hardcoded in `initEarlyDeps()`) moves to the container.

### `index.js` (1663 lines) → 2 files

| New File | Responsibility |
|----------|---------------|
| `container.js` | Expanded composition root (all wiring) |
| `index.js` | Thin entry point: parse args, `container.boot()`, PID heartbeat, signals |

### `database.js` (843 lines) → thin wrapper

Keep only: SQLite connection setup, `init()`, `getDataDir()`, migrations.
Remove: the 47-module merge loop and `_wireCrossModuleDI()`. Each db module becomes a standalone factory.

### Large db modules — split during Phase 2

| Module | Lines | Split Into |
|--------|-------|-----------|
| `db/provider-routing-core.js` | 3054 | `db/provider-routing.js` + `db/provider-fallback.js` + `db/provider-config-store.js` |
| `db/project-config-core.js` | 2486 | `db/project-settings.js` + `db/project-pipelines.js` + `db/project-cache-config.js` |
| `db/scheduling-automation.js` | 2112 | `db/scheduling.js` + `db/automation-templates.js` + `db/audit-log.js` |
| `db/task-metadata.js` | 2017 | `db/task-metadata-core.js` + `db/task-search.js` + `db/task-statistics.js` |
| `db/file-tracking.js` | 1738 | `db/file-tracking-core.js` + `db/file-diff.js` |
| `db/host-management.js` | 1519 | `db/host-crud.js` + `db/host-health.js` + `db/host-selection.js` (already exists, merge) |

### Files that stay as-is

- `db/schema-tables.js` (3203 lines) — declarative schema definition, large but not complex
- `tool-defs/*.js` — declarative tool definitions, no logic to decompose
- `dashboard-server.js` (1258 lines) — self-contained, below threshold

---

## 3. The `_wireCrossModuleDI` Problem

This is the hardest part of the migration. Currently `database.js` has a `_wireCrossModuleDI()` function that wires ~30 cross-module setter injections after all `setDb()` calls. These setters are how db sub-modules access each other's functions without circular requires.

### Current Setter Chains (from `_wireCrossModuleDI`)

```
fileTracking         ← getTask
costTracking         ← getTask
hostManagement       ← getTask, projectConfigCore.getProjectRoot
schedulingAutomation ← getTask, webhooksStreaming.recordTaskEvent,
                       projectConfigCore.{getPipeline, createPipeline}
taskMetadata         ← getTask, webhooksStreaming.getTaskEvents,
                       projectConfigCore.getRetryHistory,
                       schedulingAutomation.{recordAuditLog, getApprovalHistory},
                       createTask
coordination         ← getTask
providerRoutingCore  ← getTask, hostManagement (entire module)
eventTracking        ← getTask, 13 functions from schedulingAutomation + projectConfigCore
analytics            ← getTask, 5 functions from schedulingAutomation + projectConfigCore,
                       taskMetadata.findSimilarTasks
projectConfigCore    ← getTask, eventTracking.recordEvent,
                       7 functions from webhooksStreaming + costTracking + schedulingAutomation
backupCore           ← 9 internal functions including injectDbAll itself (re-boot capability)
policyProfileStore   ← projectConfigCore.getProjectMetadata
taskCore             ← 6 functions from projectConfigCore + eventTracking + fileTracking
```

### Migration Strategy

Each factory function receives its cross-module deps as explicit parameters. The container resolves the order using topological sort:

```js
// Phase 2 container wiring (replaces _wireCrossModuleDI)
const taskCore = createTaskCore({ db, logger });
const configCore = createConfigCore({ db, logger });
const costTracking = createCostTracking({ db, logger, taskCore });
const webhooksStreaming = createWebhooksStreaming({ db, logger });
const projectConfigCore = createProjectConfigCore({
  db, logger, taskCore, eventTracking, webhooksStreaming, costTracking, schedulingAutomation
});
// ... etc, topologically sorted
```

### Circular Dependencies to Break

Four db sub-modules currently `require('../database')` — a circular dependency back to the facade:

| Module | Why it imports database.js | Fix |
|--------|--------------------------|-----|
| `db/throughput-metrics.js` | Bypasses setDb entirely | Convert to factory, receive db via params |
| `db/host-management.js` | Accesses functions not provided via setters | Add missing deps to factory params |
| `db/schema.js` | Accesses core DB functions | Convert to factory |
| `db/provider-routing-core.js` | Accesses functions not in setters | Add missing deps to factory params |

### `backupCore.restoreDatabase()` — Special Case

`backupCore` receives `setInternals()` with a `setDbRef` callback that swaps the live DB handle and re-runs all wiring. This is essentially a runtime container re-boot. After migration:

- `container.resetForTest(opts)` replaces this capability
- `backupCore.restoreDatabase()` calls `container.reboot(newDbPath)` which re-creates all factories with the new DB handle
- The `setInternals` pattern is eliminated

### `resetForTest()` — Test Infrastructure

`database.resetForTest()` is called by 110 files (mostly tests via `vitest-setup.js`). It currently:
1. Closes the DB
2. Creates a fresh in-memory DB
3. Re-runs `_injectDbAll()` + `_wireCrossModuleDI()`

After migration:
- `container.resetForTest()` replaces this
- Creates fresh in-memory SQLite, re-runs all factories, returns the fresh container
- Test setup calls `container.resetForTest()` instead of `db.resetForTest()`
- The facade's `resetForTest()` delegates to the container during migration (backward compat)

---

## 4. Migration Phases

### Phase 0: Credibility Cleanup

No architecture changes. Pure cleanup for open-source presentation.

**Hardcoded personal data to remove:**

| File | Issue | Fix |
|------|-------|-----|
| `server/tests/baseline-runner.js` | Hardcoded personal paths, IP `192.0.2.100` | Replace with env vars and `os.tmpdir()` |
| `server/tests/baseline-all-models.js` | Same paths and IPs | Same fix |
| `server/tests/agentic-integration.test.js` | Default fallback to `192.0.2.100`, `remote-gpu-host` references | Use env var with `localhost` default |
| `server/tests/pid-heartbeat.test.js` | Personal username references | Use generic test values |
| `server/handlers/provider-ollama-hosts.js` | Example IPs in help text | Use RFC 5737 `192.0.2.x` range |
| 30+ `docs/superpowers/` files | Personal paths in specs/plans | Scrub personal data from committed docs |

**Structural cleanup:**

| Item | Action |
|------|--------|
| `server/server/tests/` | Delete orphaned nested directory |
| `server/tmp-peek-capture-rndOvK/` | Delete stale temp dir, add `server/tmp-*` to `.gitignore` |
| `apply_safeparse.py` (project root) | Move to `scripts/` or delete |
| `// Phase 3: migrate...` comments (~8 files) | Remove as each file is migrated |

**`.gitignore` additions:**
- `server/tmp-*` pattern for stray temp dirs

### Phase 1: Container Foundation

- Expand `container.js` with `boot()`, `get()`, `freeze()`, `resetForTest()` API
- Add topological sort for dependency resolution — modules declare deps, container resolves order automatically (avoids boot() itself becoming a god function with 200+ lines of manual ordering)
- Add dependency graph validation (detect missing deps, circular refs at boot time)
- `index.js` calls `container.boot()` — all existing inline wiring moves into boot
- All existing behavior preserved — container wraps current singletons initially
- Add lint/grep rule: `no-direct-database-import` — warn on new `require('./database')` in migrated modules
- `event-bus.js` converted to factory (currently a singleton imported by many modules)

### Phase 2: DB Sub-Modules (47 files)

Two sub-phases: first `setDb` migration, then `_wireCrossModuleDI` elimination.

**Phase 2A — Convert setDb pattern to factories:**

Convert each `db/*.js` from `setDb(db)` / module-level state to factory function. 26 modules use `setDb`; 11 are stateless utilities that just need their exports registered.

Tier order by coupling depth:

**Tier 1 — Stateless utilities (no setDb, register as-is):**
- `config-keys.js`, `query-filters.js`, `schema-seeds.js`, `schema-migrations.js`
- `schema-tables.js`, `schema.js`, `analytics-metrics.js`

**Tier 2 — DB connection only (setDb, no cross-module deps):**
- `config-core.js`, `cost-tracking.js`, `backup-core.js`
- `ci-cache.js`, `audit-store.js`, `email-peek.js`
- `peek-fixture-catalog.js`, `pack-registry.js`, `peek-policy-audit.js`
- `peek-recovery-approvals.js`, `recovery-metrics.js`, `validation-rules.js`
- `webhooks-streaming.js`, `inbound-webhooks.js`

**Tier 3 — DB + one cross-module dep:**
- `task-core.js`, `coordination.js`, `file-tracking.js`
- `host-management.js` (also fix circular require of `../database`)
- `throughput-metrics.js` (fix circular require)

**Tier 4 — DB + multiple cross-module deps:**
- `provider-routing-core.js` (fix circular require)
- `event-tracking.js`, `analytics.js`, `task-metadata.js`
- `scheduling-automation.js`, `project-config-core.js`

**Tier 5 — Special cases:**
- `host-benchmarking.js`, `host-complexity.js`, `host-selection.js`
- `budget-watcher.js`, `project-cache.js`, `provider-capabilities.js`
- `provider-performance.js`, `provider-quotas.js`, `provider-scoring.js`, `model-capabilities.js`

**Phase 2B — Eliminate _wireCrossModuleDI:**

Replace all ~30 setter injections with factory parameters. The container wires cross-module deps at registration time. `_wireCrossModuleDI()` is deleted. Split oversized db modules (>1500 lines) during this phase.

Also migrate the 2 policy-engine modules that live inside the database facade:
- `policy-engine/profile-store.js` — receives `projectConfigCore` via factory params
- `policy-engine/evaluation-store.js` — receives `db` via factory params

### Phase 3: Domain Services

- `task-manager.js` → split into `services/task-lifecycle.js` + `services/task-execution.js`, both factories
- `discovery.js` → factory
- `config.js` → factory (already started via `init({ db })`)
- `free-quota-tracker.js` → factory
- Provider modules (`providers/*.js`, `providers/adapters/*.js`) → factories
- Provider registration moves from `task-manager.initEarlyDeps()` to container
- Execution modules (26 files in `execution/`) → factories

### Phase 4: Transport, Handlers & Presentation Layer

**Phase 4A — Transports:**
- `api-server.core.js` → split into `api/server.js` + `api/route-registry.js`, convert to factory
- `mcp-sse.js` → split into `transports/sse/server.js` + `session.js` + `protocol.js`, convert to factory
- `mcp/index.js` (2007 lines) → split + factory
- `dashboard-server.js` → factory (no split needed)
- `index.js` → thin entry point, all wiring delegated to `container.boot()`

**Phase 4B — Handlers (78 files):**

Handler migration follows a common pattern — most import `database.js` + `task-manager.js` and export handler functions. Convert each to a factory receiving service deps.

Group by subdirectory:
- `handlers/task/` (6 files) — receive task-lifecycle, task-execution services
- `handlers/workflow/` (6 files) — receive workflow-engine, task services
- `handlers/peek/` (7 files) — receive peek-related db modules
- `handlers/advanced/` (6 files) — receive relevant domain services
- `handlers/integration/` (4 files) — receive routing, provider services
- `handlers/validation/` (5 files) — receive validation db modules
- Remaining top-level handlers (44 files) — individual migration

**Phase 4C — Policy engine, API routes, dashboard routes:**
- `policy-engine/engine.js` + remaining 15 files → factories
- `api/v2-*.js` (12 files) → factories
- `dashboard/routes/*.js` (4 files) → factories
- `ci/watcher.js` → factory

### Phase 5: Cutover & Cleanup

- Remove `database.js` facade (all 262 consumers migrated)
- Remove all remaining `// Phase 3` comments
- Freeze container API
- Add CI lint rule preventing `require('./database')` outside of `container.js`
- Migrate test infrastructure: `resetForTest()` → `container.resetForTest()`
- Create test helper module that boots a mini-container for unit tests
- 161 test files that import `database.js` switch to test helper
- Update CLAUDE.md to reflect new architecture
- Final review pass for any remaining personal data

---

## 5. Error Handling & Safety

### Container Safety

- `boot()` validates the full dependency graph before starting any service — missing or circular deps fail fast with a clear error
- Topological sort resolves wiring order automatically — adding a new module only requires declaring its deps, not manually inserting it into a boot sequence
- `get()` after `freeze()` is a pure lookup — no lazy initialization
- `get()` before `boot()` throws with a stack trace pointing to premature access
- If a factory throws during boot, the container logs which service failed and what deps it received, then aborts startup

### Backward Compatibility During Migration

- `database.js` re-exports everything it does today until Phase 5
- Unmigrated modules keep using `require('./database')` — no half-broken states
- Migrated modules get deps from container, unmigrated from facade — they coexist
- A migrated module must never `require('./database')` — enforced by grep/lint
- `resetForTest()` delegates to container internally but keeps the same call signature

### Testing Strategy

- Each factory is independently testable — pass mock deps, get a service, call methods, assert
- No test touches `container.boot()` except dedicated integration tests
- The existing 161 test files that import `database.js` continue working throughout by keeping the facade alive
- Each phase adds targeted tests proving the new factory contract works
- Phase 5: create a `tests/test-container.js` helper that boots a mini-container with in-memory DB
- Phase 5: integration test calls `container.boot()` and verifies every registered service is reachable
- Phase 5: migrate all 161 test files from `require('./database')` to test helper

---

## 6. Metrics

### Current State (pre-migration)

| Metric | Value |
|--------|-------|
| Source files (non-test) | 392 |
| Test files | 161 (importing database.js) / 657 total .test.js |
| Files importing `database.js` | 262 (101 source + 161 test) |
| Files importing `task-manager.js` | 64 |
| Files >1500 lines (non-test, non-schema, non-tool-defs) | 13 |
| DB sub-modules merged into facade | 47 (including 2 policy-engine modules) |
| DB sub-modules with setDb | 26 |
| Cross-module setter injections in _wireCrossModuleDI | ~30 |
| Circular requires (db → database.js) | 4 modules |
| Container-wired modules | 3 |
| Execution modules | 26 |
| Handler modules | 78 |
| Policy engine modules | 17 |

### Target State (post-migration)

| Metric | Target |
|--------|--------|
| Files importing `database.js` | 0 (facade removed) |
| Files importing `task-manager.js` as singleton | 0 (accessed via container) |
| Files >1500 lines (non-schema, non-test, non-tool-defs) | 0 |
| Circular requires | 0 |
| Container-wired services | 150+ |
| Max file size (non-schema, non-test, non-tool-defs) | ~800 lines |
| Hardcoded personal data in source | 0 |

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Regression during migration | Incremental commits, tests pass at every step, facade stays until Phase 5 |
| Circular dependency in container wiring | Boot-time topological sort + graph validation catches cycles |
| `_wireCrossModuleDI` migration complexity | Dedicated Phase 2B with documented setter chains; each setter becomes a factory param |
| `backupCore.restoreDatabase` runtime re-boot | `container.reboot(newDbPath)` replaces `setInternals` pattern |
| 161 test files importing `database.js` | Tests migrate last in Phase 5 via shared test helper; facade stays alive until then |
| Performance impact of factory pattern | Negligible — factories run once at startup, not per-request |
| Merge conflicts with concurrent work | Phase 0 (cleanup) is independent; Phases 2-4 should be the only active branch |
| Container boot function itself becoming a god function | Topological sort resolves order automatically from declared deps |
| Handler migration volume (78 files) | Common pattern — most follow the same import/export shape; batch-convertible |

---

## 8. Out of Scope

- Dashboard UI changes (purely backend architecture)
- New features or capabilities
- Contributor onboarding docs (separate effort after architecture is clean)
- Module bundling or TypeScript migration
- `db/schema-tables.js` split (declarative, no logic to decompose)
- `tool-defs/*.js` split (declarative definitions, no logic)
