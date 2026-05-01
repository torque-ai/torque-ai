# TORQUE Architecture Remediation Plan

**Date:** 2026-03-19
**Scope:** 70 architectural issues from Bug Hunt Round 2 (Track B)
**Approach:** Hybrid — clean breaks for DI and transport unification, strangler fig for god object decomposition

---

## Context

Bug Hunt Round 2 found 664 issues across architecture, security, UX, and functionality. This spec covers Track B (Architecture) — the 70 structural issues that, once resolved, reduce the blast radius of all other remediation tracks.

The architecture track is sequenced first because:
- Security (Track A) needs a single protocol handler to add auth once, not in 3 transports
- Provider/workflow (Track C) needs DI standardization to make modules independently testable
- Data layer (Track E) needs domain services as the foundation for API consistency

## Current State

| Problem | Metric |
|---------|--------|
| God objects | database.js merges 24+ sub-modules into a single facade; task-manager.js is 2793 lines coordinating 29 extracted modules |
| DI inconsistency | 3 patterns coexist: `setDb()`, `init({db})`, direct `require()` |
| Transport duplication | 3 independent MCP implementations: SSE (1696 lines), gateway (1977 lines), stdio (~93 lines protocol logic in index.js) |
| Module-level side effects | 3 early `init()` calls (lines 22-24), `_queuePollInterval` (line 2352), and 29 `init()` calls (lines 2368-2638) all execute at `require()` time in task-manager.js |
| Circular dependencies | `Object.assign(module.exports)` hack required in task-manager.js |
| Raw SQL leakage | 6 production files outside `db/` call `getDbInstance().prepare()` directly |
| Process event bus | 11 production files use `process.emit('torque:...')` for cross-module communication |

---

## Phase 1 — MCP Transport Unification

**Goal:** One protocol implementation, multiple transport adapters. SSE is the primary transport.

### 1.1 — Extract `mcp-protocol.js`

Create `server/mcp-protocol.js` containing all shared MCP protocol logic extracted from `mcp-sse.js`:
- `initialize` handshake (capabilities, server info)
- `tools/list` with tier filtering (core/extended/full)
- `tools/call` dispatch with argument validation
- `unlock_tier` / `unlock_all_tools` state management
- Shutdown signal propagation to in-flight tool calls

The protocol handler is a pure function layer: `handleMcpRequest(request, session) → response`. No HTTP, no SSE, no stdio — just JSON-RPC objects in, JSON-RPC objects out.

### 1.2 — Refactor SSE as primary transport

`mcp-sse.js` becomes a thin HTTP+SSE adapter:
- Session lifecycle (create, reconnect, destroy)
- SSE event streaming
- HTTP body parsing for POST `/messages`
- Event replay on reconnect
- Delegates all protocol logic to `mcp-protocol.js`

SSE keeps its session management, subscriptions, and notification system — those are transport-specific concerns.

### 1.3 — Reduce stdio to proxy shim

`index.js` stdio protocol logic (~93 lines in `handleRequest` + `handleToolCallRequest`) becomes ~50 lines:
- Read JSON-RPC from stdin line-by-line
- Create a virtual session object
- Call `mcp-protocol.handleMcpRequest(request, session)`
- Write response to stdout
- Forward notifications from the event bus to stdout

No tool filtering, no mode enforcement, no unlock logic — all delegated.

### 1.4 — Deprecate gateway

`mcp/index.js` (1977 lines) gets a deprecation notice. Its HTTP transport is redundant with SSE. Mark as deprecated, keep functioning, plan removal in a future release.

**Gate:** All existing MCP tool calls work identically across both transports. Test via server suite + manual verification of Claude Code sessions via stdio and SSE.

---

## Phase 2 — DI Standardization

**Goal:** One DI pattern across the entire codebase. No code executes at `require()` time.

### 2.1 — Create `server/container.js`

A lightweight composition root (~100 lines) that:
- Imports all modules
- Creates the dependency graph
- Calls `init(deps)` on each module in topological order
- Exports a `start()` function that `index.js` calls

```
container.start() →
  db.init(config)
  → serverConfig.init({ db })
  → providerRegistry.init({ db, serverConfig })
  → taskManager.init({ db, serverConfig, providerRegistry, ... })
  → mcpProtocol.init({ taskManager, tools })
  → sseTransport.init({ mcpProtocol, db })
  → stdioTransport.init({ mcpProtocol })
  → dashboard.init({ db, taskManager })
  → apiServer.init({ db, taskManager })
```

