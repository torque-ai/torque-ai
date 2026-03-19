# Tech Debt Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 416 items in the tech debt registry across 4 execution waves.

**Architecture:** Items are grouped by repeating pattern rather than registry category. Each task applies one mechanical transformation across multiple files. This minimizes context-switching and maximizes parallelism.

**Tech Stack:** Node.js (CJS), React (JSX), Vitest, better-sqlite3

**Registry:** `docs/tech-debt-registry.md`

**Verification:** Run on BahumutsOmen after each wave:
```bash
ssh kenten@192.168.1.183 "cmd /c \"cd C:\Users\kenten\Projects\torque-public && git pull origin main 2>&1 && cd server && npx vitest run 2>&1\"" | tail -5
ssh kenten@192.168.1.183 "cmd /c \"cd C:\Users\kenten\Projects\torque-public\dashboard && npx vitest run 2>&1\"" | tail -5
```

---

## Wave 1: High-Impact Patterns (7 tasks, ~180 items)

These patterns each appear 10+ times. Fixing them mechanically clears nearly half the registry.

### Task 1: Deduplicate `safeJsonParse` — 17 copies → 1 import (20 items)

The canonical implementation is at `server/utils/json.js:5`. 16 other files have local copies with different signatures.

**Files to modify (replace local `safeJsonParse` with import):**
- `server/db/analytics.js:30`
- `server/db/coordination.js:25`
- `server/db/event-tracking.js:24`
- `server/db/file-baselines.js:27`
- `server/db/host-benchmarking.js:41`
- `server/db/pack-registry.js:11`
- `server/db/peek-fixture-catalog.js:75`
- `server/db/project-cache.js:46`
- `server/db/project-config-core.js:69`
- `server/db/scheduling-automation.js:91`
- `server/db/task-metadata.js:30`
- `server/db/webhooks-streaming.js:49`
- `server/handlers/provider-crud-handlers.js:30`
- `server/policy-engine/adapters/release-gate.js:30`
- `server/workstation/model.js:14`
- `server/tests/peek-compliance-handlers.test.js:286`

- [ ] **Step 1:** Read `server/utils/json.js` to confirm the canonical signature: `safeJsonParse(value, fallback = null)`
- [ ] **Step 2:** For each file above, replace the local `function safeJsonParse(...)` with `const { safeJsonParse } = require('../utils/json');` (adjust relative path per file). Remove the local function body.
- [ ] **Step 3:** For files with non-standard defaults (e.g., `fallback = {}` in provider-crud-handlers), update call sites to pass the explicit default: `safeJsonParse(val, {})`
- [ ] **Step 4:** Run `cd /c/Users/Werem/Projects/torque-public/server && npx vitest run 2>&1 | tail -5`
- [ ] **Step 5:** Commit: `refactor: deduplicate safeJsonParse — 16 local copies replaced with utils/json import`

Also covers: registry §2 items about naming inconsistency in safeJsonParse signatures, §5 all 17 duplication items, §9 `server/db/scheduling-automation.js:91`

---

### Task 2: Wrap unprotected `JSON.parse` in try/catch — 14 instances (14 items)

Pattern: `typeof x === 'string' ? JSON.parse(x) : x` without try/catch. If the string is corrupted, this crashes.

**Files:**
- `server/execution/fallback-retry.js:701`
- `server/execution/queue-scheduler.js:177`
- `server/execution/workflow-runtime.js:620`
- `server/execution/workflow-runtime.js:1126` (tags)
- `server/execution/completion-pipeline.js:72`
- `server/handlers/workflow/index.js:1063`
- `server/handlers/workflow/index.js:1076` (depends_on)
- `server/handlers/workflow/await.js:383`
- `server/providers/execute-api.js:247`
- `server/providers/execute-ollama.js:507`
- `server/ci/github-actions.js:115`
- `server/db/provider-capabilities.js:35`
- `server/api/v2-control-plane.js:54`
- `server/api/v2-control-plane.js:157`

