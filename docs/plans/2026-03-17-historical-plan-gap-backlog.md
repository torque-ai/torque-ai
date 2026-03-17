# Historical Plan Gap Backlog

**Date:** 2026-03-17
**Method:** Full functional inventory (tool def → handler → DB function → wiring → actual usage)
**Source Plans:** 13 design documents from January–March 2026 in `projects/torque/docs/archive/plans/`

---

## Severity Legend

| Level | Meaning |
|-------|---------|
| **CRITICAL** | Feature infrastructure exists but is broken/unwired — users expect it to work |
| **HIGH** | Planned feature partially implemented — value left on the table |
| **MEDIUM** | Minor UI/wiring gap — backend works, frontend/integration incomplete |
| **LOW** | Nice-to-have from original plan, superseded or deprioritized |

---

## CRITICAL — Broken Wiring

### C-1: Task Intelligence handlers have argument mismatches (15 of 26 tools)
- **Source Plan:** Wave 5 Task Intelligence (2026-01-18)
- **Problem:** Handler layer (`server/handlers/advanced/intelligence.js`) passes objects with named fields; DB layer (`server/db/analytics.js`, `server/db/project-cache.js`) expects positional parameters. 15 tools crash at runtime with TypeErrors.
- **Affected Tools:** cache_task_result, lookup_cache, warm_cache, compute_priority, get_priority_queue, boost_priority, predict_failure, learn_failure_pattern, suggest_intervention, analyze_retry_patterns, get_retry_recommendation, retry_with_adaptation, intelligence_dashboard, create_experiment, conclude_experiment
- **Working Tools (10):** invalidate_cache, cache_stats, configure_cache, configure_priority_weights, explain_priority, list_failure_patterns, delete_failure_pattern, apply_intervention, configure_adaptive_retry, experiment_status
- **Fix:** Align handler call signatures with DB function signatures across `intelligence.js`. Straightforward but extensive refactor.
- **Impact:** The entire caching, priority queue, failure prediction, adaptive retry, and A/B experiment system is non-functional despite complete DB implementations.

### C-2: User cron schedules never fire
- **Source Plan:** Scheduling (archived docs, Jan 2026)
- **Problem:** `getDueScheduledTasks()` exists in `server/db/scheduling-automation.js:1607` and is exported, but no timer loop in `server/index.js` calls it. The maintenance scheduler loop at `index.js:756` only calls `getDueMaintenanceTasks()` for system maintenance. User-created cron schedules (via `create_cron_schedule`) are stored with correct next-run calculations but never executed.
- **Fix:** Add `getDueScheduledTasks()` call to the existing 60-second maintenance loop in `index.js`, and wire each due schedule to `smart_submit_task`.
- **Impact:** The Schedules dashboard view is display-only. Users can create/toggle/delete schedules but they never run.

### C-3: Multi-Agent background jobs not wired to scheduler
- **Source Plan:** Wave 6 Multi-Agent Coordination (2026-01-18)
- **Problem:** Three critical coordination functions exist with complete implementations and unit tests but are **not called by any setInterval** in `server/index.js`:
  - `checkOfflineAgents()` at `coordination.js:233` — marks agents offline after missed heartbeats
  - `expireStaleLeases()` at `coordination.js:458` — expires active claims past lease deadline
  - `cleanupExpiredLocks()` at `coordination.js:1341` — removes expired distributed locks
- **Fix:** Add `setInterval` calls in `server/index.js` startup — 30s for offline/lease checks, 5min for lock cleanup (matching the Wave 6 plan).
- **Impact:** Agent heartbeat failure detection, lease-based task recovery, and lock cleanup are all dead code. Task claims can expire in the DB but nothing acts on it.

