# Quality Sweep
Date: 2026-04-12
Variant: quality
Scope: `server/`, `dashboard/`, `scripts/`
Agent: TORQUE Scout

## Baseline
- Reviewed prior findings under `docs/findings/` and skipped already-documented items such as the older handler/execution DI bypasses, the `handleSmartSubmitTask` hotspot, the existing `executeOllamaTask()` complexity report, and the dashboard plan-import temp-file issue.
- Ran `npm run lint:di` in `server/` for the DI migration baseline.
- Ran `npm run lint` in `server/` and `dashboard/` to surface dead code, validation drift, and runtime regressions.
- Excluded generated output under `dashboard/dist/`.

## Summary
6 new findings: 3 critical, 2 high, 1 low.

## CRITICAL

### `executeOllamaTask()` uses `taskMetadataParsed` outside its block scope
File: `server/providers/execute-ollama.js:450-457,517,544`
Description: `taskMetadataParsed` is declared with `let` inside the `if (adaptiveContextEnabled)` block, but the function later uses it unconditionally when building the prompt and re-applying study context. That means the runtime path can throw `ReferenceError: taskMetadataParsed is not defined` before the Ollama request is sent. This is separate from the already-documented size/complexity problem in the same function: the prompt construction path is currently incorrect.
Status: NEW
Suggested fix: Hoist metadata parsing above the adaptive-context branch so the variable exists for the entire function, then reuse that parsed object in both the adaptive sizing and prompt-building paths.

### The `database.js` read-only recovery path cannot reach its fallback directory
File: `server/database.js:567-571`
Description: The `SQLITE_READONLY` fallback path calls `os.tmpdir()` and `ensureWritableDataDir(fallbackDir)`, but this file never imports `os` and does not define or import `ensureWritableDataDir`. When the read-only path is hit, the intended recovery branch throws a new `ReferenceError` instead of relocating the DB to a writable temp directory.
Status: NEW
Suggested fix: Import the missing dependency/dependencies before this path runs, or move the writable-directory fallback behind a single helper exported from `data-dir.js` and reuse that helper here.

### Provider enable/disable endpoints coerce `"false"` to enabled state
File: `server/api/v2-governance-handlers.js:1167-1172,1300-1307`; `server/db/provider-routing-core.js:179-183,270-295`
Description: `handleProviderToggle()` converts any supplied `enabled` value with `Boolean(body.enabled)`, and `handleConfigureProvider()` forwards `body.enabled` without validation. `provider-routing-core` then normalizes stored values with `Boolean(provider.enabled)`. A JSON payload like `{ "enabled": "false" }` therefore stores a truthy string and later reads back as enabled. This is a public REST validation bug, not just a style issue. The same handler also accepts `timeout_minutes`, but `updateProvider()` silently ignores it because the persistence whitelist does not include that field.
Status: NEW
Suggested fix: Parse and validate `enabled` as a strict boolean at the REST boundary, reject non-boolean values, and keep the accepted REST fields in sync with the `updateProvider()` whitelist.

## HIGH

### Newer governance/study/factory modules are reintroducing direct `database.js` imports outside the container
File: `server/dashboard/routes/admin.js:7`; `server/api/v2-governance-handlers.js:13`; `server/db/study-telemetry.js:5`; `server/factory/cost-metrics.js:3`; `server/factory/feedback.js:413-416`; `server/handlers/codebase-study-handlers.js:35-41`
Description: `npm run lint:di` still reports 17 source files importing `database.js` directly, and several of the remaining offenders are newer governance/study/factory modules that were not covered in the older quality sweeps. These modules now mix top-level facade imports, container lookups with `require('../database')` fallbacks, and ad-hoc raw DB fetches. That pattern is the opposite of the container contract in `server/container.js`, so the DI migration keeps regressing in new surface area.
Status: NEW
Suggested fix: Convert these modules to `init(deps)` or `createXxx(deps)` factories, inject `db` or the specific db sub-modules from `container.js`, and remove the direct `database.js` fallbacks.

### `server/integrations/codebase-study.js` has become a 4,791-line god module
File: `server/integrations/codebase-study.js:1-4791`; `server/integrations/codebase-study.js:142`
Description: The codebase-study subsystem now lives in a single 4,791-line file, with `createCodebaseStudy()` owning repo scanning, study profile resolution, symbol extraction, evaluation/benchmarking, proposal submission, and language-specific parsing in one closure. The server lint baseline is already showing stale/unused symbols inside this file (`sanitizeStudyProfileOverride` import and multiple unused callback args), which is a typical signal that the module boundary is too large to reason about cleanly. This hotspot was not called out in the 2026-04-04/2026-04-05 quality sweeps.
Status: NEW
Suggested fix: Split the study subsystem into focused modules such as repository scanning/indexing, artifact/evaluation logic, proposal scheduling, and language-specific symbol extraction, then keep `createCodebaseStudy()` as a thin orchestrator.

## LOW

### `ProjectSelector.jsx` mixes reusable helpers with the component and keeps dashboard lint red
File: `dashboard/src/components/ProjectSelector.jsx:41,105,152,168`
Description: `dashboard/src/components/ProjectSelector.jsx` exports `parseMarkdownTable`, `normalizeProjectListPayload`, and `fetchProjects` from the same file as the React component. `npm run lint` in `dashboard/` fails `react-refresh/only-export-components` three times for this module, so fast-refresh correctness now depends on a mixed utility/component file. The coupling is already visible because `ProjectSettings.jsx` imports `parseMarkdownTable` from the component module.
Status: NEW
Suggested fix: Move the parsing/fetch helpers into a sibling utility module and keep `ProjectSelector.jsx` exporting only React components.