- [ ] **Step 1:** For each file, replace the unprotected parse with `safeJsonParse`:
```js
// BEFORE:
const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
// AFTER:
const { safeJsonParse } = require('../utils/json'); // add at top if not present
const meta = typeof task.metadata === 'string' ? safeJsonParse(task.metadata, {}) : (task.metadata || {});
```
- [ ] **Step 2:** Run tests
- [ ] **Step 3:** Commit: `fix: wrap 14 unprotected JSON.parse calls with safeJsonParse`

---

### Task 3: Replace `|| 0` with `?? 0` where 0 is a valid value — 22 instances (22 items)

Pattern: `value || 0` treats valid `0` as falsy. `?? 0` only falls back on `null`/`undefined`.

**Files (all in `server/`):**
- `api/v2-analytics-handlers.js:367,368,369,503`
- `api/v2-governance-handlers.js:652,660,765`
- `api-server.core.js:365,379`
- `api/health-probes.js:73,74`
- `api/v2-analytics-handlers.js:76,77`
- `api/v2-control-plane.js:72,157`
- `benchmark.js:192,193`

- [ ] **Step 1:** For each instance, change `|| 0` to `?? 0`
- [ ] **Step 2:** For `api-server.core.js:379` (`Number(provider?.max_concurrent) || 0`), use `Number(provider?.max_concurrent) ?? 0` — but verify that 0 means "unlimited" in this context
- [ ] **Step 3:** Run tests
- [ ] **Step 4:** Commit: `fix: replace || 0 with ?? 0 where zero is a valid value`

---

### Task 4: Add logging to empty `catch {}` blocks — 33 instances (33 items)

Pattern: `} catch {` or `} catch (_) {` silently swallows errors. Add `logger.debug` at minimum.

**Files:**
- `server/api/v2-task-handlers.js` — 11 empty catches (lines 59,305,351,449,515,561,597,648,678,779, +205,416 deleteTask)
- `server/validation/post-task.js` — 11 empty catches (lines 142,209,291,384,446,510,515,541,654,704,709)
- `server/utils/context-enrichment.js` — 6 empty catches (lines 412,431,447,585,754,772)
- `server/api/v2-router.js` — 6 empty catches (lines 158,166,174,182,242,271)
- `server/api/routes.js:49`, `server/api/middleware.js:128`, `server/api/v2-dispatch.js:62`
- `server/api/v2-governance-handlers.js:452,677,817`
- `server/api/v2-infrastructure-handlers.js:214`
- `server/validation/close-phases.js:105,133,139`

- [ ] **Step 1:** For each file, add a `require` for logger at top if not present
- [ ] **Step 2:** Replace each empty `catch {}` with `catch (err) { logger.debug('...context...', err.message); }`. Use context from the surrounding code (e.g., `'task list enrichment failed'`)
- [ ] **Step 3:** For `catch { /* comment */ }` — keep the comment, add `logger.debug`
- [ ] **Step 4:** Run tests
- [ ] **Step 5:** Commit: `fix: add debug logging to 33 silent catch blocks`

---

### Task 5: Add `required` fields to tool schemas — 35 instances (35 items)

Pattern: Tools have `required: []` but have de-facto required parameters.

**File:** All in `server/tool-defs/` — 35 specific tools listed in registry §4

- [ ] **Step 1:** For each tool in the registry §4 list, add the de-facto required parameter to the `required` array. Examples:
  - `check_status`: `required: ['task_id']`
  - `cancel_task`: `required: ['task_id']`
  - `create_webhook`: `required: ['url', 'event_types']`
  - `create_workflow`: `required: ['name']`
- [ ] **Step 2:** Run tests (tool schema tests may need updating)
- [ ] **Step 3:** Commit: `fix: add required fields to 35 tool schemas with de-facto required params`

---

### Task 6: Replace "Codex" with "TORQUE"/"provider" in descriptions — 11 instances (11 items)

**File:** All in `server/tool-defs/` — 11 tools with "Codex" in descriptions (registry §2)

- [ ] **Step 1:** For each tool listed in registry §2 items 1-11, replace "Codex" with the appropriate term:
  - "Maximum concurrent Codex instances" → "Maximum concurrent provider instances"
  - "Codex task history" → "TORQUE task history"
  - "Codex CLI" → "TORQUE infrastructure"
  - "Auto-approve Codex actions" → "Auto-approve provider actions"
  - "simple→Laptop, normal→Desktop, complex→Codex" → "simple→local, normal→balanced, complex→cloud"