### C-4: intelligence_dashboard field name mismatch
- **Source Plan:** Wave 5 / Scheduling & Analytics
- **Problem:** Handler at `server/handlers/advanced/intelligence.js:846` reads `dashboard.priority.*` and `dashboard.retry.*`, but DB function at `server/db/analytics.js:1191` returns `{ cache, predictions, patterns, experiments }`. Prioritization and Adaptive Retries sections render undefined values.
- **Fix:** Align handler field reads with DB return shape, or extend DB function to return `priority` and `retry` sections.
- **Impact:** intelligence_dashboard MCP tool returns partially broken output.

---

## HIGH — Missing Planned Features

### H-1: pause_workflow not enforced in runtime
- **Source Plan:** Wave 4 Task Dependencies (2026-01-17)
- **Problem:** `handlePauseWorkflow` sets workflow status to 'paused' in DB, but `evaluateWorkflowDependencies()` at `workflow-runtime.js:744` checks `['completed', 'failed', 'cancelled']` — NOT 'paused'. When a running task completes in a paused workflow, its dependents still get unblocked and started.
- **Fix:** Add `'paused'` check in `evaluateWorkflowDependencies` and `unblockTask` to skip unblocking when workflow is paused.
- **Impact:** Pause is cosmetic — tasks still cascade.

### H-2: Coordination routing rules namespace collision
- **Source Plan:** Wave 6 Multi-Agent Coordination (2026-01-18)
- **Problem:** `list_routing_rules` and `delete_routing_rule` MCP tools are wired to the smart provider routing system (in `integration/routing.js`), NOT the agent-level `task_routing_rules` table from Wave 6. The DB functions `listRoutingRules` and `deleteRoutingRule` in `coordination.js` exist and work correctly but are shadowed.
- **Fix:** Either rename the agent-level tools (e.g., `list_agent_routing_rules`) or add a `scope` parameter to disambiguate.
- **Impact:** Agent-level routing rules can be created but not listed or deleted via MCP tools.

### H-3: Periodic agent metrics collection and rebalancing not implemented
- **Source Plan:** Wave 6 Multi-Agent Coordination (2026-01-18)
- **Problem:** `recordAgentMetric()` function exists at `coordination.js:1002` but no periodic job collects metrics. `rebalance_threshold_percent` config exists in failover_config seeds but no rebalancing job exists.
- **Fix:** Add 5-minute `setInterval` for metrics aggregation and optional rebalancing (gated by `auto_rebalance_enabled` config).
- **Impact:** Agent performance trends cannot be tracked over time; load imbalances are not auto-corrected.

### H-4: log_intelligence_outcome tool def/handler mismatch
- **Source Plan:** Wave 5 Task Intelligence (2026-01-18)
- **Problem:** Tool def expects `{log_id, outcome}` for updating prediction accuracy. Handler expects `{task_id, operation, outcome, details}` and calls generic `db.recordEvent()`. The planned feedback loop for adjusting pattern confidence via `updateIntelligenceOutcome(logId, outcome)` (which exists in `analytics.js:887`) is not wired.
- **Fix:** Align tool def/handler to call `updateIntelligenceOutcome` for the feedback loop.
- **Impact:** Failure prediction confidence never self-calibrates from outcomes.

### H-5: codex_exhausted state not visible in dashboard
- **Source Plan:** Local LLM Priority Routing (2026-02-22)
- **Problem:** No references to `codex_exhausted` in any dashboard source files. When Codex quota is exhausted, users have no visual indicator in the Providers dashboard view.
- **Fix:** Add exhaustion banner/indicator to `dashboard/src/views/Providers.jsx`.
- **Impact:** Users must use MCP tools to discover Codex is exhausted.

---

## MEDIUM — Dashboard/UI Gaps

### M-1: PlanProjects visual dependency graph missing
- **Source Plan:** Project Task Queue (2026-01-20)
- **Problem:** `PlanProjects.jsx` shows tasks as a flat list with text references (`depends on: #1, #3`). No visual dependency graph despite `WorkflowDAG.jsx` existing for workflow visualization.
- **Fix:** Integrate `WorkflowDAG.jsx` component into the PlanProjects detail view.
- **Impact:** Plan project dependencies are harder to understand at a glance.

