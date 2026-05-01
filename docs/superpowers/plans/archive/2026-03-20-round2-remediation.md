# Round 2 Codebase Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution model:** Phase 1 is manual (security + data). Phases 2-5 are TORQUE-batchable. Each Phase is a workflow.

**Goal:** Remediate 159 new issues from the Round 2 deep-dive review across 7 phases.

**Architecture:** Issues grouped by blast radius. Phase 1 (schema + security) must be manual. Phases 2-5 are mechanical.

**Tech Stack:** Node.js (CJS), React/JSX, better-sqlite3, Vitest

**Conflicts with Auth System Plan (`2026-03-20-auth-system.md`):**

| File | This Plan | Auth Plan | Resolution |
|------|-----------|-----------|------------|
| `server/db/schema-tables.js` | Task 1.1-1.2: add columns, indexes, FKs | Task 1: add `api_keys` table | No conflict — different sections. Run both. |
| `server/db/schema-migrations.js` | Task 1.2: fix `reason_code` | Task 1: add `auth_server_secret` migration | No conflict — different migration entries. |
| `server/api/middleware.js` | Already fixed (Round 1 Phase 3.5) | Task 5: replaces `checkAuth` with `authenticateRequest` | **Auth plan must preserve the `settled` flag body-parser fixes from commit `3df4694`.** |
| `server/api/routes.js` | Already fixed (Round 1 Phase 1.1) | Tasks 4-7: add `/api/auth/*` routes | **Auth plan must add `/api/bootstrap/workstation` to `OPEN_PATHS` list.** |
| `server/mcp-sse.js` | Tasks 1.3, 3.1: HSTS, subscription, IP bucket, timers, listeners | Task 4: replaces inline auth with middleware | **Execute Round 2 fixes BEFORE auth plan.** Auth changes are in the session-creation section (~line 1349), separate from HSTS/subscription/timer fixes. |
| `server/index.js` | Task 2.1: orphan mode, overload guard, configCore | Task 8: keyManager init + bootstrap key | **Auth init must come AFTER db init, BEFORE MCP transport start.** Both modify the startup path but in different sections. |

**Execution order:** Round 2 remediation Phases 1-7 → Auth System Tasks 1-8. The remediation fixes the foundation; auth builds on it.

**Verification:**
```bash
torque-remote npx vitest run
torque-remote npx vitest run --config dashboard/vitest.config.js
```

---

## Phase 1: Schema Integrity + Security (Manual — 18 issues)

### Task 1.1: Fix Schema Drift — `tasks` CREATE TABLE + Missing Columns

**Files:**
- Modify: `server/db/schema-tables.js:258-293`
- Modify: `server/db/schema-tables.js:2961-2980` (audit_runs)
- Modify: `server/db/schema-tables.js:1266-1279` (failure_patterns)

- [ ] **Step 1:** Add all 23 migration-added columns to the `tasks` CREATE TABLE definition (tags, project, model, complexity, review_status, ollama_host_id, metadata, workflow_id, workflow_node_id, stall_timeout_seconds, mcp_instance_id, retry_strategy, retry_delay_seconds, last_retry_at, group_id, paused_at, pause_reason, approval_status, claimed_by_agent, required_capabilities, git_before_sha, git_after_sha, git_stash_ref)
- [ ] **Step 2:** Add `workflow_id TEXT` to `audit_runs` CREATE TABLE
- [ ] **Step 3:** Add missing columns (name, description, signature, task_types, provider, occurrence_count, recommended_action, auto_learned, enabled, updated_at) to `failure_patterns` CREATE TABLE
- [ ] **Step 4:** Add `idx_tasks_workflow` index to schema-tables.js index block
- [ ] **Step 5:** Add `idx_cost_tracking_tracked ON cost_tracking(provider, tracked_at)` index
- [ ] **Step 6:** Commit `fix(schema): sync CREATE TABLE definitions with migration-added columns`

### Task 1.2: Fix Schema Constraints + Integrity Issues

**Files:**
- Modify: `server/db/schema-tables.js:1203-1214` (task_dependencies FKs)
- Modify: `server/db/schema-tables.js:580,631` (policy_overrides reason_code)
- Modify: `server/db/schema-tables.js:813` (success_metrics NULL uniqueness)
- Modify: `server/db/schema-tables.js:2900,2907` (pack_registry duplicate constraint)