- [ ] **Step 2:** Also replace the 3 `=== 'codex'` string literals with a provider constant (§2 items 12-14)
- [ ] **Step 3:** Run tests
- [ ] **Step 4:** Commit: `docs: replace Codex-centric descriptions with provider-agnostic language`

---

### Task 7: Add `minimum`/`maximum` constraints to `timeout_minutes` and similar — 25 instances (25 items)

**Files:** All in `server/tool-defs/` — 12 `timeout_minutes`, 2 `context_depth`, 2 `context_budget`, 5 `max_concurrent`, etc. (registry §3)

- [ ] **Step 1:** For each `timeout_minutes` parameter, add `minimum: 1, maximum: 60`
- [ ] **Step 2:** For `context_depth`, add `enum: [1, 2]`
- [ ] **Step 3:** For `max_concurrent`, add `minimum: 0` (0 = unlimited per docs)
- [ ] **Step 4:** For `vram_factor`, add `minimum: 0.5, maximum: 1.0`
- [ ] **Step 5:** Run tests
- [ ] **Step 6:** Commit: `docs: add min/max constraints to timeout_minutes and similar schema params`

---

## Wave 2: Server Robustness (5 tasks, ~80 items)

### Task 8: Clean up dead code — tombstones, unused imports, eslint suppressions (46 items)

**Pattern by sub-type:**

**Tombstone comments (remove):**
- `server/api-server.core.js:9` — commented-out require
- `server/task-manager.js:390,1155` — "REMOVED" comments
- `server/api/routes.js:124` — "removed because they shadowed" comment

**eslint-disable suppressions (fix root cause):**
- `server/db/host-complexity.js:89` + `server/execution/workflow-runtime.js:499,502` + `server/handlers/shared.js:592,602` — `no-control-regex`: extract regex to named constant
- `server/tests/agentic-routing.test.js:148` — `eqeqeq`: change `==` to `===`
- `server/remote/agent-client.js:44` — `no-console`: replace with `logger.warn`
- `server/handlers/economy-handlers.js:139` — `global-require`: move require to module level

**Unused code (remove):**
- `server/task-manager-delegations.js:131` — unexported `fireTerminalTaskHook`
- `server/providers/execute-hashline.js:414` — unused `resolvedFiles` param
- `dashboard/src/components/Onboarding.jsx:1` — unused React import
- `cli/commands.js:35` — unused `context` params
- `server/coordination/instance-manager.js:81` — redundant null check
- `server/policy-engine/shadow-enforcer.js:4` — `void logger`

**var → const/let:**
- `server/dashboard/dashboard.js:4-30` — all `var` declarations

- [ ] **Steps:** Read each file, apply the fix, run tests, commit: `chore: remove dead code, fix eslint suppressions, modernize var declarations`

---

### Task 9: Fix resource leaks — timer cleanup and unbounded caches (25 items)

**Pattern: intervals without cleanup**

Most intervals in `server/index.js` (lines 96,207,284,652,805,935,950,1301) are already cleaned in the shutdown handler — verify each has a cleanup path. For those that don't:
- `server/mcp/index.js:1896,1897,1905` — 3 intervals with no teardown. Add `stop()` function.
- `server/hooks/event-dispatch.js:350,351,363` — timers without exported cleanup. Export `stopRetentionPolicy()`.
- `server/maintenance/orphan-cleanup.js:661,669,677` — cleanup on `stop()` but verify `stop()` is called in shutdown.

**Pattern: unbounded caches**
- `server/utils/git.js:56` — `_fingerprintCache` no eviction. Add max size.
- `server/mcp-sse.js:46` — `notificationMetrics` counters. Add periodic reset.
- `server/hooks/event-dispatch.js:26` — maxListeners(100) with no cleanup. Document why 100 is sufficient.

- [ ] **Steps:** For each, add cleanup or document why leak is bounded. Run tests. Commit: `fix: add timer cleanup exports and bound unbounded caches`