### M-2: Dashboard Budget.jsx not using getCostForecast API
- **Source Plan:** Advanced Features Sprint (2026-03-01)
- **Problem:** Dashboard computes naive `dailyAvg * 30` client-side instead of consuming the server-side `getCostForecast` API which has linear regression and trend analysis.
- **Fix:** Wire Budget.jsx "Projected Monthly" StatCard to the `/api/v2/cost-forecast` endpoint.
- **Impact:** Cost projections are less accurate than they could be.

### M-3: Dashboard Models.jsx not using get_model_leaderboard API
- **Source Plan:** Advanced Features Sprint (2026-03-01)
- **Problem:** Models.jsx shows per-model data from general stats endpoint. The `get_model_leaderboard` MCP tool/REST endpoint exists but is not wired into the dashboard. No dedicated "Leaderboard" tab.
- **Fix:** Add Leaderboard tab to Models.jsx consuming the leaderboard endpoint.
- **Impact:** Model performance comparison is less discoverable.

### M-4: PlanProjects import modal missing file picker
- **Source Plan:** Project Task Queue (2026-01-20)
- **Problem:** Import UI only has textarea for pasting markdown. No file upload/picker control.
- **Fix:** Add file input element alongside the textarea.
- **Impact:** Minor UX convenience.

### M-5: PlanProjects preview tasks not editable
- **Source Plan:** Project Task Queue (2026-01-20)
- **Problem:** Parsed task descriptions render as plain text, not editable inputs. Users cannot modify individual task descriptions before creating the project.
- **Fix:** Replace `<span>` with editable inputs in the preview section.
- **Impact:** Minor UX — users must edit tasks after creation.

### M-6: ANSI terminal follow mode toggle missing
- **Source Plan:** Advanced Features Sprint (2026-03-01)
- **Problem:** Auto-scroll is automatic on new streaming data with a manual "scroll to bottom" button. No explicit Follow on/off toggle.
- **Fix:** Add toggle button that enables/disables auto-scroll behavior.
- **Impact:** Minor UX.

### M-7: coordination_dashboard missing REST passthrough route
- **Source Plan:** Wave 6 Multi-Agent Coordination (2026-01-18)
- **Problem:** Tool is accessible via V2 control plane dispatch but has no REST passthrough in `routes-passthrough.js`. Dashboard Coordination.jsx may not be able to call it from the REST API.
- **Fix:** Add REST passthrough route for coordination_dashboard.
- **Impact:** Dashboard may need workaround to access coordination stats.

---

## LOW — Superseded or Deprioritized

### L-1: waiting_for_codex tag for queued complex tasks
- **Source Plan:** Local LLM Priority Routing (2026-02-22)
- **Problem:** When Codex is exhausted, complex tasks either route to local LLM or get rejected. The planned `waiting_for_codex` queue tag was never implemented.
- **Reason:** The current immediate routing decision is arguably better than queueing indefinitely.
- **Action:** Consider if this is still wanted.

### L-2: local_llm_preferred_complexity config key
- **Source Plan:** Local LLM Priority Routing (2026-02-22)
- **Problem:** Replaced by the more flexible `complexity_routing` table.
- **Reason:** Table-driven routing is more configurable.
- **Action:** No action needed — superseded by better approach.

### L-3: reopen_workflow tool stub
- **Source Plan:** Bonus feature (not in Wave 4 plan)
- **Problem:** Tool definition exists at `workflow-defs.js:540` but no handler. Tracked in `EXPECTED_UNMAPPED_TOOLS`.
- **Action:** Either implement handler or remove the tool definition.

