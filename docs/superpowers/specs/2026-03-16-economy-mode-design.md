# TORQUE Economy Mode — Design Spec

**Date:** 2026-03-16
**Status:** Approved (pending implementation)

## Overview

Economy mode is a routing policy that shifts task execution from expensive providers (Codex, Claude CLI, Anthropic) to free/cheap alternatives (local Ollama, Groq, Google AI, OpenRouter, DeepInfra) when budget is tight or the user explicitly opts in. It preserves quality for complex tasks via a complexity exemption.

## Motivation

TORQUE has all the building blocks for cost-aware routing — budget tracking, free provider context stuffing, codex overflow, fallback chains — but no unified mechanism to activate them together. Users need a single switch that says "save money" without manually re-routing every task.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Activation | Auto (budget/quota triggers) + Manual (dashboard/CLI/MCP) | Covers both "I'm out of tokens" and "I want to save" |
| Scope hierarchy | Global < Project < Workflow < Task | Most specific wins; Claude Code can set per-task |
| Queue behavior | Re-route queued tasks on activation; leave running tasks alone | Immediate savings without disrupting in-progress work |
| Complex tasks | Exempt — routed normally even in economy | Quality where it matters, savings on the bulk |
| Provider selection | Quality-optimized free — smart routing restricted to cheap pool | Same routing intelligence, smaller provider set |
| Auto-lift | Auto-triggered economy auto-lifts; manual stays manual | Symmetric: auto problems auto-resolve; deliberate choices persist |
| Session notification | Push economy state to MCP sessions on connect and on state change | Claude Code knows constraints before submitting tasks |
| Re-route on deactivation | No — existing assignments stay | Avoids churn; cheap providers can handle the work |
| Relationship to `preferFree` | Economy mode subsumes `preferFree`; when economy is active, `preferFree` is redundant | Economy adds `allowed` tier (cheap-but-not-free) on top of what `preferFree` does |

## Economy Policy Data Model

```json
{
  "enabled": true,
  "trigger": "manual | auto",
  "reason": "Budget utilization at 87% (threshold: 85%)",
  "auto_trigger_threshold": 85,
  "auto_lift_conditions": {
    "budget_reset": true,
    "codex_recovered": true,
    "utilization_below": 50
  },
  "complexity_exempt": true,
  "provider_tiers": {
    "preferred": ["hashline-ollama", "aider-ollama", "ollama", "google-ai", "groq", "openrouter", "ollama-cloud", "cerebras"],
    "allowed": ["deepinfra", "hyperbolic"],
    "blocked": ["codex", "claude-cli", "anthropic"]
  }
}
```

**Defaults:**
- `preferred`: local ollama variants + free cloud APIs
- `allowed`: cheap cloud inference (DeepInfra at $0.13/M tokens, Hyperbolic)
- `blocked`: expensive providers (Codex, Claude CLI, Anthropic)
- Complex tasks exempt by default (uses `determineTaskComplexity()` from `server/db/host-complexity.js` — tasks returning `'complex'` are exempt)
- `reason` field persisted alongside policy for debugging/display

## Policy Resolution & Scope Hierarchy

When a task is submitted, TORQUE resolves the effective economy policy by checking scopes in order (first non-null wins):

1. **Task-level** — `args.economy` on `submit_task` / `smart_submit_task`
2. **Workflow-level** — `workflow.economy_policy` JSON column
3. **Project-level** — stored inside `project_tuning.settings_json` under key `economy_policy` (follows existing pattern — all project settings use the JSON blob)
4. **Global** — `config` table, key `economy_policy`

**Resolution function:** `resolveEconomyPolicy(taskArgs, workflowId, workingDirectory)` → returns effective policy or `null` (economy off).

**Storage locations:**
- Global: `config` table, key `economy_policy`
- Per-project: `project_tuning.settings_json` → `economy_policy` key (existing JSON pattern)
- Per-workflow: `workflows` table, new `economy_policy` TEXT column (no existing JSON settings column)
- Per-task: passed as argument (not persisted as policy)

## Routing Integration

Economy mode plugs into the existing `analyzeTaskForRouting()` flow as a pre-filter. No new routing algorithm.