- [ ] **Step 1:** Add FOREIGN KEY constraints to `task_dependencies` for workflow_id, task_id, depends_on_task_id with ON DELETE CASCADE
- [ ] **Step 2:** Fix `policy_overrides.reason_code` in ensureTableColumns to `'reason_code TEXT NOT NULL DEFAULT ''unknown'''`
- [ ] **Step 3:** Fix `success_metrics` UNIQUE index: change `project` column to `TEXT NOT NULL DEFAULT ''` or use COALESCE in index
- [ ] **Step 4:** Remove duplicate `UNIQUE(name, version)` from pack_registry (keep the named index)
- [ ] **Step 5:** Move `routing_templates` CREATE TABLE from template-store.js into schema-tables.js
- [ ] **Step 6:** Commit `fix(schema): FK constraints, NULL uniqueness, duplicate indexes`

### Task 1.3: Security Fixes — SQL Injection + Auth + Protocol

**Files:**
- Modify: `server/db/peek-fixture-catalog.js:186` (SQL injection via column name)
- Modify: `server/db/project-config-core.js:2109-2112,2130-2135` (SQL injection via additionalFields)
- Modify: `server/mcp-sse.js:101-106` (HSTS on HTTP)
- Modify: `server/mcp-sse.js:957-973` (subscription limit bypass)
- Modify: `server/mcp-sse.js:1251-1253` (session reconnect ownership check)

- [ ] **Step 1:** Add column allowlist to `selectFixtureByField`: `const ALLOWED = new Set(['id', 'name']); if (!ALLOWED.has(field)) throw new Error('Invalid field');`
- [ ] **Step 2:** Add column allowlists to `updatePipelineStatus` and `updatePipelineStep`
- [ ] **Step 3:** Remove `Strict-Transport-Security` from `SECURITY_HEADERS` in mcp-sse.js (server is HTTP-only)
- [ ] **Step 4:** Fix subscription limit: check `args.task_ids.length > MAX_SUBSCRIPTIONS_PER_SESSION` instead of additive check before clear
- [ ] **Step 5:** Add `isSessionOwner` check on GET `/sse` reconnect path
- [ ] **Step 6:** Commit `fix(security): SQL injection guards, HSTS removal, subscription limit, session ownership`

### Task 1.4: Dead Routing Code + Wrong Table

**Files:**
- Modify: `server/db/provider-routing-core.js:504-506` (wire isSecurityTask/isXamlTask)
- Modify: `server/db/provider-routing-core.js:530` (fix hyperbolic fallback condition)
- Modify: `server/db/provider-routing-core.js:1685-1702` (preserve error_output)
- Modify: `server/db/host-management.js:930-956` (addRoutingRule wrong table)

- [ ] **Step 1:** Wire `isSecurityTask` and `isXamlTask` into the routing logic — route security tasks to anthropic/claude-cli, XAML tasks to cloud providers
- [ ] **Step 2:** Fix hyperbolic fallback: check `diProvider.enabled` and quota exhaustion, not just `!deepinfraApiKey`
- [ ] **Step 3:** Change `cleanupStaleTasks` to append error message: `error_output = COALESCE(error_output || char(10), '') || 'Task marked as failed: ...'`
- [ ] **Step 4:** Fix `addRoutingRule` to INSERT into `routing_rules` (not `complexity_routing`)
- [ ] **Step 5:** Commit `fix(routing): wire security/XAML routing, fix hyperbolic fallback, preserve error_output, fix table name`

---

## Phase 2: Logic Errors + Lifecycle Bugs (16 issues)

### Task 2.1: Server Lifecycle Fixes

**Files:**
- Modify: `server/index.js:257-325` (orphan mode dead code)
- Modify: `server/database.js:652-671` (missing configCore.setDb(null))
- Modify: `server/index.js:1338-1344` (overload guard id:null)
- Modify: `server/task-manager.js:1509,1593` (_queuePollInterval not nulled)

- [ ] **Step 1:** Either delete orphan mode block or re-wire stdin close to trigger it — document the decision
- [ ] **Step 2:** Add `configCore.setDb(null);` in database.js `close()`
- [ ] **Step 3:** Parse request ID before overload response: `let id; try { id = JSON.parse(line)?.id ?? null; } catch {}`
- [ ] **Step 4:** Add `_queuePollInterval = null;` after `clearInterval(_queuePollInterval)` in shutdown + resetForTest
- [ ] **Step 5:** Commit `fix(lifecycle): orphan mode, configCore cleanup, overload ID, poll interval reset`