---

### Task 10: Add signal pre-checks and fix error handling gaps (36 items)

**Missing signal checks:**
- `server/providers/cerebras.js:38` — add `if (options.signal?.aborted) controller.abort()`
- `server/providers/google-ai.js:38` — same

**Module-load requires that crash on failure:**
- `server/policy-engine/engine.js:4` — wrap in try/catch

**Missing error handling:**
- `server/contracts/peek.js:177` — wrap fixture load in try/catch
- `server/providers/adapters/google-chat.js:170` — check HTTP status before JSON.parse

**SQL LIKE without ESCAPE (4 instances):**
- `server/db/file-quality.js:40,224,374`
- `server/db/coordination.js:170`

Add `ESCAPE '\\'` clause and escape `%` and `_` in parameters.

- [ ] **Steps:** Apply each fix. Run tests. Commit: `fix: signal pre-checks, error handling, and SQL LIKE escaping`

---

### Task 11: Fix minor performance issues (21 items)

**Redundant DB calls:**
- `server/api/health-probes.js:73-74` — batch into single query
- `server/api/v2-analytics-handlers.js:76-77` — same
- `server/handlers/task/core.js:369,382` — double metadata parse

**Aggressive polling:**
- `server/dashboard/dashboard.js:5` — increase from 10s to 30s
- `server/db/provider-routing-core.js:1188` — add exponential backoff
- `dashboard/src/components/SessionSwitcher.jsx:39` — only poll when dropdown open

**Date.now() in render:**
- `dashboard/src/views/Kanban.jsx:80,922` — use component-level `now` state
- `dashboard/src/views/Hosts.jsx:201` — memoize

- [ ] **Steps:** Apply each fix. Run tests. Commit: `perf: batch DB calls, reduce polling frequency, memoize Date.now`

---

### Task 12: Fix minor validation gaps in non-tool-def files (4 items)

- `server/api/v2-control-plane.js:54` — wrap JSON.parse in try/catch
- `server/dashboard/utils.js:66` — use `Buffer.byteLength` not `string.length` for body size
- `server/hooks/event-dispatch.js:303` — validate `options.limit` as positive integer
- `bin/torque.js:284` — validate backup path is a real file before sending to API

- [ ] **Steps:** Apply each. Run tests. Commit: `fix: minor validation gaps in control-plane, dashboard utils, event dispatch, CLI`

---

## Wave 3: Frontend + Tests (4 tasks, ~62 items)

### Task 13: Fix dashboard accessibility — modals, ARIA, keys (16 items)

**Modal accessibility (7 modals):**
Add `role="dialog"`, `aria-modal="true"`, `aria-label`, Escape key handler to:
- `dashboard/src/components/KeyboardShortcuts.jsx:125-126`
- `dashboard/src/views/Hosts.jsx:714,1448,1479,1495`
- `dashboard/src/views/StrategicConfig.jsx:135`
- `dashboard/src/views/Workstations.jsx:399`

**Index-as-key:**
- `dashboard/src/views/Budget.jsx:379` — use `entry.name`
- `dashboard/src/views/Providers.jsx:647` — use `entry.name`

**aria-expanded string vs boolean:**
- `dashboard/src/views/Kanban.jsx:435` — change `'false'` to `{false}`

**Non-passive wheel listener:**
- `dashboard/src/components/WorkflowDAG.jsx:110` — already fixed in Phase 2, verify

**Notification bell title:**
- `dashboard/src/components/Layout.jsx:388` — conditional title

- [ ] **Steps:** Apply each. Run dashboard tests. Commit: `a11y: add dialog roles, fix aria attributes, use named keys`

---

### Task 14: Fix test quality issues (26 items)

**require.cache brittleness (10 test files):**
Convert to `vi.mock()` where possible, or document why `require.cache` is needed:
- `server/tests/adapter-registry.test.js`
- `server/tests/advanced-approval.test.js`
- `server/tests/advanced-artifacts-handlers.test.js`
- `server/tests/advanced-artifacts.test.js`
- `server/tests/advanced-debugger-handlers.test.js`
- `server/tests/advanced-debugger.test.js`
- `server/tests/advanced-intelligence-handlers.test.js`
- `server/tests/advanced-intelligence.test.js`
- `server/tests/advanced-performance.test.js`
- `server/tests/advanced-scheduling.test.js`

