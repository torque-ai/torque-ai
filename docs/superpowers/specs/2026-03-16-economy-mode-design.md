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

## Economy Policy Data Model

```json
{
  "enabled": true,
  "trigger": "manual | auto",
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
- Complex tasks exempt by default

## Policy Resolution & Scope Hierarchy

When a task is submitted, TORQUE resolves the effective economy policy by checking scopes in order (first non-null wins):

1. **Task-level** — `args.economy` on `submit_task` / `smart_submit_task`
2. **Workflow-level** — `workflow.economy_policy` JSON column
3. **Project-level** — `project_tuning.economy_policy` JSON column
4. **Global** — `config` table, key `economy_policy`

**Resolution function:** `resolveEconomyPolicy(taskArgs, workflowId, workingDirectory)` → returns effective policy or `null` (economy off).

**Storage locations:**
- Global: `config` table, key `economy_policy`
- Per-project: `project_tuning` table, `economy_policy` JSON column
- Per-workflow: `workflows` table, `economy_policy` JSON column
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
  │   │
  │   └─ economy on + simple/normal task?
  │       → filter providers to preferred + allowed
  │       → re-rank: preferred first, allowed second
  │       → pass filtered list into existing smart routing
  │
  └─ existing routing logic runs against filtered pool
```

**Economy fallback chain:** preferred → allowed. If ALL economy providers fail and the task isn't complexity-exempt, it fails with: "Task failed — all economy-tier providers exhausted. Disable economy mode or retry with a specific provider."

**Context stuffing:** No changes needed. Already activates automatically for free providers.

## Queue Re-routing on Activation

When economy mode activates at any scope:

1. Query `status = 'queued'` tasks in the affected scope
2. For each:
   - Skip if task has explicit provider override
   - Skip if complex + complexity_exempt
   - Re-run `analyzeTaskForRouting()` with new policy
   - Update `provider` column if changed
   - Log: `"Economy mode: task {id} re-routed {old} → {new}"`
3. Emit `economy:activated` event

On deactivation: do NOT re-route existing queued tasks. Only new submissions get full routing. Emit `economy:deactivated` event.

## Auto-trigger and Auto-lift

### Auto-trigger Conditions (any one triggers global economy)

1. **Budget threshold:** `isBudgetExceeded()` returns `warning: true` (utilization >= `auto_trigger_threshold`, default 85%)
2. **Codex exhaustion:** `isCodexExhausted()` returns true
3. **Cost forecast alarm:** `getCostForecast()` projects `days_remaining < 2`

Checked during the existing maintenance cycle in `index.js`.

### Auto-lift Conditions (ALL must be met)

1. `budget_reset: true` → budget period rolled over, utilization below threshold
2. `codex_recovered: true` → `probeCodexRecovery()` succeeded
3. `utilization_below: 50` → current spend below 50% of budget

### State Machine

```
         ┌──────────────────────────────────────┐
         │                                      │
    ┌────▼─────┐  auto-trigger   ┌──────────────┴──┐
    │   OFF    ├────────────────►│  AUTO-ECONOMY   │
    └────┬─────┘                 └───────┬─────────┘
         │                               │
         │  manual-on                    │ auto-lift conditions met
         │                               │
    ┌────▼──────────┐                    │
    │ MANUAL-ECONOMY│◄───────────────────┘
    └────┬──────────┘     (stays manual
         │                 if manually set)
         │  manual-off
         │
    ┌────▼─────┐
    │   OFF    │
    └──────────┘
```

Auto-triggered economy auto-lifts when conditions recover. Manual economy only lifts manually. If auto-economy is active and user manually enables economy, it becomes manual (won't auto-lift).

## Session Notification & MCP Integration

### Session-start notification

On new MCP SSE session connection, if economy mode is active, push:

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

When economy is off, no notification (no noise).

### State change notifications

Economy activation/deactivation mid-session pushes to all connected SSE sessions.

### New MCP tools

- **`get_economy_status`** — returns current resolved policy for a given scope
- **`set_economy_mode`** — toggle economy at any scope (global, project, workflow, task)

### Dashboard widget

Economy mode indicator in dashboard header:
- Green (off)
- Amber (auto-economy)
- Blue (manual-economy)

Click opens toggle panel with threshold configuration.

## Testing Strategy

### Unit tests (~20)

- `resolveEconomyPolicy()` — scope hierarchy, null handling, partial overrides
- `filterProvidersForEconomy()` — preferred/allowed/blocked, complexity exemption
- Auto-trigger detection — budget threshold, codex exhaustion, cost forecast
- Auto-lift evaluation — all conditions met, manual never auto-lifts
- Queue re-routing — skips running, skips explicit overrides, skips complex+exempt

### Integration tests (~15)

- `smart_submit_task` + economy → cheap provider
- `smart_submit_task` + economy + complex → normal routing (exempt)
- Activate → queued re-routed, running untouched
- Budget threshold → auto-trigger → budget reset → auto-lift
- Manual economy + auto-lift conditions → stays manual
- Session connect → receives notification
- `set_economy_mode` via MCP → policy persisted, queue re-routed

### E2E test (~2)

- Dashboard toggle → indicator changes, routing changes

## Files to Create/Modify

### New files
- `server/economy/policy.js` — policy data model, resolution, state machine
- `server/economy/triggers.js` — auto-trigger detection, auto-lift evaluation
- `server/economy/queue-reroute.js` — re-routing logic on activation
- `server/handlers/economy-handlers.js` — MCP tool handlers (get_economy_status, set_economy_mode)
- `server/tool-defs/economy-defs.js` — tool definitions
- `server/tests/economy-policy.test.js` — unit tests
- `server/tests/economy-integration.test.js` — integration tests
- `dashboard/src/components/EconomyIndicator.jsx` — header widget
- `dashboard/e2e/economy.spec.js` — E2E test

### Modified files
- `server/db/provider-routing-core.js` — add `resolveEconomyPolicy()` call in `analyzeTaskForRouting()`
- `server/db/schema-migrations.js` — add `economy_policy` columns to `project_tuning` and `workflows`
- `server/db/schema-seeds.js` — seed default economy policy config
- `server/index.js` — add auto-trigger checks to maintenance cycle
- `server/mcp-sse.js` — push economy notification on session connect
- `server/tools.js` — register economy handlers
- `server/handlers/task/core.js` — pass economy arg through to routing
- `dashboard/src/components/Layout.jsx` — add EconomyIndicator to header