### L-4: test_inbound_webhook tool
- **Source Plan:** Advanced Features Sprint (2026-03-01)
- **Problem:** 3 of 4 planned inbound webhook tools shipped. `test_inbound_webhook` was not implemented.
- **Fix:** Add tool that sends a test payload to a configured webhook for verification.
- **Impact:** Users must test webhooks manually.

### L-5: 6 config keys missing from VALID_CONFIG_KEYS
- **Source Plan:** Discovery (2026-01-21) + Auto-Start (2026-01-21)
- **Problem:** `discovery_advertise`, `discovery_browse`, `ollama_auto_start_enabled`, `ollama_auto_start_timeout_ms`, `ollama_binary_path`, `ollama_auto_detect_wsl_host` produce log warnings on `setConfig` calls.
- **Fix:** Add to `server/db/config-keys.js`.
- **Impact:** Log noise only — functionality is not blocked.

### L-6: Timezone support for cron schedules
- **Source Plan:** Scheduling (archived docs, Jan 2026)
- **Problem:** All cron schedules run in server-local time. No per-schedule IANA timezone support.
- **Fix:** Add `timezone` column to `scheduled_tasks`, use timezone-aware next-run calculation.
- **Impact:** Low if server timezone is acceptable; higher for distributed use.

### L-7: output_stats missing pattern/error frequency analysis
- **Source Plan:** Analytics (archived docs, Jan 2026)
- **Problem:** `output_stats` only computes size metrics, not content patterns or error frequency distributions as originally planned.
- **Fix:** Add regex-based error classification and frequency counting.
- **Impact:** Less insight into common failure patterns.

### L-8: No time-series anomaly detection
- **Source Plan:** Analytics (archived docs, Jan 2026)
- **Problem:** Plan mentioned "AI-driven insights with trends, anomalies, recommendations." Failure prediction and A/B testing exist, but no general time-series anomaly detection for task volumes or durations.
- **Action:** Consider if this complexity is justified.

### L-9: Percentile metrics (P50/P95/P99) not exposed as MCP tools
- **Source Plan:** Analytics (archived docs, Jan 2026)
- **Problem:** Percentile calculations exist in dashboard REST routes but are not exposed as MCP tools.
- **Fix:** Add MCP tool wrapping existing `handleProviderPercentiles`.
- **Impact:** Only affects MCP-only users; dashboard users already have access.

### L-10: workflow_history lacks dedicated event log
- **Source Plan:** Wave 4 Task Dependencies (2026-01-17)
- **Problem:** History is reconstructed from task timestamps. Events like "workflow paused" or "workflow resumed" are not captured.
- **Fix:** Add workflow-level events to coordination_events or a new table.
- **Impact:** Less granular audit trail for workflow state changes.

---

## Summary Statistics

| Severity | Count | Category |
|----------|-------|----------|
| CRITICAL | 4 | Broken wiring preventing planned features from working |
| HIGH | 5 | Partially implemented — significant value gaps |
| MEDIUM | 7 | Dashboard/UI integration gaps |
| LOW | 10 | Superseded, nice-to-have, or cosmetic |
| **TOTAL** | **26** | |

### Biggest Wins Available

1. **Fix C-1 (intelligence handler signatures)** — unlocks 15 tools with one refactor pass
2. **Fix C-2 (cron execution wiring)** — one `setInterval` addition makes scheduling actually work
3. **Fix C-3 (coordination background jobs)** — three `setInterval` additions make multi-agent coordination operational
4. **Fix H-1 (pause_workflow)** — one condition check makes workflow pause actually enforce

### Fully Shipped (no gaps)

- Smart Model Routing (all 4 features)
- Multi-Host Ollama Management
- Ollama Auto-Start
- mDNS/Bonjour Discovery (exceeds plan)
- Provider System (13 providers, exceeds original 2)
- Dashboard (16 views, exceeds original 4)
- Workflow core system (17/18 tools)
- Plan Import backend (all 6 tools + execution integration)
- Local-First Routing core logic
- All 8 Advanced Features (backend complete)