**Unasserted mocks:**
- `dashboard/src/views/Budget.test.jsx:24` — add assertions or remove unused mocks
- `dashboard/src/App.test.jsx:22` — same

**Other:**
- `dashboard/src/test-utils.jsx:18` — add `clone()` to mockFetch
- `agent/tests/server.test.js:44` — use `os.tmpdir()` instead of `'.'`
- `agent/tests/sync.test.js:135` — handle Windows file locks in cleanup
- `dashboard/e2e/free-tier.spec.js:224` — replace `waitForTimeout` with `waitForResponse`
- `server/tests/cloud-providers.test.js:16` — use `vi.restoreAllMocks()` in afterEach

- [ ] **Steps:** Apply each. Run all tests. Commit: `test: replace require.cache with vi.mock, fix assertions, improve cleanup`

---

### Task 15: Fix duplicate implementations and code duplication (6 items)

- `server/utils/context-enrichment.js:20` — import `SENSITIVE_FILE_PATTERNS` from context-stuffing.js
- `server/providers/execute-cli.js:163` — `buildCodexCommand` duplicate: delegate to `execution/command-builders.js`
- `server/handlers/workflow/await.js:169` — `formatDuration` duplicate: import from shared utility
- `server/execution/command-builders.js:75` — verify this is the canonical `buildCodexCommand`
- `dashboard/src/views/FreeTier.jsx:122` — remove local `formatDuration`, import from utils

- [ ] **Steps:** Apply each. Run tests. Commit: `refactor: remove duplicate implementations — SENSITIVE_FILE_PATTERNS, buildCodexCommand, formatDuration`

---

### Task 16: Fix remaining dashboard code smells (15 items)

- `dashboard/src/websocket.js:121` — stabilize `connect` dependency
- `dashboard/src/components/TaskSubmitForm.jsx:52` — remove `toast` from deps or wrap in ref
- `dashboard/src/components/SessionSwitcher.jsx:78` — add loading indicator on session switch
- `dashboard/src/views/RoutingTemplates.jsx:252` — move useState before useCallback
- `dashboard/src/views/Approvals.jsx:191` — use per-item action tracking instead of shared `lastAction`
- `dashboard/src/views/Kanban.jsx:203` — remove JS truncation, let CSS `line-clamp-2` handle it
- `dashboard/src/views/Schedules.jsx:132` — change `gradient="slate"` to `gradient="blue"` or add slate to GRADIENTS
- `dashboard/src/views/History.jsx:131` — quote all CSV fields
- `dashboard/e2e/strategic.spec.js:196` — use `toContain('10.')` instead of exact `'10.6%'`

- [ ] **Steps:** Apply each. Run dashboard tests. Commit: `fix: dashboard code smells — dependencies, truncation, CSV quoting, gradient`

---

## Wave 4: Configuration + CLI (3 tasks, ~72 items)

### Task 17: Fix configuration issues (16 items)

- `server/package.json:43` — change `>=18.0.0` to `>=20.0.0` to match root
- `server/vitest.config.js:21` — narrow coverage include to `['src/**/*.js', '*.js', 'db/**/*.js', ...]`
- `server/vitest.config.js:13` — remove `dangerouslyIgnoreUnhandledErrors` or add comment justifying
- `server/vitest.config.js:8` — increase hookTimeout to match testTimeout
- Coverage thresholds — leave as-is (aspirational, not blockers)
- `server/eslint.config.js:54` — change `no-unused-vars` from `warn` to `error`
- `server/db/schema-migrations.js:126` — consolidate `safeAddColumn` into `CREATE TABLE IF NOT EXISTS`
- `cli/init.js:52` — update `generateMcpJson` to use SSE transport config

- [ ] **Steps:** Apply each. Run tests. Commit: `config: align Node version, tighten eslint, fix vitest config, update init template`

---

### Task 18: Fix CLI code smells (12 items)