### Task 2.2: Handler + Execution Logic Fixes

**Files:**
- Modify: `server/handlers/workflow/await.js:802,1037` (wrong timeout constant)
- Modify: `server/handlers/workflow/await.js:362,380` (stale ctx snapshot)
- Modify: `server/handlers/workflow/await.js:276,878` (inconsistent error trim)
- Modify: `server/handlers/peek/analysis.js:806-808` (snapshot_id path traversal)
- Modify: `server/handlers/task/pipeline.js:426` (variable substitution syntax mismatch)
- Modify: `server/handlers/task/intelligence.js:510-511` (recordAuditLog wrong args)
- Modify: `server/task-manager.js:630` (proc null check)

- [ ] **Step 1:** Replace `TASK_TIMEOUTS.HTTP_REQUEST` with `TASK_TIMEOUTS.GIT_COMMIT` at both git commit locations
- [ ] **Step 2:** Re-read workflow context from DB before each acknowledge write in await loop
- [ ] **Step 3:** Change `formatStandaloneTaskResult` to use tail-trimming matching `formatTaskYield`
- [ ] **Step 4:** Add path traversal guard on `snapshot_id` in `handlePeekRegression`
- [ ] **Step 5:** Standardize pipeline variable syntax to `{key}` (matching template pattern)
- [ ] **Step 6:** Fix `recordAuditLog` call: add `null` for newValue, move JSON to metadata position
- [ ] **Step 7:** Add `proc?.output` optional chaining and `!proc` guard in `handleNoFileChangeDetection`
- [ ] **Step 8:** Commit `fix(handlers): timeouts, ctx refresh, path traversal, variable syntax, audit log args`

### Task 2.3: DB Module Logic Fixes

**Files:**
- Modify: `server/db/coordination.js:91-103` (agent_left event then deleted)
- Modify: `server/db/coordination.js:244-246` (parseInt NaN crash)
- Modify: `server/db/coordination.js:1246-1263` (forceReleaseStaleLock checks wrong thing)
- Modify: `server/db/analytics.js:644-720` (failure_rate always 1.0)
- Modify: `server/db/project-config-core.js:280` (budget alerts never fire without threshold_value)
- Modify: `server/db/project-config-core.js:56` (getTask proxy crash)

- [ ] **Step 1:** Remove `DELETE FROM coordination_events WHERE agent_id = ?` from unregister transaction — keep audit trail
- [ ] **Step 2:** Add safe defaults: `const interval = parseInt(config.heartbeat_interval_seconds, 10) || 30;`
- [ ] **Step 3:** Add heartbeat staleness check to `forceReleaseStaleLock`
- [ ] **Step 4:** Create `recordSuccessPattern` function for `learnFailurePattern` complement — increment total_matches without failure_count
- [ ] **Step 5:** Fix budget alert to handle percent-only thresholds (no absolute value)
- [ ] **Step 6:** Add null guard to getTask proxy: `if (!_getTask) return null;`
- [ ] **Step 7:** Commit `fix(db): coordination events, stale lock, failure patterns, budget alerts`

---

## Phase 3: MCP + Transport Fixes (14 issues)

### Task 3.1: MCP-SSE Fixes

**Files:**
- Modify: `server/mcp-sse.js:1262-1271` ('unknown' IP bucket)
- Modify: `server/mcp-sse.js:797-803` (setTimeout tracked as setInterval)
- Modify: `server/mcp-sse.js:1666-1694` (stop() returns before port released)
- Modify: `server/mcp-sse.js:1702,1719` (model event listeners never removed)
- Modify: `server/mcp-sse.js:549-572` (silent notification render failure)

- [ ] **Step 1:** Skip per-IP enforcement for 'unknown' addresses
- [ ] **Step 2:** Track aggregation `setTimeout`s separately from `setInterval`s
- [ ] **Step 3:** Return a promise from `stop()` that resolves on `server.close()` callback
- [ ] **Step 4:** Store model event handler refs and remove them in `stop()`
- [ ] **Step 5:** Log notification render errors instead of silently dropping
- [ ] **Step 6:** Commit `fix(mcp-sse): IP bucket, timer tracking, stop() async, listener cleanup`

