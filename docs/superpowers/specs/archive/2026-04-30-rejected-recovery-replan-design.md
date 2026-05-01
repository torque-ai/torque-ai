# Rejected-Item Replan Recovery — Design

**Status:** spec
**Date:** 2026-04-30
**Branch:** `feat/recover-rejected-replan`
**Worktree:** `.worktrees/feat-recover-rejected-replan`

## Problem

Over the lifetime of a factory project, work items get rejected. The existing `server/factory/rejected-recovery.js` sweep auto-reopens *infrastructure* failures (worktree lost, verify failed, task crashed) — but explicitly excludes *idea-side* failures: `cannot_generate_plan:*`, `replan_generation_failed`, `plan_quality_gate_rejected_after_2_attempts`, `pre_written_plan_rejected_by_quality_gate`, `meta_task_no_code_output`, `zero_diff_across_retries`, `retry_off_scope`, and manual user rejections. Items in those categories are a one-way trip to terminal state. Useful ideas are lost.

The factory's stated goal is "ship/complete everything eventually." A class of rejections — where the *idea* was valid but the *plan* or *execution* failed — currently has no path back. This design adds one.

## Goals

1. Recover almost all rejected/unactionable items (excluding only `meta_task_no_code_output`), branching the recovery strategy by reject reason so round-N is meaningfully different from round-1.
2. Cap auto-recovery attempts; route exhausted items to a human-triage "inbox" instead of silently dying.
3. Treat manual user rejections the same as auto-rejections (operator's past-self decision is not a permanent veto).
4. Preserve full history (descriptions, plans, lint failures, prior recovery attempts) so each replan is informed by what came before.
5. Land disabled, pilot one project, then open the gate. No data migration required for rollback.

## Non-Goals

- Recovering `meta_task_no_code_output` items (genuinely not actionable — these are intake meta-tasks).
- Replacing the existing `rejected-recovery.js` infra-failure sweep — that path stays as-is.
- Building a dashboard panel for the inbox (status filter is enough for v1).
- Persisting plan markdown into the DB — strategies read from existing on-disk plan artifacts.
- Cross-project recovery prioritization (per-project + global throttles are the only fairness mechanism).

## Approach

Strategy registry + single dispatcher, mirroring the existing `server/factory/auto-recovery/registry.js` pattern. Per-reason strategy modules declare which reject reasons they own and implement a uniform `replan(workItem, history, deps)` contract. The dispatcher sweeps eligible items, applies cooldown + hard-cap + throttling, dispatches to the strategy, and routes exhausted items to a `needs_review` inbox.

## Architecture

```
factory-tick.js (every tick)
  ├── rejected-recovery.js          UNCHANGED: infra-failure recovery
  │
  └── replan-recovery.js (NEW)      idea-failure recovery
        ├── eligibility query (cooldown + hard-cap + throttles + mutex)
        ├── recovery-strategies/registry.js
        │     ├── rewrite-description.js
        │     ├── decompose.js
        │     └── escalate-architect.js
        └── outcomes
              ├── rewrote/escalated → status: pending
              ├── split             → parent: superseded, children: pending
              ├── unrecoverable     → status: needs_review (inbox)
              └── strategy failed   → no status change, cooldown advances
```

**Boundaries:**
- `rejected-recovery.js` and `replan-recovery.js` operate on disjoint reject-reason sets. Asserted at startup; future drift surfaces immediately.
- The strategy registry refuses to register two handlers for the same reject reason.
- The inbox (`needs_review`) is terminal for the sweep — only operator action moves items out.

## Files

**New:**
- `server/factory/replan-recovery.js`
- `server/factory/recovery-strategies/registry.js`
- `server/factory/recovery-strategies/rewrite-description.js`
- `server/factory/recovery-strategies/decompose.js`
- `server/factory/recovery-strategies/escalate-architect.js`
- `server/handlers/recovery-inbox-handlers.js`
- `.claude/commands/torque-recovery-inbox.md`

**Modified:**
- `server/db/factory-intake.js` — add `needs_review` and `superseded` to `VALID_STATUSES`; add `recovery_split` to `VALID_SOURCES`; new columns `recovery_attempts`, `last_recovery_at`, `recovery_history_json`, `depth`.
- `server/factory/factory-tick.js` — wire `runReplanRecoverySweep` after `runRejectedRecoverySweep`; add `needs_review` and `superseded` to `CLOSED_FACTORY_WORK_ITEM_STATUSES`.
- `server/factory/rejected-recovery.js` — startup-time assertion that `AUTO_REJECT_REASON_PATTERNS` does not overlap any registered replan-strategy pattern.
- `server/db/config-keys.js` — `REPLAN_RECOVERY_CONFIG_DEFAULTS` block.
- `server/db/config-core.js` — `getReplanRecoveryConfig()` helper.
- `server/event-bus.js` — `factory:replan_recovery_attempted`, `factory:replan_recovery_exhausted` events.
- `server/core-tools.js` — register `list_recovery_inbox`, `inspect_recovery_item`, `revive_recovery_item`, `dismiss_recovery_item`.
- `server/factory/architect-runner.js` — add `rewriteWorkItem({workItem, history})` and `decomposeWorkItem({workItem, history, priorPlans})` helpers (single-turn, JSON-output prompts; not full plan cycles).

## Data Model

### New statuses
- `needs_review` — terminal for the sweep, recoverable only via inbox actions. Added to `VALID_STATUSES` and `CLOSED_FACTORY_WORK_ITEM_STATUSES`.
- `superseded` — parent item after a successful split. Added to `VALID_STATUSES` and `CLOSED_FACTORY_WORK_ITEM_STATUSES`.

### New source value
- `recovery_split` — added to `VALID_SOURCES`. Children created by the decompose strategy carry this source.

### New columns on `factory_work_items`
| Column | Type | Default | Purpose |
|---|---|---|---|
| `recovery_attempts` | INTEGER | 0 | Number of replan-recovery attempts on this item |
| `last_recovery_at` | TEXT (ISO) | NULL | When the most recent attempt fired; powers cooldown ladder |
| `recovery_history_json` | TEXT | NULL | Append-only JSON array, capped at last 10 entries |
| `depth` | INTEGER | 0 | Cascade-split depth; +1 per split. Decompose refuses at `depth >= 2`. |

`recovery_history_json` entry shape:
```json
{
  "attempt": 2,
  "strategy": "decompose",
  "prior_reject_reason": "plan_quality_gate_rejected_after_2_attempts",
  "prior_description": "...",
  "outcome": "split",
  "timestamp": "2026-05-15T..."
}
```

The decision log retains the full audit trail; `recovery_history_json` exists only to thread context into the architect's prompt on subsequent attempts.

### Migration
Forward-only. New columns are nullable / default-zero, so existing rows are valid. Reads of new columns are guarded against missing schema (see `feedback_defensive_new_schema_reads.md`) so older fixture DBs don't break tests.

## Strategy Contract

Each strategy module:

```js
module.exports = {
  name: 'rewrite-description',
  reasonPatterns: [/^cannot_generate_plan:/i, /^Rejected by user$/i, ...],
  async replan({ workItem, history, deps }) {
    return { outcome: 'rewrote', updates: { title?, description?, constraints? } };
    // or { outcome: 'split', children: [{ title, description, constraints }] }
    // or { outcome: 'escalated', updates: { ..., constraints: { architect_provider_override, execution_provider_override } } }
    // or { outcome: 'unrecoverable', reason: '...' }
  },
};
```

`deps` injected by the dispatcher: `db`, `logger`, `factoryIntake`, `decisionLog`, `architectRunner`, `now`. Strategies are pure with respect to these deps; tests inject mocks.

`history` shape passed to strategies:
```js
{
  attempts: 2,
  priorReason: '...',
  priorDescription: '...',
  priorPlans: [{ attempt, planMarkdown, lintErrors }, ...],   // read from disk artifacts
  recoveryRecords: [{ attempt, strategy, outcome, timestamp }, ...],
}
```

### Dispatcher post-processing

| Strategy outcome | Dispatcher action |
|---|---|
| `rewrote` | Apply `updates`; status → `pending`; clear `reject_reason`; increment `recovery_attempts`; append to `recovery_history_json`. |
| `split` | Insert N children with `linked_item_id = parent.id`, `source = 'recovery_split'`, `priority = parent.priority - 1`, `depth = parent.depth + 1`; mark parent `superseded` with `reject_reason = 'split_into_recovery_children'`. |
| `escalated` | Same as `rewrote`, with `constraints_json` carrying `architect_provider_override` and/or `execution_provider_override`. The constraint is one-shot — consumed and cleared by the loop after the next attempt. |
| `unrecoverable` | Status → `needs_review`; record `reason` in history. Skips remaining attempts. |

### Failure modes
Strategy throws or times out → dispatcher logs `replan_recovery_strategy_failed`, increments `recovery_attempts`, item stays in current rejected/unactionable state until next cooldown elapses.

## Strategy Implementations

### `rewrite-description.js`
**Owns:** `cannot_generate_plan:*`, `pre_written_plan_rejected_by_quality_gate`, `Rejected by user`

Calls `architectRunner.rewriteWorkItem({workItem, history})`. Single-turn, JSON-output prompt: "rewrite the title and description so the architect can produce a plannable, testable, atomic unit." Validates: non-empty title, description ≥ 100 chars, ≥ 1 acceptance criterion. Invalid response → `unrecoverable` with reason `rewrite_response_invalid` (don't burn attempts on a model that can't produce structured output). Acceptance criteria appended to description so the existing `PLAN_DESCRIPTION_SUCCESS_RE` lint detects them.

### `decompose.js`
**Owns:** `plan_quality_gate_rejected_after_2_attempts`, `replan_generation_failed`

Calls `architectRunner.decomposeWorkItem({workItem, history, priorPlans})`. Single-turn, JSON-output prompt: "split into 2-4 atomic child items, each independently plannable, with acceptance criteria, referencing parent context."

Validates:
- 2 ≤ children ≤ `replan_recovery_split_max_children` (default 5).
- Each child description ≥ 100 chars.
- Titles unique within the split.
- No cyclic `depends_on_index`.
- No child ≥ 90% similar (Jaccard on tokens) to the parent — guards against the architect "splitting" by rewording.
- Parent `depth < replan_recovery_split_max_depth` (default 2). Refuses cascade fan-out beyond that.

Validation failures → `unrecoverable`.

### `escalate-architect.js`
**Owns:** `zero_diff_across_retries`, `retry_off_scope`

No architect re-prompt. Reads project's current `provider_chain`, picks the next tier above whatever was used (e.g., ollama → codex-spark → codex → claude-cli). If already at top, returns `unrecoverable`. Returns `{outcome: 'escalated', updates: {constraints: {architect_provider_override, execution_provider_override}}}`. Constraint is one-shot.

## Sweep & Dispatcher Logic

### Eligibility (per tick)
```sql
status IN ('rejected', 'unactionable')
  AND project.status = 'running'
  AND project.trust_level = 'dark'
  AND reject_reason matches one registered strategy pattern
  AND reject_reason does NOT match rejected-recovery's auto-patterns   -- mutex
  AND recovery_attempts < replan_recovery_hard_cap
  AND (last_recovery_at IS NULL OR last_recovery_at + cooldown(recovery_attempts) <= now)
```

Sweep paginates with cursor (same pattern as `listRecoverySweepPage`). Selection ordering when more items are eligible than caps allow: oldest `last_recovery_at` first (`updated_at` if never recovered).

### Cooldown ladder
| Prior attempts | Wait |
|---|---|
| 0 | 1 hour |
| 1 | 1 day |
| 2 | 3 days |
| 3+ | item is at hard-cap → routed to `needs_review` |

### Hard cap
`replan_recovery_hard_cap` (default 3). When `recovery_attempts >= 3` and the most recent attempt failed, item transitions to `needs_review`. The `superseded` outcome on the parent doesn't count against the cap (parent is gone); children start at `recovery_attempts = 0`.

### Throttling
| Knob | Default | Purpose |
|---|---|---|
| `replan_recovery_max_per_project_per_sweep` | 1 | Per-project throttle |
| `replan_recovery_max_global_per_sweep` | 5 | Global rate limit (~480/day) |
| `replan_recovery_skip_if_open_count_gte` | 3 | Project backpressure |

### Dispatcher transaction shape (per item)
1. Read item + history (work-item row + `recovery_history_json` + decision-log lookup + plan-artifact files).
2. Look up strategy from registry by `reject_reason`. Missing → log `replan_recovery_no_strategy`, skip.
3. Set `claimed_by_instance_id = '<uuid>:replan'`, `last_recovery_at = now` *before* invoking strategy. Prevents double-dispatch across concurrent ticks.
4. Invoke strategy with timeout (`replan_recovery_strategy_timeout_ms` default 90s; `replan_recovery_strategy_timeout_ms_escalate` default 5s).
5. Apply outcome in single transaction (work-item update + history append + child inserts as needed).
6. Write `factory_decisions` entry.
7. On strategy failure: increment counter, no work-item update, item waits for next cooldown.

### Mutex with `rejected-recovery.js`
- Reason patterns must be disjoint. Asserted at startup; throws if any overlap.
- `factory-tick.js` runs `runRejectedRecoverySweep` first, then `runReplanRecoverySweep`. If infra-recovery already reopened the item (status → pending), replan-recovery won't see it.

### Restart resilience
`claimed_by_instance_id` includes the server instance UUID. On startup, `cleanupStaleReplanClaims()` clears claims from prior instances. Cooldown's already advanced (`last_recovery_at` was written), so released items won't immediately re-fire.

## Inbox Surface

### Queryable layer (free)
`needs_review` is queryable via existing paths immediately:
- `list_work_items { project_id, status: 'needs_review' }`
- `GET /api/v2/factory/intake?status=needs_review`
- Existing dashboard intake views.

### MCP tools (`server/handlers/recovery-inbox-handlers.js`)

| Tool | Purpose |
|---|---|
| `list_recovery_inbox` | Lists `needs_review` items (all projects or one). Returns id, title, original reject reason, attempt count, last attempt, last failure outcome, and a 1-line "why we gave up" derived from history. |
| `inspect_recovery_item` | Full detail: complete recovery history (all attempts + strategies + outcomes), original description, current description (post-rewrites), all prior plan markdowns. |
| `revive_recovery_item` | `{id, mode: 'retry' \| 'edit' \| 'split', updates?}`. `retry` = reset attempts to 0, status → pending. `edit` = apply updates + reset + pending. `split` = create user-supplied children, parent → superseded. |
| `dismiss_recovery_item` | `{id, reason}`. Status → `unactionable`, `reject_reason = 'dismissed_from_inbox: <reason>'`. The `dismissed_from_inbox:*` pattern is added to `NON_RECOVERABLE_REJECT_REASON_PATTERNS` so dismissed items never re-enter recovery. |

`revive` and `dismiss` write decision-log entries (`recovery_inbox_revived`, `recovery_inbox_dismissed`).

### Slash command (`.claude/commands/torque-recovery-inbox.md`)
Workflow guide for Claude. Optional project arg; no arg → all projects. Calls `list_recovery_inbox`, formats as a table sorted by attempt count descending. For each item, calls `inspect_recovery_item` to load history, proposes one of: retry as-is / edit and retry / decompose / dismiss with reason. User confirms each action; Claude calls the matching tool.

### Eventing (optional consumer)
Dispatcher emits `factory:replan_recovery_exhausted` when an item enters `needs_review`. No required subscriber in this feature; existing notification daemon and future plugins can consume.

### Dashboard panel
**Out of scope** for v1. Status filter (above) gives a future panel its data for free.

## Configuration

All keys default to `REPLAN_RECOVERY_CONFIG_DEFAULTS` in `server/db/config-keys.js`; read via `getReplanRecoveryConfig()` in `config-core.js`.

| Key | Default | Notes |
|---|---|---|
| `replan_recovery_enabled` | `false` | Off by default. Per-environment opt-in. |
| `replan_recovery_sweep_interval_ms` | `900000` (15m) | Same as `rejected-recovery`. |
| `replan_recovery_hard_cap` | `3` | Per-item attempt ceiling. |
| `replan_recovery_max_per_project_per_sweep` | `1` | Per-project throttle. |
| `replan_recovery_max_global_per_sweep` | `5` | Global throttle. |
| `replan_recovery_skip_if_open_count_gte` | `3` | Project backpressure. |
| `replan_recovery_cooldown_ms_attempt_0` | `3600000` (1h) | Post-rejection grace. |
| `replan_recovery_cooldown_ms_attempt_1` | `86400000` (1d) | |
| `replan_recovery_cooldown_ms_attempt_2` | `259200000` (3d) | |
| `replan_recovery_strategy_timeout_ms` | `90000` (90s) | Architect-calling strategies. |
| `replan_recovery_strategy_timeout_ms_escalate` | `5000` (5s) | Escalate strategy. |
| `replan_recovery_history_max_entries` | `10` | Cap on `recovery_history_json` array. |
| `replan_recovery_split_max_children` | `5` | Decompose guard. |
| `replan_recovery_split_max_depth` | `2` | Cascade fan-out cap. |

## Observability

### Decision-log actions

| Action | When | Inputs / outcome |
|---|---|---|
| `replan_recovery_attempted` | Each dispatch (success or fail) | strategy, prior_reason, prior_description, outcome, attempt_number |
| `replan_recovery_no_strategy` | Eligibility passed but registry returned nothing | reject_reason |
| `replan_recovery_strategy_failed` | Strategy threw or timed out | strategy, error_message, attempt_number |
| `replan_recovery_split` | Decompose succeeded | parent_id, children_ids, depth |
| `replan_recovery_exhausted` | Item moved to `needs_review` | total_attempts, last_strategy, last_error |
| `recovery_inbox_revived` | User revived an inbox item | mode, updates_summary |
| `recovery_inbox_dismissed` | User dismissed an inbox item | reason |

### Event-bus events (added to `event-bus.js`)
- `factory:replan_recovery_attempted`
- `factory:replan_recovery_exhausted`

### Logger events
`replan_recovery_sweep_started`, `replan_recovery_sweep_completed` with structured counts: eligible / attempted / succeeded / failed / inbox-routed.

## Testing

### Unit tests (`server/tests/`)

| File | Covers |
|---|---|
| `replan-recovery.test.js` | Dispatcher: eligibility, cooldown ladder, hard-cap, throttling, mutex with rejected-recovery, restart resilience, claim release |
| `recovery-strategies-registry.test.js` | Registration, overlap detection (must throw on conflict), pattern matching |
| `recovery-strategy-rewrite-description.test.js` | Valid rewrite, invalid JSON → unrecoverable, history threading into prompt |
| `recovery-strategy-decompose.test.js` | Valid split, 90%-similar children rejected, depth-cap enforcement, cycle in `depends_on_index` rejected |
| `recovery-strategy-escalate.test.js` | Provider escalation ladder, top-of-ladder → unrecoverable, constraint shape |
| `recovery-inbox-handlers.test.js` | All four MCP tools: list, inspect, revive (retry/edit/split modes), dismiss |

### Integration test
`replan-recovery-e2e.test.js` — seed a rejected work item with `plan_quality_gate_rejected_after_2_attempts`, mock the architect with a canned decompose response, run `runReplanRecoverySweep`, assert: parent is `superseded`, two children exist with `linked_item_id = parent.id`, decision-log has `replan_recovery_split`, `recovery_history_json` populated.

### Mocking
`architectRunner.rewriteWorkItem` and `decomposeWorkItem` are injected via `deps`, so tests do not hit real LLMs. Helper `tests/helpers/mock-architect.js` returns canned responses keyed by input shape.

### Pattern-overlap regression guard
Top-level test that boots the registry alongside `rejected-recovery.js`'s patterns and asserts disjointness. Catches future drift at CI time, not at runtime.

## Rollout

Single merge, three operational stages:

1. **Land disabled.** `replan_recovery_enabled = false`. Code ships, columns + statuses migrate, registry boots, inbox tools register. Sweep is a no-op. Cutover via `scripts/worktree-cutover.sh recover-rejected-replan` triggers a restart barrier.
2. **Pilot.** Set `replan_recovery_enabled = true` and `replan_recovery_max_global_per_sweep = 1`. Watch for one or two ticks (15-30 min). Inspect decisions via existing dashboard governance/decisions panel.
3. **Open the gate.** Restore `replan_recovery_max_global_per_sweep = 5`. Let it run.

### Rollback
Set `replan_recovery_enabled = false` and restart. New columns sit unused; `needs_review` items stay where they are. No data migration needed.

### Pre-existing items (the "lost ideas" already in the DB)
When the feature lands and is enabled, every existing rejected/unactionable item with an in-scope reason becomes eligible (subject to throttling). Mitigations against thundering herd:
- Cooldown treats `last_recovery_at IS NULL` as "first attempt → 1h grace from `updated_at`."
- Global per-sweep cap of 5 paces the herd: ~480 attempts/day max.
- Pilot stage catches systemic mistakes before the herd reaches the architect.

No backfill job needed — eligibility-by-query naturally enrolls existing items.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Architect costs balloon when feature opens | `replan_recovery_max_global_per_sweep` is the throttle. Pilot at 1, then 5. |
| Decompose strategy fans out infinitely | `replan_recovery_split_max_depth = 2`; 90%-similarity child guard. |
| Restart mid-dispatch leaves orphaned claims | `cleanupStaleReplanClaims()` on startup; cooldown advances at claim time. |
| Pattern overlap with `rejected-recovery.js` causes double-dispatch | Startup-time disjointness assertion + dedicated regression test. |
| Manual user reject gets revived against operator intent | Hard cap of 3 + inbox handoff lets operator dismiss permanently; `dismissed_from_inbox:*` is non-recoverable. |
| `recovery_history_json` grows unboundedly | Capped at last 10 entries; full audit lives in decision log. |
| Strategy bugs corrupt work items | All updates flow through dispatcher in a single transaction; strategy failures don't write work-item changes. |

## Open Questions

None at spec time. Implementation phase will surface configuration values that need tuning after pilot stage; that's expected.

## Out of Scope (deferred)

- Dashboard panel for the inbox.
- Persisting plan markdown into the DB.
- Cross-project recovery prioritization beyond per-project + global throttles.
- Recovering `meta_task_no_code_output` items.
- Automated re-recovery of items dismissed from the inbox.