- `cli/torque-cli.js:195` — add helpful error for unknown workflow subcommand
- `cli/commands.js:35` — remove unused `context` parameters
- `cli/commands.js:342` — fix `handleHealth` signature to match call site
- `cli/commands.js:261` — add exponential backoff to `handleAwait` polling
- `cli/formatter.js:299,304` — add format cases for `workflow_add_task` and CI commands
- `cli/stop.js:5` — verify process exit after SIGTERM
- `cli/dashboard.js:20` — sanitize port from env var before passing to `start`
- `bin/torque.js:99` — handle `--*` flags inside quoted strings
- `bin/torque.js:119` — distinguish API vs usage errors in `runHandler`
- `bin/torque.js:278` — add flag-aware argument parsing to `handleBackup`

- [ ] **Steps:** Apply each. Run tests. Commit: `fix: CLI code smells — error messages, arg parsing, polling backoff`

---

### Task 19: Fix remaining server code smells (45 items)

This covers the miscellaneous items in registry §9 not addressed by Tasks 1-4:

**Groups within this task:**

**a) `console.warn` → logger (5 items):**
`server/providers/agentic-git-safety.js:214,221,239,247` + `server/remote/agent-client.js:45`

**b) Variable shadowing and fragile patterns (10 items):**
`server/providers/execute-ollama.js:580,783,793`, `server/providers/execute-api.js:469,306`, `server/providers/execute-hashline.js:823,569`, `server/providers/codex-intelligence.js:111`, `server/execution/process-tracker.js:214`, `server/execution/smart-diagnosis-stage.js:90`

**c) SQL patterns (4 items):**
`server/economy/queue-reroute.js:115`, `server/workstation/model.js:143`, `server/db/analytics.js:288,1118`

**d) Process/lifecycle fragility (6 items):**
`server/execution/process-lifecycle.js:405,451`, `server/execution/task-cancellation.js:43,76`, `server/execution/command-policy.js:300`, `server/execution/queue-scheduler.js:337,622`

**e) Parser/detection issues (5 items):**
`server/orchestrator/response-parser.js:4,29`, `server/validation/completion-detection.js:132`, `server/validation/post-task.js:741,1097`

**f) Other one-offs (15 items):**
`server/tools.js:338,340,441`, `server/discovery.js:273`, `server/orchestrator/benchmark.js:29`, `server/utils/credential-crypto.js:13,67`, `server/utils/file-resolution.js:64`, `server/utils/hashline-parser.js:430`, `server/utils/sanitize.js:80`, `server/hooks/approval-gate.js:41`, `server/remote/remote-test-routing.js:320`, `server/validation/safeguard-gates.js:72`, `server/validation/preflight-types.js:274`, `server/providers/prompts.js:298`, `server/providers/ollama-agentic.js:353`, `server/providers/agentic-worker.js:177`, `server/providers/agentic-capability.js:127`

- [ ] **Steps:** Apply each sub-group as a batch. Run tests between groups. Commit per group:
  - `fix(a): replace console.warn with structured logger`
  - `fix(b): resolve variable shadowing and fragile patterns`
  - `fix(c): parameterize SQL column interpolation`
  - `fix(d): harden process lifecycle edge cases`
  - `fix(e): tighten parser regex patterns`
  - `fix(f): miscellaneous code smell fixes`

---

## Execution Summary

| Wave | Tasks | Items | Focus |
|------|-------|-------|-------|
| **Wave 1** | 1-7 | ~180 | High-impact patterns (dedup, JSON safety, schemas, naming) |
| **Wave 2** | 8-12 | ~80 | Server robustness (dead code, leaks, error handling, perf) |
| **Wave 3** | 13-16 | ~62 | Frontend + tests (a11y, test quality, duplication) |
| **Wave 4** | 17-19 | ~72 | Config + CLI + remaining server smells |
| **Total** | **19 tasks** | **~416** | |

**Parallelism:** Within each wave, all tasks touch non-overlapping files and can be dispatched as parallel subagents. Waves must be sequential (each wave's verification gates the next).

**After completion:** Delete `docs/tech-debt-registry.md` or mark all items as resolved.