### Task 3.2: MCP Gateway Fixes

**Files:**
- Modify: `server/mcp/index.js:1808-1809` (unguarded URL parse)
- Modify: `server/mcp/index.js:1381` (has_more hardcoded false)
- Modify: `server/mcp/index.js:568-579` (Map mutation during iteration)
- Modify: `server/mcp/index.js:190-221` (no body parse timeout)
- Modify: `server/mcp/index.js:292-297` (client-controlled role header)

- [ ] **Step 1:** Wrap `new URL(req.url, ...)` in try/catch, return 400 on parse failure
- [ ] **Step 2:** Derive `has_more` from event count vs page size
- [ ] **Step 3:** Snapshot session keys before iterating for cleanup
- [ ] **Step 4:** Add 30-second body parse timeout matching mcp-sse.js pattern
- [ ] **Step 5:** Add warning comment on `X-MCP-Role` header — document as trusted-localhost-only
- [ ] **Step 6:** Commit `fix(mcp): URL parse guard, pagination, iteration safety, body timeout`

---

## Phase 4: Tool Schema + Documentation (18 issues)

### Task 4.1: Critical Tool Schema Fixes

**Files:**
- Modify: `server/tool-defs/workflow-defs.js:14` (pipeline_id number→string)
- Modify: `server/tool-defs/validation-defs.js:882-894` + `server/handlers/validation/analysis.js:178` (get_audit_summary param mismatch)
- Modify: `server/tool-defs/validation-defs.js:600-610` (budget_id vs budget_name)
- Modify: `server/tool-defs/validation-defs.js:519-527` (approval enum advertised but discarded)

- [ ] **Step 1:** Change `duplicate_pipeline` `pipeline_id` from `type: 'number'` to `type: 'string'`
- [ ] **Step 2:** Fix `get_audit_summary`: either update schema to expose `period` with enum, or fix handler to read `args.days`
- [ ] **Step 3:** Fix `get_budget_status` handler to read `args.budget_id` not `args.budget_name`
- [ ] **Step 4:** Remove `'approval'` from `setup_precommit_hook` checks enum (or implement it)
- [ ] **Step 5:** Commit `fix(schema): pipeline_id type, audit summary params, budget filter, precommit enum`

### Task 4.2: Tool Schema Quality Fixes

**Files:**
- Modify: `server/tool-defs/task-defs.js:13-17` (min:0 vs description 1-20)
- Modify: `server/tool-defs/task-defs.js:207-210` (pipeline condition missing enum)
- Modify: `server/tool-defs/task-defs.js:829` (stale machine-name description)
- Modify: `server/tool-defs/integration-defs.js:657` (stale machine-name description)
- Modify: `server/tool-defs/snapscope-defs.js:605-619` (ambiguous timeout fields)
- Modify: `server/tool-defs/validation-defs.js:177-184` (severity enum inconsistency)
- Modify: `server/tool-defs/validation-defs.js:456-472` (run_build_check missing task_id required)
- Modify: various files (integer vs number, missing required arrays)

- [ ] **Step 1:** Change `configure` `max_concurrent` minimum from 0 to 1
- [ ] **Step 2:** Add `enum: ["always", "on_success", "on_failure"]` to pipeline step `condition`
- [ ] **Step 3:** Update stale machine-name descriptions in task-defs and integration-defs
- [ ] **Step 4:** Rename `peek_launch` `timeout` to `window_wait_seconds`
- [ ] **Step 5:** Document severity enum difference in `add_failure_pattern` or standardize
- [ ] **Step 6:** Add `task_id` to `run_build_check` required
- [ ] **Step 7:** Standardize `integer` → `number` across policy-defs, remote-agent-defs, workstation-defs
- [ ] **Step 8:** Add missing `required: []` to `task_info` and `get_audit_summary`
- [ ] **Step 9:** Commit `fix(schema): constraints, enums, descriptions, types across tool definitions`

---

## Phase 5: Execution + Provider Fixes (15 issues)

### Task 5.1: Provider Execution Fixes