### 2.2 — Remove module-level side effects from task-manager.js

Move ALL side effects from the module body into an explicit `init(deps)` function:
- **Lines 22-24:** 3 early `init()` calls (`providerRegistry.init`, `providerCfg.init`, `serverConfig.init`) that execute on `require()`
- **Line 2352:** `_queuePollInterval = setInterval(...)` that starts a 30-second timer on `require()`
- **Lines 2368-2638:** 29 `init()` calls for extracted sub-modules

After this change, `require('./task-manager')` is a no-op — it only defines exports.

### 2.3 — Standardize database sub-module injection

Replace `_injectDbAll()` (26 `setDb()`/`setDataDir()` calls) and `_wireCrossModuleDI()` (~30 lambda wrappers) in `database.js` with the same `init(deps)` pattern. Each db sub-module gets its db reference from `container.js`, not from the database module's internal wiring.

### 2.4 — Eliminate direct `require('./database')` in 8 top-level modules

`api-server.core.js`, `config.js`, `dashboard-server.js`, `discovery.js`, `index.js`, `mcp-sse.js`, `task-manager.js`, `tools.js` all directly require database. Change each to receive `db` through `init(deps)` from the container.

### 2.5 — Fix circular dependency (partially blocked by Phase 3)

The `Object.assign(module.exports, {...})` hack in task-manager.js exists because of `dashboard/routes/tasks.js → tools.js → handlers → task-manager`. The container pattern breaks this cycle by wiring references after all modules are loaded, not during `require()`.

**Note:** Full elimination of the `Object.assign` hack requires Phase 3's reduction of task-manager.js exports. Phase 2.5 can begin (container wires late references) but cannot fully complete until the export surface stabilizes in Phase 3. This creates a partial dependency: Phase 2.5 overlaps with Phase 3.

**Gate:** Server starts cleanly. No `require()` side effects. Test: import task-manager.js without calling `init()` and confirm no DB connections or timers are created.

---

## Phase 3 — Facade Collapse + Remaining Extraction

**Goal:** The 24+ db sub-modules and 29 extracted execution modules already exist. The remaining work is: (1) collapse the database.js merge facade so callers import domain services directly, (2) extract the ~800 lines of inline logic remaining in task-manager.js into the appropriate existing modules.

### 3.1-3.2 — database.js facade collapse

database.js is already decomposed into 24+ sub-modules (`_subModules` array at line 1791): `codeAnalysis`, `costTracking`, `hostManagement`, `workflowEngine`, `fileTracking`, `schedulingAutomation`, `taskMetadata`, `coordination`, `providerRoutingCore`, `eventTracking`, `analytics`, `webhooksStreaming`, `inboundWebhooks`, `projectConfigCore`, `validationRules`, `backupCore`, `peekFixtureCatalog`, `packRegistry`, `policyProfileStore`, `policyEvaluationStore`, `auditStore`, `ciCache`, and more.

**What remains:**
1. The `_subModules` merge loop (line 1819-1830) dynamically merges all sub-module exports into a single flat namespace — this facade must be preserved during migration but eventually removed
2. `coreExports` (~50 functions at line 1747-1788) contain the task CRUD, status transitions, and config operations that are still inline in database.js — these need to move into the appropriate sub-modules
3. Callers migrate from `require('./database').someFunction` to `require('./db/specific-module').someFunction`
4. End state: `database.js` becomes ~50 lines — init, close, and a thin re-export layer for any remaining callers

**Migration strategy:** Migrate callers one file at a time. The facade re-export stays working throughout — no big bang.

### 3.3-3.4 — task-manager.js remaining extraction

task-manager.js already delegates to 29 extracted modules in `execution/`, `validation/`, `coordination/`, `maintenance/`, and `providers/`. However, ~800 lines of inline logic remain:
- `startTask` orchestration (~250 lines) — task creation, provider routing, process spawning
- `buildFileContext` and hashline enrichment (~150 lines)
- `resolveProviderRouting` and fallback logic (~200 lines)
- Inline close handler logic (~100 lines)
- Queue poll timer and misc coordination (~100 lines)

**What to do:** Move each block into the appropriate existing extracted module (e.g., `startTask` logic → `execution/task-coordinator.js` which may need to be created, routing logic → existing `execution/fallback-retry.js` or new `execution/provider-router.js`). Then task-manager.js becomes a ~200 line facade that re-exports via `task-manager-delegations.js`.

