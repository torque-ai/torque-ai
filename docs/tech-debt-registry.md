# TORQUE Tech Debt Registry

Generated: 2026-03-19
Source: Bug hunt analysis of 156K lines across 469 issues found

This registry tracks ~313 low-severity issues identified during the comprehensive bug hunt.
These are intentionally deferred — they don't cause outages, data loss, or security breaches,
but represent opportunities for future cleanup sprints.

## How to use this registry
- Pick a category during a quiet sprint
- Fix items in batches (they're often repetitive patterns)
- Remove entries as they're fixed
- Add new items as they're discovered

---

## 1. Dead Code (~40 items)

| File | Line | Description |
|------|------|-------------|
| `server/api-server.core.js` | 9 | Commented-out `require('https')` — removed but comment left in place |
| `server/task-manager.js` | 390 | Comment block "Secret sanitization constants moved to output-safeguards.js (unused here)" — remove dead comment |
| `server/task-manager.js` | 1155 | Large comment block `/* ---- REMOVED: buildAiderCommand body ... ----` — leftover tombstone |
| `server/providers/adapters/google-chat.js` | 37 | JSDoc `@param {Object} [params.options]` marked "currently unused" — param never wired |
| `server/db/migrations.js` | 17 | Migration named `remove_unused_notification_templates` — migration function may be orphaned if templates are gone |
| `server/db/code-analysis.js` | 119 | `type: 'unused_function'` detected by code analysis — ironic that the analyzer itself has unreachable paths in its result-building logic |
| `server/api/routes.js` | 124 | Comment "removed because they shadowed the CP routes" — tombstone comment with no code left |
| `server/db/scheduling-automation.js` | 91 | `safeJsonParse` local copy flagged "avoids importing from database.js" — circular dep should be resolved at module level instead |
| `server/providers/config.js` | 7 | Comment notes "Context enrichment flags was duplicated 4× across 3 files" — consolidation comment but duplication still exists in some paths |
| `server/db/host-complexity.js` | 89 | `// eslint-disable-next-line no-control-regex` — could use named constant instead of suppression |
| `server/execution/workflow-runtime.js` | 499 | `// eslint-disable-next-line no-control-regex` first occurrence — should use named regex constant |
| `server/execution/workflow-runtime.js` | 502 | `// eslint-disable-next-line no-control-regex` second occurrence — duplicate suppression |
| `server/handlers/shared.js` | 592 | `// eslint-disable-next-line no-control-regex` first occurrence |
| `server/handlers/shared.js` | 602 | `// eslint-disable-next-line no-control-regex` second occurrence |
| `server/handlers/economy-handlers.js` | 139 | `// eslint-disable-next-line global-require` — dynamic require inside function, candidate for refactor |
| `server/tests/agentic-routing.test.js` | 148 | `// eslint-disable-next-line eqeqeq` — indicates a loose equality comparison that should be strict |
| `server/remote/agent-client.js` | 44 | `// eslint-disable-next-line no-console` — no-console suppression; should use structured logger |
| `server/api/v2-middleware.js` | 192 | `try { require('../logger').debug(...) } catch {}` — empty catch silently swallows logger errors in error handler |
| `server/api/v2-middleware.js` | 198 | Second `try { require('../logger').debug(...) } catch {}` — same pattern repeated |
| `server/api/v2-task-handlers.js` | 205 | `try { db.deleteTask(taskId); } catch {}` — silent deletion failure in cleanup |
| `server/api/v2-task-handlers.js` | 416 | `try { db.deleteTask(newTaskId); } catch {}` — same pattern repeated |
| `server/execution/command-builders.js` | 75 | `buildCodexCommand` defined here AND at `providers/execute-cli.js:163` — two independent implementations |
| `server/db/analytics.js` | 30 | `safeJsonParse` defined locally — 17th copy (see category 5) |
| `server/db/file-quality.js` | 40 | `file_extensions LIKE ?` without ESCAPE clause — not exploitable here but inconsistent with other queries |
| `server/db/file-tracking.js` | 224 | `file_extensions LIKE ?` without ESCAPE clause |
| `server/db/file-tracking.js` | 374 | Third `file_extensions LIKE ?` without ESCAPE clause |
| `server/db/coordination.js` | 170 | `capabilities LIKE ?` without ESCAPE clause — parameter constructed as `%"${capability}"%`, user-controlled |
| `server/logger.js` | 224 | `// TODO: share size counter between parent and child loggers` — acknowledged design flaw |
| `server/handlers/concurrency-handlers.js` | 60 | `// TODO: replace with db.listProviderConfigs() abstraction` — direct DB query bypassing abstraction |
| `server/dashboard/dashboard.js` | 4 | Uses `var` throughout (lines 4–30) — pre-ES6 style in an otherwise modern codebase |
| `server/dashboard/dashboard.js` | 5 | `var POLL_INTERVAL = 10000` — 10-second fallback poll interval defined as `var` |
| `server/execution/slot-pull-scheduler.js` | 80 | Inline try/catch JSON parse — same pattern repeated across 25+ files (see category 5) |
| `server/handlers/workflow/await.js` | 169 | `formatDuration` defined locally — duplicate of `handlers/workflow/dag.js:33` |
| `server/handlers/task/core.js` | 369 | Double metadata parse in same function — parses `taskRow2.metadata` then `taskRow.metadata` independently |
| `server/handlers/task/core.js` | 382 | Second metadata parse in same function (see line 369) |
| `server/api/v2-analytics-handlers.js` | 556 | Inline try/catch in `.filter()` callback — one-liner with silenced error |
| `server/api-server.core.js` | 2208 | Same inline try/catch in `.filter()` callback — copy of above |
| `server/dashboard/routes/analytics.js` | 703 | Third copy of the inline try/catch `.filter()` pattern |
| `server/db/analytics.js` | 968 | `WHERE enabled = 1 AND ? LIKE '%' || error_pattern || '%'` — reversed LIKE (searching for value that contains pattern); confusing intent |
| `server/api/v2-control-plane.js` | 54 | Metadata parse without try/catch — unprotected JSON.parse |

---

## 2. Naming Inconsistencies (~30 items)

| File | Line | Description |
|------|------|-------------|
| `server/tool-defs/task-defs.js` | 15 | Description says "Maximum concurrent **Codex** instances" — should say "TORQUE" or "provider" |
| `server/tool-defs/task-defs.js` | 161 | Tool description "Get analytics and statistics about **Codex** task history" — should be "TORQUE task history" |
| `server/tool-defs/task-defs.js` | 338 | Tool description "Run a health check on **Codex** CLI" — Codex is one provider, not the system |
| `server/tool-defs/task-management-defs.js` | 27 | Description "Auto-approve **Codex** actions" — should be "provider actions" |
| `server/tool-defs/task-management-defs.js` | 256 | Tool description "Analyze a task to determine if it should be delegated to **Codex** or kept for Claude" — Codex-centric framing |
| `server/tool-defs/task-management-defs.js` | 858 | Description "routing: simple→Laptop, normal→Desktop, complex→**Codex**" — machine names are internal; misleading to users |
| `server/tool-defs/automation-defs.js` | 225 | Description "Codex queue depth exceeds the threshold" — Codex-centric, should say "provider queue" |
| `server/tool-defs/automation-defs.js` | 230 | Description "when more than N **Codex** tasks are queued" |
| `server/tool-defs/webhook-defs.js` | 389 | Description "free_tier_task: route to free-tier providers, skipping **Codex** entirely" — Codex-centric routing description |
| `server/tool-defs/advanced-defs.js` | 131 | Description "Auto-approve **Codex** actions" — duplicate of task-management-defs naming issue |
| `server/tool-defs/provider-defs.js` | 11 | Description "switching a task from its current provider (e.g., **Codex**) to an alternative" — fine as example but naming pattern inconsistent across tool descriptions |
| `server/api/v2-analytics-handlers.js` | 556 | `m?.intended_provider === 'codex'` — lowercase string used directly instead of provider constant |
| `server/api-server.core.js` | 2208 | Same `intended_provider === 'codex'` — string literal instead of constant |
| `server/dashboard/routes/analytics.js` | 703 | Third occurrence of `intended_provider === 'codex'` string literal |
| `server/handlers/ci-handlers.js` | 63 | Accepts both `args.poll_interval_ms` and `args.pollIntervalMs` — camelCase/snake_case dual-accept pattern |
| `server/ci/watcher.js` | 382 | `options.pollIntervalMs || options.poll_interval_ms` — same dual-accept pattern in watcher |
| `server/tool-defs/workflow-defs.js` | 776 | Parameter `poll_interval_ms` (snake_case) but description says "poll interval in ms" — fine but handlers accept both forms |
| `server/tool-defs/workflow-defs.js` | 799 | Second `poll_interval_ms` in `await_task` — same inconsistency |
| `server/tool-defs/task-submission-defs.js` | 42 | Provider description lists providers in prose, not matching enum order |
| `server/providers/execute-cli.js` | 5 | File comment says "Contains buildAiderOllamaCommand, buildClaudeCliCommand, buildCodexCommand" but `buildCodexCommand` is also in `execution/command-builders.js` — misleading comment |
| `server/db/scheduling-automation.js` | 91 | `safeJsonParse` has different parameter name `defaultValue` vs `project-config-core.js` which uses `fallback` |
| `server/db/project-cache.js` | 46 | `safeJsonParse(str, fallback)` — parameter named `str` not `value` like other copies |
| `server/handlers/provider-crud-handlers.js` | 30 | `safeJsonParse(value, fallback = {})` — default is `{}` not `null` like other copies |
| `server/policy-engine/adapters/release-gate.js` | 30 | `safeJsonParse(value, fallback = {})` — same inconsistency |
| `server/db/pack-registry.js` | 11 | `safeJsonParse(value, defaultValue)` — no default value unlike most copies |
| `server/db/peek-fixture-catalog.js` | 75 | `safeJsonParse(value, defaultValue)` — same missing default |
| `server/workstation/model.js` | 14 | `safeJsonParse(value, fallback)` — yet another signature variant |
| `server/tool-defs/automation-defs.js` | 13 | `provider` enum in `configure_stall_detection` includes `'all'` — `'all'` is not a provider name |
| `server/execution/queue-scheduler.js` | 320 | Variable `observedRunningByProvider` vs `providerRunningCache` — two Maps tracking similar data with different naming conventions |
| `server/execution/queue-scheduler.js` | 321 | `providerLimitCache` vs `providerRunningCache` — inconsistent `Cache` vs `ByProvider` suffix pattern |

---

## 3. Missing Documentation (~25 items)

| File | Line | Description |
|------|------|-------------|
| `server/tool-defs/task-submission-defs.js` | 20 | `timeout_minutes` has no `minimum` or `maximum` — docs say "default: 30" but valid range not documented |
| `server/tool-defs/task-submission-defs.js` | 72 | `context_depth` has no `minimum`, `maximum`, or `enum` — valid values are 1 or 2 |
| `server/tool-defs/advanced-defs.js` | 134 | `timeout_minutes` in `await_task` — same missing range as above |
| `server/tool-defs/workflow-defs.js` | 775 | `timeout_minutes` in `await_workflow` — "max: 60" mentioned in description but no `maximum` constraint |
| `server/tool-defs/workflow-defs.js` | 776 | `poll_interval_ms` — description says "Usually not needed" but no `minimum` guard against 0 |
| `server/tool-defs/workflow-defs.js` | 798 | Second `timeout_minutes` in await_task variant — same missing maximum |
| `server/tool-defs/workflow-defs.js` | 799 | Second `poll_interval_ms` — same |
| `server/tool-defs/task-management-defs.js` | 20 | `timeout_minutes` in task configure — no range constraint |
| `server/tool-defs/task-management-defs.js` | 390 | `timeout_minutes` in a second task-management tool — no range constraint |
| `server/tool-defs/task-defs.js` | 210 | `timeout_minutes` — no minimum/maximum |
| `server/tool-defs/ci-defs.js` | 33 | `timeout_minutes` — no minimum/maximum |
| `server/tool-defs/integration-defs.js` | 452 | `timeout_minutes` — no minimum/maximum |
| `server/tool-defs/integration-defs.js` | 464 | `context_depth` — no minimum/maximum or enum |
| `server/tool-defs/integration-defs.js` | 472 | `context_budget` — no minimum/maximum; valid range is token-budget-dependent |
| `server/tool-defs/workstation-defs.js` | 24 | `max_concurrent` has default but no `minimum: 1` or `maximum` |
| `server/tool-defs/provider-defs.js` | 1050 | `max_concurrent` description "Set to 0 for unlimited" — special meaning of 0 not reflected in schema |
| `server/tool-defs/concurrency-defs.js` | 12 | `vram_factor` scope documented as "(0.50-1.00)" in description but no schema constraints |
| `server/tool-defs/orchestrator-defs.js` | 14 | `strategic_provider` enum only allows deepinfra/hyperbolic — not documented why other cloud providers excluded |
| `server/tool-defs/automation-defs.js` | 59 | `provider` lists 13 values in description text but enum only validates against those 13 — good, but description text can drift |
| `server/tool-defs/task-submission-defs.js` | 95 | `routing_template` description lists "Available: System Default, Quality First, ..." — hard-coded in description, will go stale |
| `server/tool-defs/advanced-defs.js` | 50 | `required: []` on `scan_project` — `working_directory` is de-facto required (defaults to cwd but behavior differs) |
| `server/tool-defs/advanced-defs.js` | 78 | `required: []` on `list_tasks` — `status` filter is optional but commonly expected |
| `server/tool-defs/intelligence-defs.js` | 21 | `required: []` with no description of which params are recommended |
| `server/tool-defs/intelligence-defs.js` | 35 | Second intelligence tool with `required: []` |
| `server/tool-defs/audit-defs.js` | 75 | `required: []` on audit tool — no indication of recommended inputs |

---

## 4. Minor Validation Gaps (~35 items)

| File | Line | Description |
|------|------|-------------|
| `server/tool-defs/task-defs.js` | 22 | `check_status` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 128 | `cancel_task` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 171 | `get_task_result` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 285 | `retry_task` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 324 | `get_task_output` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 333 | `approve_task` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 353 | `pause_task` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 373 | `resume_task` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 397 | `delete_task` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-defs.js` | 557 | `import_data` — `required: []` but `data` or `file_path` should be required |
| `server/tool-defs/task-defs.js` | 602 | `bulk_import_tasks` — `required: []` but `tasks` array should be required |
| `server/tool-defs/task-defs.js` | 729 | `await_ci_run` — `required: []` but `watch_id` or `run_id` is de-facto required |
| `server/tool-defs/task-management-defs.js` | 52 | `configure_task` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-management-defs.js` | 136 | `set_task_priority` — `required: []` but `task_id` and `priority` are required |
| `server/tool-defs/task-management-defs.js` | 334 | `strategic_review` — `required: []` but `task_id` is de-facto required |
| `server/tool-defs/task-management-defs.js` | 349 | `strategic_diagnose` — `required: []` but requires some identifying input |
| `server/tool-defs/task-management-defs.js` | 446 | `remove_workstation` — `required: []` but `workstation_id` is required |
| `server/tool-defs/task-management-defs.js` | 505 | `delete_routing_template` — `required: []` but `template_id` is required |
| `server/tool-defs/webhook-defs.js` | 60 | `create_webhook` — `required: []` but `url` and `event_types` are required |
| `server/tool-defs/webhook-defs.js` | 116 | `update_webhook` — `required: []` but `webhook_id` is required |
| `server/tool-defs/webhook-defs.js` | 145 | `delete_webhook` — `required: []` but `webhook_id` is required |
| `server/tool-defs/webhook-defs.js` | 201 | `trigger_webhook` — `required: []` but `webhook_id` is required |
| `server/tool-defs/workflow-defs.js` | 80 | `create_workflow` — `required: []` but `name` is de-facto required |
| `server/tool-defs/workflow-defs.js` | 409 | `add_workflow_task` — `required: []` but `workflow_id` and `description` are required |
| `server/tool-defs/workflow-defs.js` | 526 | `cancel_workflow` — `required: []` but `workflow_id` is required |
| `server/tool-defs/workflow-defs.js` | 590 | `delete_workflow` — `required: []` but `workflow_id` is required |
| `server/tool-defs/integration-defs.js` | 140 | `add_ollama_host` — `required: []` but `url` and `name` are required |
| `server/tool-defs/integration-defs.js` | 190 | `remove_ollama_host` — `required: []` but `host_id` is required |
| `server/tool-defs/integration-defs.js` | 244 | `set_host_memory_limit` — `required: []` but `host_id` and `limit_gb` are required |
| `server/tool-defs/provider-defs.js` | 898 | `update_provider` — `required: []` but `provider` name is required |
| `server/tool-defs/orchestrator-defs.js` | 57 | `ping` — `inputSchema: { type: 'object', properties: {}, required: [] }` is fine but could be `null` schema |
| `server/tool-defs/orchestrator-defs.js` | 70 | `restart_server` — same empty schema |
| `server/tool-defs/core-defs.js` | 38 | `unlock_tier` — `required: []` but `tier` is required |
| `server/api/v2-control-plane.js` | 54 | Metadata JSON.parse without try/catch — no validation before parse |
| `server/providers/execute-api.js` | 247 | Metadata JSON.parse without try/catch — same pattern |

---

## 5. Code Duplication (~20 items)

| File | Line | Description |
|------|------|-------------|
| `server/db/analytics.js` | 30 | `safeJsonParse` copy 1 of 17 — should import from `utils/json.js` |
| `server/db/coordination.js` | 25 | `safeJsonParse` copy 2 of 17 |
| `server/db/event-tracking.js` | 24 | `safeJsonParse` copy 3 of 17 |
| `server/db/file-baselines.js` | 27 | `safeJsonParse` copy 4 of 17 |
| `server/db/host-benchmarking.js` | 41 | `safeJsonParse` copy 5 of 17 |
| `server/db/pack-registry.js` | 11 | `safeJsonParse` copy 6 of 17 (different signature: no default) |
| `server/db/peek-fixture-catalog.js` | 75 | `safeJsonParse` copy 7 of 17 |
| `server/db/project-cache.js` | 46 | `safeJsonParse` copy 8 of 17 (param named `str` not `value`) |
| `server/db/project-config-core.js` | 69 | `safeJsonParse` copy 9 of 17 |
| `server/db/scheduling-automation.js` | 91 | `safeJsonParse` copy 10 of 17 — comment acknowledges the circular dep reason |
| `server/db/task-metadata.js` | 30 | `safeJsonParse` copy 11 of 17 |
| `server/db/webhooks-streaming.js` | 49 | `safeJsonParse` copy 12 of 17 |
| `server/handlers/provider-crud-handlers.js` | 30 | `safeJsonParse` copy 13 of 17 (default `{}` not `null`) |
| `server/policy-engine/adapters/release-gate.js` | 30 | `safeJsonParse` copy 14 of 17 |
| `server/workstation/model.js` | 14 | `safeJsonParse` copy 15 of 17 |
| `server/utils/json.js` | 5 | `safeJsonParse` — the canonical implementation; all others should import from here |
| `server/utils/context-enrichment.js` | 20 | `SENSITIVE_FILE_PATTERNS` — comment says "Mirrors SENSITIVE_FILE_PATTERNS from context-stuffing.js" |
| `server/utils/context-stuffing.js` | 19 | `SENSITIVE_FILE_PATTERNS` canonical definition — enrichment.js should import this |
| `server/providers/execute-cli.js` | 163 | `buildCodexCommand` — duplicate of `execution/command-builders.js:75` |
| `server/handlers/workflow/await.js` | 169 | `formatDuration(ms)` — duplicate of `handlers/workflow/dag.js:33` (different units: ms vs seconds) |

---

## 6. Minor Accessibility (~15 items)

| File | Line | Description |
|------|------|-------------|
| `dashboard/src/views/Budget.jsx` | 379 | `<Cell key={index} ...>` — uses array index as React key; reordering will cause incorrect diffs |
| `dashboard/src/views/Providers.jsx` | 647 | `<Cell key={index} ...>` — same index-as-key pattern |
| `dashboard/src/components/KeyboardShortcuts.jsx` | 125 | Overlay `div` with `onClick={onClose}` has no `role="dialog"` or `aria-modal` attribute |
| `dashboard/src/components/KeyboardShortcuts.jsx` | 126 | Inner content `div` has no `aria-label` or `aria-labelledby` |
| `dashboard/src/views/Hosts.jsx` | 714 | Modal overlay `div` with `onClick={onClose}` missing `role="dialog"` and `aria-modal` |
| `dashboard/src/views/Hosts.jsx` | 1448 | Confirm-remove workstation modal overlay `div` — missing `role="dialog"` |
| `dashboard/src/views/Hosts.jsx` | 1479 | Confirm-remove peek modal overlay `div` — missing `role="dialog"` |
| `dashboard/src/views/Hosts.jsx` | 1495 | Confirm-remove host modal overlay `div` — missing `role="dialog"` |
| `dashboard/src/views/StrategicConfig.jsx` | 135 | `div` with `onClick={onClose}` — backdrop div missing `role` and `aria-label` |
| `dashboard/src/views/Workstations.jsx` | 399 | Confirm-remove workstation modal overlay `div` — missing `role="dialog"` |
| `dashboard/src/views/Kanban.jsx` | 435 | `aria-expanded={collapsed ? 'false' : undefined}` — passing string `'false'` instead of boolean `false`; undefined when not collapsed |
| `dashboard/src/components/WorkflowDAG.jsx` | 110 | `addEventListener('wheel', handleWheel, { passive: false })` — non-passive wheel listener blocks scroll; consider whether prevent-default is truly needed |
| `dashboard/src/views/Kanban.jsx` | 80 | `Date.now()` called inline in non-memoized helper — creates new value on every render |
| `dashboard/src/views/Kanban.jsx` | 922 | `const now = Date.now()` inside render callback — should be from the component-level `now` state |
| `dashboard/src/views/Hosts.jsx` | 201 | `Date.now()` called inline — not memoized, recalculates on every render |

---

## 7. Test Quality (~20 items)

| File | Line | Description |
|------|------|-------------|
| `server/tests/adapter-registry.test.js` | 5 | `require.cache` manipulation for module mocking — brittle, breaks in parallel test runs |
| `server/tests/advanced-approval.test.js` | 7 | `require.cache` manipulation — same brittleness |
| `server/tests/advanced-artifacts-handlers.test.js` | 127 | `require.cache` manipulation with manual cleanup — fragile cleanup pattern |
| `server/tests/advanced-artifacts.test.js` | 14 | `require.cache` manipulation |
| `server/tests/advanced-debugger-handlers.test.js` | 39 | `require.cache` manipulation |
| `server/tests/advanced-debugger.test.js` | — | `require.cache` manipulation (confirmed by file pattern) |
| `server/tests/advanced-intelligence-handlers.test.js` | — | `require.cache` manipulation |
| `server/tests/advanced-intelligence.test.js` | — | `require.cache` manipulation |
| `server/tests/advanced-performance.test.js` | — | `require.cache` manipulation |
| `server/tests/advanced-scheduling.test.js` | — | `require.cache` manipulation |
| `dashboard/src/views/Budget.test.jsx` | 24 | `summary: vi.fn()`, `status: vi.fn()`, `forecast: vi.fn()` — mock fns set up but no `toHaveBeenCalled` assertions in file |
| `dashboard/src/App.test.jsx` | 22 | Large mock object with many `vi.fn()` entries — several mocks never asserted (e.g., `diff`, `retry`, `approveSwitch`) |
| `dashboard/src/App.test.jsx` | 384 | Test "creates and clears one host activity polling interval" — validates timer setup, not business logic |
| `server/tests/code-analysis.test.js` | 158 | Test fixture contains `try {} catch (e) {}` as an example — empty catch in test fixture |
| `server/tests/dashboard-analytics-routes.test.js` | 369 | `Array.from({ length: 12 }, (_unused, index) =>` — `_unused` prefix suppresses lint but indicates dead parameter |
| `server/tests/peek-compliance-handlers.test.js` | 286 | `function safeJsonParse` defined locally inside test file — yet another copy |
| `dashboard/e2e/dashboard.spec.js` | 466 | `await expect(page.locator('text=TORQUE')).toBeVisible()` — tests presence of static text, not behavior |
| `dashboard/e2e/dashboard.spec.js` | 503 | `await expect(page.locator('h2', { hasText: 'Task History' })).toBeVisible()` — heading presence not behavior |
| `dashboard/e2e/dashboard.spec.js` | 508 | `await expect(first row).toBeVisible({ timeout: 10000 })` — 10s hard-coded timeout |
| `dashboard/e2e/dashboard.spec.js` | 579 | `await expect(badges.first()).toBeVisible()` — asserts first badge visible, not that correct badge is shown |

---

## 8. Minor Performance (~15 items)

| File | Line | Description |
|------|------|-------------|
| `server/dashboard/dashboard.js` | 5 | `POLL_INTERVAL = 10000` — 10-second fallback poll in legacy dashboard, aggressive for a WebSocket-first UI |
| `server/db/provider-routing-core.js` | 1188 | `pollInterval = 500` — polls every 500ms waiting for Ollama readiness; could use exponential backoff |
| `dashboard/src/components/SessionSwitcher.jsx` | 39 | `setInterval(fetchInstances, 10000)` — 10-second refresh even when dropdown is closed |
| `dashboard/src/views/Kanban.jsx` | 566 | `setInterval(() => setNow(Date.now()), 1000)` — 1-second clock tick causes column re-renders every second |
| `server/api/v2-analytics-handlers.js` | 220 | `m._totalDuration = (m._totalDuration || 0) + ...` — accumulation in inner loop without pre-initializing outside |
| `server/api/v2-analytics-handlers.js` | 221 | `m._totalCount = (m._totalCount || 0) + ...` — same pattern |
| `server/dashboard/routes/analytics.js` | 331 | `m.total_cost += row.total_cost || 0` — same inner-loop accumulation pattern |
| `server/api/health-probes.js` | 73 | Two `db.countTasks` calls in same function (lines 73–74) — could be batched |
| `server/api/health-probes.js` | 74 | Second `db.countTasks` call in same function |
| `server/api/v2-analytics-handlers.js` | 76 | Two `db.countTasks` calls for today (lines 76–77) — redundant DB hits |
| `server/api/v2-analytics-handlers.js` | 77 | Third `db.countTasks` call in same function |
| `server/mcp/telemetry.js` | 178 | `latencyByTool = new Map()` grows without bounds across tools — bounded by `MAX_LATENCY_SAMPLES` per tool but tool count itself uncapped |
| `server/db/webhooks-streaming.js` | 509 | `_partialOutputBuffers` grows as tasks stream; eviction only on task end — concurrent long-running streams accumulate |
| `dashboard/src/views/Kanban.jsx` | 80 | `Date.now()` called in `calculateAge` helper outside render memo — recalculates on every call |
| `server/execution/queue-scheduler.js` | 320 | Four separate Maps (`observedRunningByProvider`, `providerLimitCache`, `providerRunningCache`, `providerStartedCounts`) rebuilt on every scheduling cycle |

---

## 9. Code Smells (~50 items)

| File | Line | Description |
|------|------|-------------|
| `server/providers/agentic-git-safety.js` | 214 | `console.warn` instead of structured logger — in warn mode path |
| `server/providers/agentic-git-safety.js` | 221 | `console.warn` in failed-revert path |
| `server/providers/agentic-git-safety.js` | 239 | `console.warn` for unauthorized new file |
| `server/providers/agentic-git-safety.js` | 247 | `console.warn` for failed file deletion |
| `server/remote/agent-client.js` | 45 | `console.warn` for TLS verification disabled warning — important warning buried in `console.warn` |
| `server/components/EconomyIndicator.jsx` | 40 | `.catch((err) => { if (err.name !== 'AbortError') console.warn(...) })` — in React component, should use error state or toast |
| `server/api/v2-analytics-handlers.js` | 503 | `tasks_today: dayStats.total_tasks || 0` — `total_tasks` could legitimately be 0 |
| `server/api/v2-analytics-handlers.js` | 367 | `totalCost += row.total_cost || 0` — costs can be 0 for free-tier tasks |
| `server/api/v2-analytics-handlers.js` | 368 | `taskCount += row.task_count || 0` — count can't be negative so `|| 0` is fine but `?? 0` is clearer |
| `server/api/v2-analytics-handlers.js` | 369 | `byProvider[row.provider] = row.total_cost || 0` — free-tier providers have 0 cost legitimately |
| `server/api/v2-governance-handlers.js` | 652 | `s + (r.total_tasks || 0)` in reduce — same `|| 0` where `?? 0` is correct |
| `server/api/v2-governance-handlers.js` | 660 | `s + (r.total_cost || 0)` — same |
| `server/api/v2-governance-handlers.js` | 765 | `entry[...] = dayData.total || 0` — day's total tasks could be 0 |
| `server/api-server.core.js` | 365 | `(health?.successes || 0) + (health?.failures || 0)` — both could be 0 for new providers |
| `server/api-server.core.js` | 379 | `Number(provider?.max_concurrent) || 0` — 0 means "unlimited" here; `|| 0` overwrites null with 0 which changes semantics |
| `server/api/health-probes.js` | 73 | `db.countTasks({ status: 'queued' }) || 0` — `countTasks` returns 0 on empty, not null; `|| 0` is redundant |
| `server/api/health-probes.js` | 74 | `db.countTasks({ status: 'running' }) || 0` — same |
| `server/benchmark.js` | 192 | `response.prompt_eval_count || 0` — token count could be 0 for cached responses |
| `server/benchmark.js` | 193 | `response.eval_count || 0` — same |
| `server/api/v2-control-plane.js` | 72 | `task.priority || 0` — priority 0 is valid; `|| 0` converts null/undefined to 0 correctly but also converts explicit 0 back to 0 |
| `server/api/v2-control-plane.js` | 157 | `t.progress || t.progress_percent || 0` — 0% progress is valid; should be `t.progress ?? t.progress_percent ?? 0` |
| `server/api/routes.js` | 49 | `} catch {` with no logging — error silently suppressed on route setup |
| `server/api/middleware.js` | 128 | `} catch {` — error in middleware silently suppressed |
| `server/api/v2-router.js` | 158 | `} catch {` — health computation error silently returns stale data |
| `server/api/v2-router.js` | 166 | `} catch {` — queued count error silently returns 0 |
| `server/api/v2-router.js` | 174 | `} catch {` — running count error silently returns 0 |
| `server/api/v2-router.js` | 182 | `} catch {` — load error silently returns 0 |
| `server/api/v2-router.js` | 242 | `} catch {` — provider metrics silently fail |
| `server/api/v2-router.js` | 271 | `} catch {` — another silently swallowed metric computation error |
| `server/api/v2-dispatch.js` | 62 | `} catch {` — routing decision error silently swallowed |
| `server/api/v2-governance-handlers.js` | 452 | `} catch {` — governance check silently fails |
| `server/api/v2-governance-handlers.js` | 677 | `} catch { /* key enrichment is best-effort */ }` — comment justifies but no log |
| `server/api/v2-governance-handlers.js` | 817 | `} catch { /* ignore — best effort */ }` — no log on stats enrichment failure |
| `server/api/v2-infrastructure-handlers.js` | 214 | `} catch { /* probe failed — status stays unknown */ }` — no log |
| `server/execution/fallback-retry.js` | 701 | `const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata)` — unprotected parse |
| `server/execution/queue-scheduler.js` | 177 | `typeof task?.metadata === 'string' ? JSON.parse(task.metadata)` — unprotected parse |
| `server/execution/workflow-runtime.js` | 620 | `typeof task.metadata === 'string' ? JSON.parse(task.metadata)` — unprotected parse |
| `server/execution/workflow-runtime.js` | 1126 | `typeof task.tags === 'string' ? JSON.parse(task.tags)` — unprotected parse |
| `server/handlers/workflow/index.js` | 1063 | `typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}')` — unprotected despite the fallback string |
| `server/handlers/workflow/index.js` | 1076 | `typeof task.depends_on === 'string' ? JSON.parse(task.depends_on)` — unprotected parse |
| `server/handlers/workflow/await.js` | 383 | `typeof task.metadata === 'string' ? JSON.parse(task.metadata)` — unprotected |
| `server/providers/execute-api.js` | 247 | `typeof task.metadata === 'string' ? JSON.parse(task.metadata)` — unprotected |
| `server/providers/execute-ollama.js` | 507 | `typeof defaults === 'string' ? JSON.parse(defaults)` — unprotected |
| `server/ci/github-actions.js` | 115 | `typeof body === 'string' ? JSON.parse(body)` — unprotected parse in CI handler |
| `server/db/provider-capabilities.js` | 35 | `typeof config.capability_tags === 'string' ? JSON.parse(config.capability_tags)` — unprotected |
| `server/execution/completion-pipeline.js` | 72 | `typeof task.files === 'string' ? JSON.parse(task.files)` — unprotected |
| `server/api/v2-control-plane.js` | 157 | `t.progress || t.progress_percent || 0` — three-way fallback without null-safe operators |
| `server/api/v2-analytics-handlers.js` | 220 | `(m._totalDuration || 0)` — private temp property on external object; property pollution |
| `server/api/v2-analytics-handlers.js` | 221 | `(m._totalCount || 0)` — same private temp property pattern |

---

## 10. Configuration (~15 items)

| File | Line | Description |
|------|------|-------------|
| `server/package.json` | 43 | `"node": ">=18.0.0"` engine requirement — root `package.json` requires `>=20.0.0`; mismatch allows running server on Node 18 which may lack `AbortSignal.timeout` |
| `server/vitest.config.js` | 21 | `coverage.include: ['**/*.js']` — overly broad; includes generated files, scripts, and node_modules exclusions must compensate |
| `server/vitest.config.js` | 29 | Coverage threshold `statements: 68` — below industry standard of 80% |
| `server/vitest.config.js` | 30 | Coverage threshold `branches: 58` — significantly below industry standard |
| `server/vitest.config.js` | 31 | Coverage threshold `functions: 73` — below industry standard |
| `dashboard/vitest.config.js` | 17 | Coverage threshold `statements: 40` — very low for a production UI |
| `dashboard/vitest.config.js` | 18 | Coverage threshold `branches: 30` — very low |
| `dashboard/vitest.config.js` | 19 | Coverage threshold `functions: 40` — very low |
| `server/db/schema-migrations.js` | 5 | First `safeAddColumn` — 130+ calls total in this file; each is a no-op on established DBs but adds startup overhead |
| `server/db/schema-migrations.js` | 126 | Block of 11 `safeAddColumn` calls for `failure_patterns` — could be combined in a single `CREATE TABLE IF NOT EXISTS` |
| `server/handlers/automation-handlers.js` | 650 | Block of 9 `safeAddColumn` calls in `set_project_defaults` handler — fires on every call, not just initialization |
| `server/handlers/automation-handlers.js` | 696 | Additional 3 `safeAddColumn` calls in same handler — total 12 DDL statements per `set_project_defaults` invocation |
| `server/vitest.config.js` | 13 | `dangerouslyIgnoreUnhandledErrors: !!process.env.CI` — silences unhandled promise rejections in CI; masks real bugs |
| `server/vitest.config.js` | 8 | `hookTimeout: 10000` — 10s hook timeout with 15s test timeout leaves only 5s margin |
| `server/eslint.config.js` | 54 | `'no-unused-vars': ['warn', ...]` — unused vars emit warnings not errors; real dead code can accumulate |

---

## 11. Minor Error Handling (~30 items)

| File | Line | Description |
|------|------|-------------|
| `server/api/v2-task-handlers.js` | 59 | `} catch {` — task list error silently returns empty |
| `server/api/v2-task-handlers.js` | 305 | `} catch {` — task status computation silently fails |
| `server/api/v2-task-handlers.js` | 351 | `} catch {` — task retry silently fails |
| `server/api/v2-task-handlers.js` | 449 | `} catch {` — task approval silently fails |
| `server/api/v2-task-handlers.js` | 515 | `} catch {` — sixth silent swallow in same file |
| `server/api/v2-task-handlers.js` | 561 | `} catch {` — seventh |
| `server/api/v2-task-handlers.js` | 597 | `} catch {` — eighth |
| `server/api/v2-task-handlers.js` | 648 | `} catch {` — ninth |
| `server/api/v2-task-handlers.js` | 678 | `} catch {` — tenth |
| `server/api/v2-task-handlers.js` | 779 | `} catch {` — eleventh silent swallow in v2-task-handlers |
| `server/validation/post-task.js` | 142 | `} catch {` — post-task validation step silently fails |
| `server/validation/post-task.js` | 209 | `} catch {` — second post-task silent failure |
| `server/validation/post-task.js` | 291 | `} catch {` — third |
| `server/validation/post-task.js` | 384 | `} catch {` — fourth |
| `server/validation/post-task.js` | 446 | `} catch {` — fifth |
| `server/validation/post-task.js` | 510 | `} catch {` — sixth |
| `server/validation/post-task.js` | 515 | `} catch {` — seventh |
| `server/validation/post-task.js` | 541 | `} catch {` — eighth |
| `server/validation/post-task.js` | 654 | `} catch {` — ninth |
| `server/validation/post-task.js` | 704 | `} catch {` — tenth |
| `server/validation/post-task.js` | 709 | `} catch {` — eleventh |
| `server/validation/close-phases.js` | 105 | `} catch { return ''; }` — returns empty string on parse failure; caller may not distinguish |
| `server/validation/close-phases.js` | 133 | `} catch {` — close phase step silently fails |
| `server/validation/close-phases.js` | 139 | `} catch { /* new file, no baseline */ }` — comment present but no logging |
| `server/utils/context-enrichment.js` | 412 | `} catch {` — file reading failure silently skipped |
| `server/utils/context-enrichment.js` | 431 | `} catch { /* skip */ }` — enrichment step silently skipped |
| `server/utils/context-enrichment.js` | 447 | `} catch { /* skip */ }` — same |
| `server/utils/context-enrichment.js` | 585 | `} catch {` — enrichment context build silently fails |
| `server/utils/context-enrichment.js` | 754 | `} catch {` — large enrichment function has silent catch at end |
| `server/utils/context-enrichment.js` | 772 | `} catch { continue; }` — loop continues silently on item failure |

---

## 12. Minor Resource Leaks (~18 items)

| File | Line | Description |
|------|------|-------------|
| `server/coordination/instance-manager.js` | 73 | `instanceHeartbeatInterval` — interval started but cleanup depends on process exit signal handler |
| `server/api/middleware.js` | 142 | `rateLimitCleanupTimer` — interval started at module load; no cleanup exported |
| `server/index.js` | 96 | `pidHeartbeatInterval` — set but only cleared in shutdown handler; if shutdown handler throws, timer leaks |
| `server/index.js` | 207 | `errorRateCleanupInterval` — same |
| `server/index.js` | 284 | `orphanCheckInterval` — same pattern; registered inside a conditional block |
| `server/index.js` | 652 | `queueProcessingInterval` — core processing loop; leak if shutdown handler is bypassed |
| `server/index.js` | 805 | `maintenanceInterval` — same |
| `server/index.js` | 935 | `coordinationAgentInterval` — same |
| `server/index.js` | 950 | `coordinationLockInterval` — same |
| `server/index.js` | 1301 | `stdioHeartbeatInterval` — same |
| `server/maintenance/orphan-cleanup.js` | 661 | `dotnetCleanupInterval` — cleanup on `stop()` but `stop()` must be explicitly called |
| `server/maintenance/orphan-cleanup.js` | 669 | `zombieCheckInterval` — 30-second zombie check; same cleanup concern |
| `server/maintenance/orphan-cleanup.js` | 677 | `stallCheckInterval` — stall check timer; same |
| `server/hooks/event-dispatch.js` | 350 | `_initialPruneTimer` — `setTimeout` handle stored but not cleared on shutdown |
| `server/hooks/event-dispatch.js` | 351 | `_pruneTimer` — `setInterval` without cleanup function exported |
| `server/mcp/index.js` | 1896 | `idempotencyCleanupInterval` — starts on init, no corresponding stop |
| `server/mcp/index.js` | 1897 | `sessionCleanupInterval` — same |
| `server/mcp/index.js` | 1905 | `rateLimitCleanupInterval` — same; three intervals in mcp/index.js with no teardown |

---

## Summary

| Category | Items |
|----------|-------|
| Dead code | 40 |
| Naming inconsistencies | 30 |
| Missing documentation | 25 |
| Minor validation gaps | 35 |
| Code duplication | 20 |
| Minor accessibility | 15 |
| Test quality | 20 |
| Minor performance | 15 |
| Code smells | 50 |
| Configuration | 15 |
| Minor error handling | 30 |
| Minor resource leaks | 18 |
| **Total** | **313** |