**Files:**
- Modify: `server/providers/execute-hashline.js:756,775` (AbortController never triggered)
- Modify: `server/providers/execute-cli.js:855-863` (race → null deref after earlySpawnError)
- Modify: `server/providers/execute-ollama.js:309` (wrong ID in decrementHostTasks)
- Modify: `server/providers/execute-hashline.js:1100-1108` + `server/providers/execute-ollama.js` (workflow termination not called)

- [ ] **Step 1:** Add timeout and cancel polling wiring around `abortController` in `executeHashlineOllamaTask`
- [ ] **Step 2:** Guard `procRef` null check after earlySpawnError re-emit in execute-cli.js
- [ ] **Step 3:** Use `selection.host.id` instead of `selectedHostId` in the race-failure decrement path
- [ ] **Step 4:** Add `handleWorkflowTermination(taskId)` calls to execute-ollama.js success/failure paths
- [ ] **Step 5:** Commit `fix(providers): abort wiring, spawn race guard, host ID, workflow termination`

### Task 5.2: Memory + Event Listener Leak Fixes

**Files:**
- Modify: `server/mcp-sse.js:1702,1719` (model listeners not removed — also in Task 3.1)
- Modify: `server/index.js:787` (onShutdown listener accumulation)
- Modify: `server/dashboard-server.js:75-76` (staticFileCache unbounded)
- Modify: `server/execution/fallback-retry.js:370` (_stallRecoveryAttempts not cleaned on cancel)

- [ ] **Step 1:** Deduplicate `eventBus.onShutdown` in index.js — remove before re-adding
- [ ] **Step 2:** Add `STATIC_FILE_CACHE_MAX_ENTRIES = 200` cap to staticFileCache
- [ ] **Step 3:** Add `_stallRecoveryAttempts.delete(taskId)` to task-cancellation.js alongside existing cleanup
- [ ] **Step 4:** Commit `fix(resources): listener dedup, cache cap, stall recovery cleanup`

### Task 5.3: Workflow Runtime + Plan Resolver Fixes

**Files:**
- Modify: `server/execution/workflow-runtime.js:898-902` (empty rollback try block)
- Modify: `server/execution/workflow-runtime.js:163-170` (null check on re-fetched project)
- Modify: `server/execution/plan-project-resolver.js:49-55` (null dashboard guard)
- Modify: `server/handlers/integration/routing.js:1157,1170` (dead safeFiles || files)
- Modify: `server/handlers/integration/routing.js:239-247` (mirostat Math.trunc contradiction)

- [ ] **Step 1:** Remove empty inner try/catch in `unblockTask`, keep outer catch
- [ ] **Step 2:** Add `if (!updatedProject) return;` after re-fetch in handlePlanProjectTaskCompletion
- [ ] **Step 3:** Add `if (!_dashboard) return;` guard in plan-project-resolver's notifyTaskUpdated
- [ ] **Step 4:** Remove dead `safeFiles || files` — just use `safeFiles`
- [ ] **Step 5:** Fix mirostat validator: remove `Math.trunc` dead code, keep integer check
- [ ] **Step 6:** Commit `fix(execution): empty rollback, null guards, dead code, mirostat validator`

---

## Phase 6: SQL + Query Performance (6 issues)

### Task 6.1: Query Fixes

**Files:**
- Modify: `server/db/task-metadata.js:435-451` (getRetryableTasks no default LIMIT)
- Modify: `server/db/task-metadata.js:347` (getAllTags full scan including archived)
- Modify: `server/db/scheduling-automation.js:738-744` (re-prepared statements in loop)
- Modify: `server/db/scheduling-automation.js:115,258,313` (mixed datetime sources)
- Modify: `server/db/event-tracking.js:553,559,569` (unbounded export SELECT + N+1)

- [ ] **Step 1:** Add `LIMIT 1000` default to `getRetryableTasks`
- [ ] **Step 2:** Add `AND archived = 0` filter to `getAllTags`
- [ ] **Step 3:** Hoist prepared statements above the loop in `processAutoApprovals`
- [ ] **Step 4:** Standardize datetime writes to `new Date().toISOString()` in scheduling-automation
- [ ] **Step 5:** Add LIMIT to export queries, batch pipeline step fetches
- [ ] **Step 6:** Commit `fix(sql): query limits, archived filter, prepared statement hoisting, datetime consistency`

---

## Phase 7: Test Quality Round 2 (30 issues)

### Task 7.1: Fix Mock Shape Mismatches + State Leaks