### 3.5 — Incremental caller migration

Callers continue using `require('./database')` and `require('./task-manager')` throughout the transition. As each caller is touched for other work (bug fixes, feature additions), it's updated to import from the specific sub-module instead.

**Gate:** All tests pass. database.js < 200 lines. task-manager.js < 200 lines.

---

## Phase 4 — Structural Cleanup

### 4.1 — Eliminate raw SQL outside `db/`

6 production files outside `db/` call `db.getDbInstance().prepare(...)` directly (`context-enrichment.js`, `task-manager.js`, `handlers/task/core.js`, `api/v2-task-handlers.js`, `execution/slot-pull-scheduler.js`, `handlers/integration/routing.js`). Each raw SQL call maps to a named method on the appropriate domain service:
- `db.getDbInstance().prepare('SELECT ... FROM tasks ...').all()` → `taskService.findByStatus()`
- Manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` in slot-pull-scheduler → `providerService.claimSlotAtomic()`

**Enforcement:** ESLint rule restricts `getDbInstance()` calls to files inside `server/db/`.

### 4.2 — Replace `process.emit` bus with typed event emitter

11 production files use `process.emit('torque:queue-changed')`, `process.emit('torque:shutdown')`, etc. Replace with:

```js
// server/event-bus.js
const events = new EventEmitter();
module.exports = {
  onQueueChanged: (fn) => events.on('queue-changed', fn),
  emitQueueChanged: () => events.emit('queue-changed'),
  onShutdown: (fn) => events.on('shutdown', fn),
  emitShutdown: (reason) => events.emit('shutdown', reason),
  // ... typed wrappers for each event
};
```

Discoverable, testable, type-safe. The container wires subscribers at startup.

### 4.3 — Standardize error types

Replace 4+ error patterns (`throw { code }`, `void _e`, `_softFail` flag, `safeUpdateTaskStatus`) with:
- `TorqueError` base class with `code`, `statusCode`, `isRetryable` properties
- Handlers catch `TorqueError` and map to appropriate HTTP/MCP error responses
- Silent catches get `logger.debug` with consistent error types

### 4.4 — Extract prompts to `server/prompts/`

Move the 114-line `HASHLINE_OLLAMA_SYSTEM_PROMPT` and related prompts from `task-manager.js` to `server/prompts/` directory as `.txt` or `.md` files loaded at startup. Prompt changes no longer require code changes.

### 4.5 — Timer registry

Replace manual interval cleanup in `gracefulShutdown()` (10+ named intervals) with a timer registry:

```js
// server/timer-registry.js
const timers = new Set();
module.exports = {
  track: (handle) => { timers.add(handle); return handle; },
  clearAll: () => { timers.forEach(h => clearInterval(h)); timers.clear(); },
};
```

New intervals register via `timerRegistry.track(setInterval(...))`. Shutdown calls `timerRegistry.clearAll()`.

**Gate:** Full test suite green on Omen. No `getDbInstance()` calls outside `db/`. No `process.emit('torque:...')` calls. All errors use `TorqueError` hierarchy.

---

## Execution Dependencies

```
Phase 1 (transport unification)
    → Gate: MCP tools work on both transports
Phase 2 (DI standardization) — Phase 2.5 partially overlaps Phase 3
    → Gate: no require-time side effects (except 2.5 circular dep, completed in Phase 3)
Phase 3 (facade collapse + remaining extraction)
    → Gate: database.js < 200 lines, task-manager.js < 200 lines, circular dep resolved
Phase 4 (structural cleanup)
    → Gate: full test suite green
```

## Estimated Effort

| Phase | Sessions | Risk |
|-------|----------|------|
| 1 — Transport unification | 2-3 | Low (clear extraction boundary) |
| 2 — DI standardization | 3-4 | Medium (touches every module's init) |
| 3 — Facade collapse + extraction | 3-4 | Medium (most decomposition already done) |
| 4 — Structural cleanup | 2-3 | Low (mechanical transforms) |
| **Total** | **~11-14** | |

## What This Unblocks

| Track | How architecture helps |
|-------|----------------------|
| **Security (A)** | Auth added at protocol handler layer once (Phase 1), not in 3 transports |
| **Provider/workflow (C)** | DI standardization (Phase 2) makes provider modules independently testable |
| **Dashboard UX (D)** | No dependency — can proceed in parallel |
| **Data layer + API (E)** | Domain services (Phase 3) provide clean interfaces for API consistency |