```
analyzeTaskForRouting(description, args)
  │
  ├─ resolveEconomyPolicy(args, workflowId, workingDir)
  │   │
  │   ├─ economy off? → proceed normally
  │   │
  │   ├─ economy on + complex task + complexity_exempt?
  │   │   → proceed normally (bypass)
  │   │   (complexity determined by determineTaskComplexity() === 'complex')
  │   │
  │   └─ economy on + simple/normal task?
  │       → filter providers to preferred + allowed
  │       → re-rank: preferred first, allowed second
  │       → pass filtered list into existing smart routing
  │
  └─ existing routing logic runs against filtered pool
```

**Economy fallback chain:** preferred → allowed. If ALL economy providers fail and the task isn't complexity-exempt, it is marked `failed` with error message: "Task failed — all economy-tier providers exhausted. Disable economy mode or retry with a specific provider." No automatic retry with blocked providers — the user opted into economy constraints. The task can be manually retried with an explicit provider override after economy is lifted.

**Context stuffing:** No changes needed. Already activates automatically for free providers.

## Queue Re-routing on Activation

When economy mode activates at any scope:

1. Query `status = 'queued'` tasks in the affected scope
2. Run inside a SQLite transaction to prevent partial updates from concurrent activations
3. For each:
   - Skip if task has explicit provider override (`args.provider` was set by user)
   - Skip if complex + complexity_exempt
   - Re-run `analyzeTaskForRouting()` with new policy
   - Update `provider` column if changed
   - Log: `"Economy mode: task {id} re-routed {old} → {new}"`
4. Emit `economy:activated` event

On deactivation: do NOT re-route existing queued tasks. Only new submissions get full routing. Emit `economy:deactivated` event.

## Auto-trigger and Auto-lift

### Auto-trigger Conditions (any one triggers global economy)

1. **Budget threshold:** New wrapper `isEconomyBudgetThresholdMet()` checks all active budgets against `auto_trigger_threshold` from the economy policy (default 85%). This is separate from the per-budget `alert_threshold_percent` used by `isBudgetExceeded()` — economy has its own threshold to avoid coupling.
2. **Codex exhaustion:** `isCodexExhausted()` returns true (existing, synchronous)
3. **Cost forecast alarm:** `getCostForecast()` projects `days_remaining < 2` (existing, synchronous)

Checked during the existing maintenance cycle in `index.js`. All three checks are synchronous.

### Auto-lift Conditions (ALL configured conditions must be met)

1. `budget_reset: true` → budget period rolled over, utilization below `utilization_below` threshold
2. `codex_recovered: true` → Codex recovery flag set by existing `probeCodexRecovery()` in `host-monitoring.js` (async, runs on its own interval). Auto-lift checks the synchronous `isCodexExhausted() === false` flag rather than calling the probe directly.
3. `utilization_below: 50` → current spend below 50% of budget

Auto-lift evaluation is **fully synchronous** — it reads flags set by async probes, never calls async functions itself. Safe for the maintenance cycle's `setInterval` callback.

### State Machine

```
    ┌──────────┐  auto-trigger   ┌───────────────┐
    │   OFF    ├────────────────►│ AUTO-ECONOMY  │
    └──┬───▲───┘                 └──┬────────────┘
       │   │                        │
       │   │  manual-off            │ auto-lift conditions met
       │   │                        │
       │   │  ┌───────────────┐     │
       │   └──┤MANUAL-ECONOMY │◄────┘ (only if user manually
       │      └───────────────┘        activated during auto)
       │         ▲
       │         │
       └─────────┘
        manual-on
```