**Files:** audit-handlers.test.js, orchestrator-handlers.test.js, evaluation-store.test.js, chaos-concurrent-access.test.js, dashboard-admin-routes.test.js, instance-manager.test.js, provider-health.test.js, load-stress-stall.test.js

- [ ] **Step 1:** Fix audit-handlers mock to return `{ findings: [...], total: 1 }` not bare array
- [ ] **Step 2:** Remove redundant `vi.doMock` in orchestrator-handlers (keep require.cache injection only)
- [ ] **Step 3:** Add catch-all fallback to evaluation-store mock SQL parser
- [ ] **Step 4:** Add `delete require.cache` before re-require in chaos-concurrent-access
- [ ] **Step 5:** Add afterAll fs mock cleanup in dashboard-admin-routes
- [ ] **Step 6:** Add `beforeEach` reset in provider-health (not just afterEach)
- [ ] **Step 7:** Save/restore OPENAI_API_KEY in load-stress-stall
- [ ] **Step 8:** Commit `fix(tests): mock shapes, state isolation, env cleanup`

### Task 7.2: Fix Timing + Implementation Detail Tests

**Files:** execute-hashline.test.js, execute-ollama.test.js, fallback-retry.test.js, groq-provider.test.js, event-dispatch.test.js, validation-rules.test.js, file-tracking.test.js, automation-handlers-batch.test.js, audit-categories.test.js

- [ ] **Step 1:** Replace `vi.useFakeTimers()` with real timers in tests using mockOllama HTTP server
- [ ] **Step 2:** Remove hardcoded model count assertion in groq-provider
- [ ] **Step 3:** Replace inline rate-limit arithmetic in event-dispatch with actual handler calls
- [ ] **Step 4:** Fix validation-rules test that enshrines `info` severity bug — assert `true` and fix `|| 1` → `?? 1`
- [ ] **Step 5:** Fix file-tracking test name/assertion mismatch (null vs undefined)
- [ ] **Step 6:** Move file setup into beforeEach in automation-handlers-batch
- [ ] **Step 7:** Replace hardcoded category count with `toBeGreaterThanOrEqual(1)` in audit-categories
- [ ] **Step 8:** Commit `fix(tests): timing isolation, implementation-independent assertions`

### Task 7.3: Dashboard Test + Accessibility

**Files:** dashboard views (Providers.jsx, Kanban.jsx, History/Approvals/Schedules/Coordination/BatchHistory/Strategy), KeyboardShortcuts.jsx, Hosts.jsx

- [ ] **Step 1:** Fix Providers.jsx: store setTimeout IDs in ref, clear on unmount
- [ ] **Step 2:** Wrap Kanban `handleAction` in useCallback
- [ ] **Step 3:** Remove dead `color` prop from KanbanColumn
- [ ] **Step 4:** Add `aria-sort` to all 6 SortHeader components
- [ ] **Step 5:** Add focus trapping to confirmation dialogs (Schedules, Approvals, RoutingTemplates, Hosts, PlanProjects, ShortcutHelpOverlay)
- [ ] **Step 6:** Add mountedRef guard to Hosts.jsx model approval fire-and-forget chain
- [ ] **Step 7:** Commit `fix(dashboard): timer cleanup, useCallback, aria-sort, focus traps`

---

## Execution Summary

| Phase | Issues | Complexity | Parallelizable | Tasks |
|-------|--------|------------|----------------|-------|
| 1: Schema + Security | 18 | Manual review | No (sequential) | 4 |
| 2: Logic + Lifecycle | 16 | Mechanical | Yes (3 parallel) | 3 |
| 3: MCP + Transport | 14 | Mechanical | Yes (2 parallel) | 2 |
| 4: Tool Schemas | 18 | Mechanical | Yes (2 parallel) | 2 |
| 5: Execution + Leaks | 15 | Mechanical | Yes (3 parallel) | 3 |
| 6: SQL + Performance | 6 | Mechanical | Yes (1 task) | 1 |
| 7: Test Quality | 30 | Mechanical | Yes (3 parallel) | 3 |
| **Total** | **159** | | | **18 tasks** |

**Cross-references:**
- Round 1 plan: `2026-03-20-full-codebase-remediation.md` (507 issues, 350 fixed)
- This plan covers the 159 net-new issues from the Round 2 deep-dive review
