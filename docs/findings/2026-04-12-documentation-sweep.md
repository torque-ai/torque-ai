# Documentation Sweep Findings

**Date:** 2026-04-12
**Scope:** `CLAUDE.md`, `README.md`, `docs/`, `server/docs/`, public export JSDoc in `server/index.js` and `server/container.js`
**Scanner:** TORQUE scout

## Summary

Five new documentation issues were found in the scoped files.

Items already captured in prior sweeps, especially `docs/findings/2026-04-05-documentation-sweep.md`, were not re-reported here. That includes the stale legacy REST reference, stale tool-reference coverage, old provider examples, and the earlier setup-guide/provider-guide drift.

I did not find any new broken tracked local markdown links in `README.md`, `CLAUDE.md`, `docs/`, or `server/docs/`.

## Findings

### F-DOC-14: `docs/architecture.md` describes the MCP extension path and inventory incorrectly (HIGH)

**Location:** `docs/architecture.md:21-22`, `docs/architecture.md:92`, `docs/architecture.md:432`

**Problem:** The architecture overview still tells contributors that tool exposure is effectively automatic from handler exports and that `server/tool-defs/` is much smaller than it is now.

**Evidence:**
- The diagram labels `tools.js` as `500+ tools` with `pascalToSnake auto-mapping`.
- The narrative says adding a new `handleFoo` export "automatically creates" a `foo` MCP tool.
- The module inventory still says `server/tool-defs/` contains `24 files`.
- The live implementation in `server/tools.js:26-71` now assembles the built-in catalog from an explicit `TOOLS` array of imported definition modules, and `server/tools.js:115-153` enumerates handler modules explicitly.
- `server/tools.js:276-287` also manually registers several tool names with `routeMap.set(...)`, so handler export naming is no longer a complete description of how tools become public.
- The current `server/tool-defs/` directory contains `44` JavaScript definition files, not `24`.

**Impact:** Maintainers following the architecture doc can add a handler and still fail to expose a tool correctly, because the document no longer reflects the actual registration path or surface size.

**Status:** ACTIONABLE

### F-DOC-15: `server/docs/architecture.md` still documents retired modules and an older runtime shape (MEDIUM)

**Location:** `server/docs/architecture.md:48`, `server/docs/architecture.md:112`, `server/docs/architecture.md:117`, `server/docs/architecture.md:235-241`, `server/docs/architecture.md:311-312`

**Problem:** The server architecture reference still points readers at removed files and older counts, and it over-centers the pre-slot-pull queue description.

**Evidence:**
- The server core table still says `tools.js` contains `462` MCP tool schemas, but the live built-in catalog in `server/tools.js` now contains `582` built-in tools.
- The provider execution table still lists `execute-hashline.js`, but `server/providers/` only contains `execute-api.js`, `execute-cli.js`, and `execute-ollama.js`.
- The database section says `server/db/` contains `52 modules`, while the current tree contains `75` files under `server/db/`.
- The queue section describes the runtime as `processQueue()` plus distributed locking, but the current scheduler also branches into slot-pull mode in `server/execution/queue-scheduler.js:668-669` and `server/execution/slot-pull-scheduler.js`.

**Impact:** Engineers using the server architecture page as the source of truth will be sent to missing files, stale counts, and an outdated mental model of the current scheduler/runtime split.

**Status:** ACTIONABLE

### F-DOC-16: `server/docs/guides/workflows.md` documents a `resume_workflow` tool that does not exist (CRITICAL)

**Location:** `server/docs/guides/workflows.md:176`

**Problem:** The workflow guide includes a copy-paste example for `resume_workflow`, but there is no live MCP tool or REST route by that name.

**Evidence:**
- The guide shows `resume_workflow { workflow_id: "<workflow-id>" }`.
- The live workflow tool definitions in `server/tool-defs/workflow-defs.js` include `pause_workflow` (`server/tool-defs/workflow-defs.js:406`) but no `resume_workflow`.
- The live REST workflow routes include `POST /api/workflows/:id/pause` (`server/api/routes.js:1241`) but no matching resume route.
- A repo-wide route/schema scan of `server/tool-defs/*.js`, `server/api/routes.js`, `server/api-server.core.js`, and `server/dashboard/router.js` found no `resume_workflow` implementation.

**Impact:** Users copying the published workflow recovery example will get an immediate tool-not-found failure.

**Status:** ACTIONABLE

### F-DOC-17: Contributor onboarding is stale for adding tools and still lacks a maintainer guide for adding providers/plugins (HIGH)

**Location:** `CONTRIBUTING.md:25`, `CONTRIBUTING.md:31-38`, `CONTRIBUTING.md:67-72`, `README.md:104-107`, `server/docs/README.md:45-55`, `CLAUDE.md:28-30`

**Problem:** The only contributor-facing authoring instructions are outdated for tool work, and the indexed docs still do not provide an actual maintainer guide for provider or plugin authoring.

**Evidence:**
- `CONTRIBUTING.md` still says Node.js `18+`, but both package manifests require Node `>=20.0.0` (`package.json:18-20`, `server/package.json:47-49`).
- The same architecture snippet still says `10 execution providers`, `22 tool definition files`, and `15 database sub-modules`, while the live registry/file inventory is now `13` providers in `server/providers/registry.js:22-36`, `44` tool-def files, and `75` files under `server/db/`.
- The "Adding Tools" section still says to add `server/tool-defs/<name>.js`, implement `server/handlers/<name>.js`, and rely on `server/tools.js` route-map auto-wiring. In reality, `server/tools.js:26-71` requires explicit inclusion in the `TOOLS` array, `server/tools.js:115-153` enumerates handler modules explicitly, and `server/tools.js:276-287` adds some public tools manually.
- The indexed docs in `README.md` and `server/docs/README.md` link setup/provider/runtime references, but they do not expose any maintainer guide for adding a new provider or plugin.
- `CLAUDE.md` only gives a brief plugin-contract summary, while the real extension points live in `server/providers/registry.js`, `server/plugins/plugin-contract.js`, and `server/plugins/loader.js`.

**Impact:** New contributors can follow incorrect steps for adding a tool, and there is no published maintainer path for extending TORQUE with a new provider or plugin without reading implementation code.

**Status:** ACTIONABLE

### F-DOC-18: Public exports in `server/index.js` and `server/container.js` still lack JSDoc coverage (MEDIUM)

**Location:** `server/index.js:32-33`, `server/index.js:1643`, `server/index.js:1702-1719`, `server/container.js:198`, `server/container.js:571`, `server/container.js:579-583`

**Problem:** Several public exports named in this sweep's scope are exposed without adjacent JSDoc, leaving the external module surface only discoverable by reading implementation code.

**Evidence:**
- `server/index.js` exports `getTools`, `callTool`, and `getTestRunnerRegistry`, but those functions are declared without `/** ... */` documentation blocks before their definitions.
- `server/index.js:1702-1719` also exports additional lifecycle helpers such as `startMaintenanceScheduler`, `startCoordinationScheduler`, `startProviderQuotaInferenceTimer`, and `getAutoArchiveStatuses` without module-level API documentation describing their public contract.
- `server/container.js` exports `initModules` and `getModule`, but neither function has JSDoc before its definition.
- `server/api.js` does not exist, so the public-export JSDoc surface for this sweep is effectively concentrated in `server/index.js` and `server/container.js`.

**Impact:** Internal embedders, tests, and future docs work have to infer behavior from source instead of reading stable API documentation on the exported surface.

**Status:** ACTIONABLE