**Transition rules:**
- **OFF → AUTO-ECONOMY:** auto-trigger fires
- **OFF → MANUAL-ECONOMY:** user manually enables
- **AUTO-ECONOMY → OFF:** auto-lift conditions met
- **AUTO-ECONOMY → MANUAL-ECONOMY:** user manually enables while auto is active (becomes manual, won't auto-lift)
- **MANUAL-ECONOMY → OFF:** user manually disables
- **AUTO-ECONOMY + auto-trigger fires again:** no-op (already in economy)
- **MANUAL-ECONOMY + auto-trigger fires:** no-op (manual takes precedence, already in economy)
- **MANUAL-ECONOMY + auto-lift conditions met:** no-op (manual doesn't auto-lift)

## Session Notification & MCP Integration

### Session-start notification

On new MCP SSE session connection, if economy mode is active at **global** scope, push:

```json
{
  "type": "economy_status",
  "enabled": true,
  "trigger": "auto",
  "scope": "global",
  "reason": "Budget utilization at 87% (threshold: 85%)",
  "blocked_providers": ["codex", "claude-cli", "anthropic"],
  "preferred_providers": ["hashline-ollama", "google-ai", "groq"]
}
```

When economy is off at global scope, no notification (no noise).

**Project-scope visibility:** Project-level economy is not visible at session connect time (sessions don't know their project yet). Instead, when `get_economy_status` is called with a `working_directory`, it resolves the full scope chain including project-level policy. Claude Code should call `get_economy_status` before submitting batches to check project-specific economy state.

Additionally, `get_economy_status` returns the **effective provider pool** — not just the policy tiers, but which providers are actually enabled, healthy, and available within the economy constraints. This helps Claude Code decide whether to submit or wait.

### State change notifications

Economy activation/deactivation mid-session pushes to all connected SSE sessions.

### New MCP tools

- **`get_economy_status`** — returns current resolved policy for a given scope, including effective available providers and activation reason
- **`set_economy_mode`** — toggle economy at any scope (global, project, workflow, task)

### Dashboard widget

Economy mode indicator in dashboard header:
- Green dot (off)
- Amber dot (auto-economy)
- Blue dot (manual-economy)

Click opens toggle panel with threshold configuration. When viewing a project-specific page, shows project-level economy badge if active.

## Testing Strategy

### Unit tests (~25)

- `resolveEconomyPolicy()` — scope hierarchy, null handling, partial overrides
- `filterProvidersForEconomy()` — preferred/allowed/blocked, complexity exemption
- `isEconomyBudgetThresholdMet()` — threshold at 0, 85, 100; no budgets; multiple budgets
- Auto-trigger detection — budget threshold, codex exhaustion, cost forecast
- Auto-lift evaluation — all conditions met, partial conditions, manual never auto-lifts
- State machine transitions — all 7 transition rules including no-ops
- Queue re-routing — skips running, skips explicit overrides, skips complex+exempt
- Edge cases — empty preferred list, complexity_exempt=false, concurrent scope activations

### Integration tests (~15)

- `smart_submit_task` + economy → cheap provider
- `smart_submit_task` + economy + complex → normal routing (exempt)
- `smart_submit_task` + economy + explicit provider override → respects override
- Activate → queued re-routed, running untouched
- Budget threshold → auto-trigger → budget reset → auto-lift
- Manual economy + auto-lift conditions → stays manual
- Session connect during economy → receives notification
- `set_economy_mode` via MCP → policy persisted, queue re-routed
- Economy activated during `await_workflow` → next task picks up new policy

### E2E test (~2)

- Dashboard toggle → indicator changes, routing changes

## Files to Create/Modify

### New files
- `server/economy/policy.js` — policy data model, resolution, state machine
- `server/economy/triggers.js` — auto-trigger detection, auto-lift evaluation (`isEconomyBudgetThresholdMet()`)
- `server/economy/queue-reroute.js` — re-routing logic on activation (runs in transaction)
- `server/handlers/economy-handlers.js` — MCP tool handlers (get_economy_status, set_economy_mode)
- `server/tool-defs/economy-defs.js` — tool definitions
- `server/tests/economy-policy.test.js` — unit tests
- `server/tests/economy-integration.test.js` — integration tests
- `dashboard/src/components/EconomyIndicator.jsx` — header widget
- `dashboard/e2e/economy.spec.js` — E2E test

### Modified files
- `server/db/provider-routing-core.js` — add economy policy filter in `analyzeTaskForRouting()`
- `server/db/schema-migrations.js` — add `economy_policy` column to `workflows` table
- `server/db/schema-seeds.js` — seed default economy policy config
- `server/db/project-config-core.js` — expose economy_policy through `getProjectDefaults()` / `setProjectDefaults()`
- `server/index.js` — add auto-trigger/auto-lift checks to maintenance cycle
- `server/mcp-sse.js` — push economy notification on session connect
- `server/tools.js` — register economy handlers
- `server/handlers/task/core.js` — pass economy arg through to routing
- `server/handlers/integration/routing.js` — flow economy args into `analyzeTaskForRouting()`
- `dashboard/src/components/Layout.jsx` — add EconomyIndicator to header
