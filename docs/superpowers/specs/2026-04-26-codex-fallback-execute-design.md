# Codex Fallback for EXECUTE — Design Spec

**Date:** 2026-04-26
**Status:** Draft (brainstorming approved, awaiting user spec review)
**Scope:** Allow the factory to keep producing code commits when Codex is unavailable (token cap, disabled, errored) by routing free-eligible EXECUTE work through the existing free-provider chain. Decompose-or-park complex work; auto-augment plans so they pass the quality gate; auto-detect Codex outages via circuit breaker with canary recovery; per-project participation policy.

## Problem

TORQUE's factory is built around Codex's EXECUTE envelope. When Codex is unavailable, three failure modes appear in production:

1. **Hard config block.** EXECUTE handlers route to Codex unconditionally; when `providers.enabled = 0` for codex, every EXECUTE attempt fails with `Provider codex is disabled. Enable it or choose a different provider.` Today's data shows SpudgetBooks hit this 4× in one hour without making any progress.
2. **Capability gap on free providers.** When EXECUTE *is* manually routed to a free provider, the result depends on the provider's ability to drive an agentic tool loop. `qwen3-coder:30b` on local Ollama produced `missing_tool_evidence` on DLPhone because the model didn't reliably use repository tools. Today's StateTrace work item 962 generated 5 plans on Ollama; the plan-quality gate rejected each one (`Task 4 has no test command, assertion, or verifiable outcome`); a 6th attempt finally got into EXECUTE and failed at task 1.
3. **No graceful escape.** Projects with mostly Codex-only work (architectural, large_code_gen, xaml_wpf, security, reasoning) have no path forward when Codex is down. Today they spin in `entered_starved` / `short_circuit_to_idle` loops, burning workstation cycles.

The factory needs a coherent fallback strategy for the EXECUTE stage that (a) auto-detects Codex unavailability, (b) routes work the free providers can actually do, (c) holds work the free providers cannot do until Codex is back, and (d) gives operators per-project escape hatches.

## Goals

1. **Auto-detect Codex unavailability.** Provider-table flag, error-pattern circuit breaker, and active canary probe.
2. **Route EXECUTE work to free providers** when Codex is unavailable, scoped to work the free providers can actually complete.
3. **Decompose complex work** into smaller free-eligible sub-items before parking — many small pieces ship a whole.
4. **Park truly Codex-only work** in a `parked_codex_unavailable` state; resume on Codex untrip.
5. **Improve free-provider plan quality** so plan-quality gate rejection rate drops.
6. **Per-project policy** — `auto`, `manual`, or `wait_for_codex` participation modes.
7. **Operator visibility.** Dashboard surface for breaker state, parked items, and chain-exhausted items.
8. **Reuse existing infrastructure.** Routing templates, provider scoring, workflow auto-decompose, auto-recovery decision logs, canary task pattern.

## Non-Goals

- Replacing Codex in steady state. When Codex is healthy, behavior is unchanged.
- Fixing local Ollama's agentic tool loop. We route around `qwen3-coder:30b`'s capability ceiling by only giving it work it can do (small targeted edits), not by improving its tool-use reliability.
- Greenfield routing infrastructure. The fallback uses the existing routing-template system (a new "Codex-Down Failover" template), not a parallel routing layer.
- Per-task-category classifiers beyond what already exists. The 9-category system stays; we add a complexity gate on top.
- Auto-resuming `parked_chain_exhausted` items on Codex untrip. Those are operator-decision items; the system surfaces them but doesn't retry automatically.

## Related Work

- **Routing Templates** (2026-03-17) — this spec adds a new "Codex-Down Failover" template. Existing precedence (`User override > per-task template > active template > defaults`) means a user-pinned template still wins.
- **Auto-Recovery Engine** (memory: `project_auto_recovery_session_handoff`) — circuit breaker decision-log entries follow the same shape as existing `auto_recovery_*` entries. Park/untrip events use the same event bus.
- **Workflow Auto-Decompose** (memory: `project_factory_workflow_decompose_and_retry_stage_shipped`) — decompose-on-park hooks into this existing infrastructure rather than building a parallel decomposer.
- **Provider Scoring** (memory: `project_provider_scoring_di_wiring`) — feeds chain ordering within a category. Initial chain ordering is hardcoded; provider scoring may dynamically reorder later.
- **Canary Tasks** — the pattern already exists (`Read-only canary check: ...` tasks visible in today's task list). This spec generalizes the pattern to an auto-scheduled canary while a breaker is tripped.
- **Free-Provider Tuning Session** (2026-04-26 morning, memory: `project_free_provider_tuning_session`) — Cerebras model fix, agentic prompt, model blocklist, and DB hardening are the *foundation* this spec builds on. Without those, the failover chain wouldn't have a working substrate.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Trigger model | Hybrid: auto-detect + manual override | Auto handles the common case; manual override matters when auto-detection is wrong. |
| Detection | Provider-table flag + 3-failure-in-15min circuit breaker + canary probe | Flag-only misses silent failures (rate limits, auth expiry); pure time-based recovery wastes capacity. |
| Free-eligibility rule | `task_category` whitelist + size cap (files ≤ 3, lines ≤ 200) | Reuses existing classifier; size cap catches plans that classify "simple" but actually aren't. |
| Failover chain | Category-aware (different chains per category) | Matches each provider to its strength; avoids burning Cerebras tier-1 throughput on documentation. |
| Hold queue | Park complex; retry-with-backoff free-eligible | Park is for "we knew this was complex"; retry is for "this provider was rate-limited just now." |
| Decomposition before park | Try decompose first; park only if decomposition fails or all sub-items still complex | Many pieces make a whole. |
| Plan-quality gate | Better prompts for free providers + auto-augment post-process | Smaller models can't follow scaffolds reliably alone; augmenter is the safety net. |
| Activation scope | Global breaker + per-project participation policy | Codex is one shared resource; project owners have different risk tolerances. |
| `wait_for_codex` semantics | Project freezes at PRIORITIZE; no PLAN, no decompose | Honors the spirit of "no free-provider activity"; pre-generated plans go stale anyway during long trips. |
| Phasing | 3 phases (foundation / routing / quality) | Each phase ships usable behavior. Foundation alone gives detection; routing alone gives free-provider commits at low success rate; quality phase gets the rate up. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Factory Loop (per-project: SENSE → PRIORITIZE → PLAN →     │
│                EXECUTE → VERIFY → LEARN)                    │
└────────────┬─────────────────────────┬──────────────────────┘
             │                         │
             ▼                         ▼
   ┌──────────────────┐      ┌──────────────────────┐
   │ Free-Eligibility │      │  Codex Circuit       │   (NEW)
   │   Classifier     │◄─────┤   Breaker            │
   │ (category + size)│      │ (global, canary-     │
   └─────┬────────────┘      │  probed)             │
         │                   └──────────────────────┘
         │                              │
         ▼                              ▼
   ┌──────────────────────────────────────────┐
   │  Failover Chain Selector                 │
   │  (category-aware: simple_gen→groq→...,   │
   │   tests→cerebras→..., etc.)              │
   └──────┬───────────────────────────────────┘
          │
          ▼
   ┌──────────────────────────────────────────┐
   │  Plan-Generator + Auto-Augmenter         │
   │  (scaffolded prompt + post-process to    │
   │   inject acceptance criteria)            │
   └──────┬───────────────────────────────────┘
          │
          ▼
   ┌──────────────────────────────────────────┐
   │  EXECUTE handler (smart_submit_task)     │
   │  + Decompose-on-Park for complex items   │
   └──────────────────────────────────────────┘
```

The change surface is five touch points across new and existing code; the breaker is the only fully new subsystem. Everything else extends infrastructure already present.

---

## Components

### Pre-existing infrastructure

A generic `CircuitBreaker` class already lives at `server/execution/circuit-breaker.js`, wired into `defaultContainer` as `circuitBreaker`. It implements CLOSED / OPEN / HALF_OPEN states, a 3-consecutive-failure threshold, exponential backoff for recovery (60s base → up to 600s cap), regex-based failure classification (`connectivity` / `rate_limit` / `auth` / `resource`), and emits `circuit:tripped` / `circuit:recovered` events. `provider-router.js` already calls `allowRequest(provider)` to skip tripped providers; `completion-pipeline.js` already calls `recordFailure(provider, errorOutput)` and `recordSuccess(provider)` on task close.

This spec's "Component A" is therefore an **extension** of the existing breaker, not a new module. Existing functionality is left intact; new behavior layers on top:

- **DB persistence** of breaker state (new `provider_circuit_breaker` table) so state survives restart and is dashboard-inspectable. Existing in-memory `Map` becomes a write-through cache.
- **Codex-specific failure-code path** that reads `tasks.error_code` and `tasks.exit_code` directly rather than re-running regex over `errorOutput`. The existing regex path stays as a fallback for providers that don't normalize their error codes.
- **Manual trip/untrip API** (`trip(provider, reason)`, `untrip(provider, reason)`). The existing class only has `recordFailure` / `recordSuccess`; manual operator control is new.
- **Persisted trip reason** so dashboard can distinguish `manual_disabled` / `auto_breaker_consecutive` / `auto_breaker_codex_specific` cases.

### New / extended components

**A. Codex-aware extensions to existing CircuitBreaker** — extends `server/execution/circuit-breaker.js`

Adds DB persistence, Codex-aware failure-code path, manual trip/untrip API, and persisted trip reason on top of the existing class. State stored in new `provider_circuit_breaker` table:

```
provider_id          TEXT PRIMARY KEY
state                TEXT NOT NULL  -- 'tripped' | 'untripped'
tripped_at           TIMESTAMP
untripped_at         TIMESTAMP
trip_reason          TEXT
last_canary_at       TIMESTAMP
last_canary_status   TEXT  -- 'success' | 'failure' | null
```

Trip rules:
- `providers.enabled = 0` → immediate trip with `trip_reason = 'manual_disabled'`.
- 3 failures in 15min window from Codex tasks where error code ∈ `{quota_exceeded, rate_limit, auth_failed}` or exit signal ∈ `{-101, -102, -103}` → trip with `trip_reason = 'auto_breaker'`.

Error code source: `quota_exceeded` / `rate_limit` / `auth_failed` are normalized by the existing close-handler error-classification path (provider response → normalized code). Exit signals -101 / -102 / -103 come from the subprocess sentinels shipped earlier (memory: `project_subprocess_sentinels_shipped`). The breaker reads these from `tasks.error_code` and `tasks.exit_code` rather than re-parsing raw stderr.

Counter is `count(distinct task_id from tasks where provider='codex' and error_code in (...) and created_at > now() - interval '15 minutes')`, computed on demand from the tasks table — no separate failure-event table.

Untrip: canary task succeeds (5-min cadence when tripped). Manual untrip via CLI sets `untripped_at` and resets counter.

Public API (in process):
- `recordFailure(taskId, errorCode)`
- `recordSuccess(taskId)`
- `isTripped(): bool`
- `trip(reason)`, `untrip(reason)`
- `getStatus(): {state, tripped_at, last_canary_at, ...}`
- `scheduleCanary()` — internal, run from cron or queue

Emits event-bus events: `provider:codex:tripped`, `provider:codex:untripped`.

**B. Free-Eligibility Classifier** — `server/routing/eligibility-classifier.js`

Single function: `classify(workItem, plan, projectConfig) → { eligibility, reason }`.

Returns `"codex_only"` for categories `architectural` / `large_code_gen` / `xaml_wpf` / `security` / `reasoning`.

Returns `"free"` for `simple_generation` / `targeted_file_edit` / `documentation` / `default` *only if* `estimated_files ≤ 3 AND estimated_lines ≤ 200`. Else `"codex_only"`.

`estimated_files` and `estimated_lines` come from the plan structure: count of distinct file paths referenced across `plan.tasks[*].files_touched`, and sum of `plan.tasks[*].estimated_lines` (an existing field the plan-generator emits). When either field is missing or zero on a `simple_generation`/`targeted_file_edit` plan, fall back to a structural estimate: count of `\bfile:` mentions and lines-of-code in any embedded code blocks. The classifier returns the *applied* estimate in `reason` so decision logs show how the call was made.

Project policy `wait_for_codex` → always `"codex_only"`, regardless of category.

`reason` carries the deciding factor: `"category_codex_only:architectural"`, `"size_cap_exceeded:files=5"`, `"project_policy:wait_for_codex"`, etc. Used by decision-log entries.

**C. Plan Auto-Augmenter** — `server/factory/plan-augmenter.js`

Single function: `augment(plan, projectConfig) → augmentedPlan`.

Iterates `plan.tasks`. For each task, checks for an acceptance criterion (verify command, assertion, or verifiable outcome — same shape the plan-quality gate looks for).

If missing: derives from project's `verify_command`. Uses Groq for the augmentation pass (fast, cheap, large enough to follow a scaffolded prompt). Generates one verify line per task in the form: ``Run `<verify_command>` and assert no new failures in tests touched by Task N.``

Validates output against plan schema before returning. On Groq failure or schema-validation failure, falls back to deterministic template that inserts the same line shape without LLM involvement.

### Extensions to existing infrastructure

**D. Failover routing template + chain walker** — DB seed adds template `"Codex-Down Failover"`; EXECUTE handler walks the chain at runtime

The "Failover Chain Selector" box in the architecture diagram is *not* a new module — it's the existing EXECUTE handler's `smart_submit_task` provider-resolution code, extended to walk a list of providers in order rather than picking one. The template provides the per-category list; the runtime walker tries each provider in sequence, falling through on per-attempt failure.

Category → chain mapping:

| Category | Chain |
|---|---|
| `simple_generation`, `targeted_file_edit` | `groq → cerebras → ollama-local` |
| `documentation`, `default` | `groq → cerebras → google-ai` |
| `tests` | `cerebras → google-ai → openrouter(kimi-k2)` |

Auto-activates when `codex_circuit_breaker.state = 'tripped'`. Existing template precedence (`User override > per-task template > active template > defaults`) means a user-pinned template still wins.

Categories `architectural`, `large_code_gen`, `xaml_wpf`, `security`, `reasoning` deliberately have no chain in this template — work in those categories is `codex_only` and never reaches the chain selector.

**E. Decompose-on-park** — extends `server/factory/workflow-decompose.js`

When PRIORITIZE pulls an item classified `codex_only` with breaker tripped:
1. Run existing decomposer.
2. Classify each sub-item via Free-Eligibility Classifier.
3. Replace original with sub-items in the work-item table; route eligible ones; mark remaining sub-items `parked_codex_unavailable`.
4. If decomposer returns 0 sub-items or crashes: park original; record decision-log entry `decompose_failed_will_park`.
5. If all sub-items still classify `codex_only`: park original (don't create the orphan sub-items).

**F. `codex_fallback_policy` project field** — `factory_projects.config_json`

JSON field, no DB migration. Values: `"auto"` (default) | `"manual"` | `"wait_for_codex"`. Read at PRIORITIZE and EXECUTE stages.

| Policy | While breaker tripped |
|---|---|
| `auto` | Free-eligible work runs on free providers; codex_only work decomposes; un-decomposable parks |
| `manual` | Behaves as if breaker were untripped (errors when EXECUTE hits Codex); operator must opt-in |
| `wait_for_codex` | Project freezes at PRIORITIZE; no plans, no decomposition, nothing runs until untrip |

**G. CLI/dashboard controls** — `server/handlers/configure-codex-breaker.js`

Commands:
- `/torque-config codex-breaker status` — print breaker state, last canary, count of parked items.
- `/torque-config codex-breaker trip --reason="..."` — manual trip.
- `/torque-config codex-breaker untrip` — manual untrip; triggers park-resume handler.
- `/torque-config codex-policy --project=<name> --mode={auto|manual|wait_for_codex}` — set per-project policy.

Dashboard mirror under Operations > Codex Breaker. Surfaces state, trip history, canary log, parked-items list with project/priority/age.

**H. Park state** — work_item status enum gains `parked_codex_unavailable` and `parked_chain_exhausted`

PRIORITIZE skips items in either parked state. On `provider:codex:untripped` event, park-resume handler runs:

```sql
UPDATE work_items
SET status = 'pending'
WHERE status = 'parked_codex_unavailable'
```

Idempotent under concurrent fires. `parked_chain_exhausted` items are *not* auto-resumed — they're operator-surfaced.

---

## Data Flow

### Steady state — breaker untripped (Codex healthy)

No change from today. Breaker is observed at a single decision point inside `smart_submit_task`; if untripped, the existing routing path runs untouched. Architect, sense, and plan-stage work continues to free providers as today; EXECUTE goes to Codex.

### Trip event

A failure arrives at the close-handler with code `quota_exceeded`, `rate_limit`, `auth_failed`, or exit signal -101/-102/-103. Circuit breaker's `recordFailure()` runs; if 3rd in 15min window OR `providers.enabled` flips to 0, breaker trips:
- Writes `trip_reason` and `tripped_at` to `provider_circuit_breaker`.
- Schedules canary task (5-min cadence).
- Emits `provider:codex:tripped` on the event bus.
- Dashboard surface updates.

### Tripped state — per-project flow at PRIORITIZE

Each project's PRIORITIZE stage reads breaker state once per cycle, then branches by `codex_fallback_policy`:

```
codex_fallback_policy = "auto" (default)
└─> Run Free-Eligibility Classifier on selected work item
    ├─> "free" eligibility
    │   └─> Advance to PLAN with executor_hint = "free"
    │       PLAN uses scaffolded prompt for free providers
    │       Auto-Augmenter pass adds missing verify commands
    │       Plan-quality gate (unchanged) passes more often now
    │       EXECUTE routes via Failover Chain Selector by category
    │       On task failure: retry next provider in chain (backoff)
    │       On chain exhaustion: re-queue item with backoff (not parked)
    │       On 3rd exhaustion: park with status = "parked_chain_exhausted"
    │
    └─> "codex_only" eligibility
        └─> Run decomposer
            ├─> Decomposition produces ≥1 free-eligible sub-items
            │   └─> Replace original with sub-items; route eligible ones
            └─> Decomposition fails or all sub-items still complex
                └─> Set status = "parked_codex_unavailable"
                    Skip in this cycle; PRIORITIZE picks next item

codex_fallback_policy = "wait_for_codex"
└─> SENSE continues (refreshes scout findings, free-provider work, no commits).
    PRIORITIZE continues (re-scores the backlog) but the selected work item
    is immediately marked "parked_codex_unavailable" before PLAN is invoked.
    No PLAN, no decompose, no EXECUTE.
    Parking the selected item is what prevents the loop from re-selecting it
    every cycle; the project effectively idles on PLAN/EXECUTE-side work
    until breaker untrips and the park-resume handler unsets the status.

codex_fallback_policy = "manual"
└─> Behave as if breaker were untripped.
    EXECUTE attempts Codex; gets the existing
    "Provider codex is disabled" error.
    Operator must call /torque-config codex-policy --mode=auto
    to enter fallback for this project.
```

### Untrip event

Canary task (read-only Codex call) returns success. Breaker untrips:
- Writes `untripped_at` to `provider_circuit_breaker`.
- Emits `provider:codex:untripped` on the event bus.
- Park-resume handler runs idempotent `UPDATE` on `parked_codex_unavailable` items → `pending`.
- Next PRIORITIZE cycle picks them up; routes through Codex normally.

Manual untrip via `/torque-config codex-breaker untrip` follows the same path.

### Failover chain runtime — example (StateTrace, simple_generation work item)

Breaker tripped. Item categorized `simple_generation`, files=2, lines=85 → `free`.

```
EXECUTE called with chain [groq, cerebras, ollama-local]
├─> Attempt 1: groq/llama-3.3-70b
│   └─> 429 rate limit
├─> Attempt 2: cerebras/qwen-3-235b-a22
│   └─> Success (51s) — task completes, commit shipped
```

Chain-exhaustion case:

```
EXECUTE called with chain [groq, cerebras, ollama-local]
├─> Attempt 1: groq/llama-3.3-70b
│   └─> Context overflow (plan was 32k tokens)
├─> Attempt 2: cerebras/qwen-3-235b-a22
│   └─> Provider error (cluster degraded)
├─> Attempt 3: ollama-local/qwen3-coder:30b
│   └─> missing_tool_evidence (model couldn't drive tool loop)
└─> Chain exhausted; re-queue with 10-min backoff
    On 3rd exhaustion: park with status = "parked_chain_exhausted"
    Surface to operator dashboard
```

---

## Error Handling

### Circuit breaker integrity

- **Concurrent failures during trip.** Failures arriving in parallel could race the trip-counter increment. Use a DB transaction with `SELECT ... FOR UPDATE` on the breaker row, or an in-process mutex if breaker state is read-through-cached. Increments are idempotent by `task_id` (`failure_count` is `count(distinct task_id) where created_at > now() - 15min`), not naive ++.
- **Canary self-loop.** Canary task itself fails repeatedly while breaker is tripped. Don't increment trip-counter from canary failures — they'd cause a perpetual-trip. Tag canary tasks with `is_canary: true`; close-handler skips breaker-failure recording for them. Schedule next canary on failure, untrip on success.
- **Trip/untrip race.** A real failure arrives the same second a canary succeeds. Apply tie-breaker by event timestamp on the breaker row (`tripped_at` vs `untripped_at`); most recent wins.

### Auto-augmenter resilience

- **Groq call fails or times out** during augmentation. Fall back to deterministic template: read project's `verify_command`, inject one line per task: ``Run `<verify_command>` and assert no new failures.`` Always passes the gate, less specific than LLM-generated criteria.
- **Augmenter produces invalid plan structure** (LLM hallucination). Validate output against plan schema before passing it on; on schema fail, fall back to deterministic template.
- **Plan-quality gate still rejects after augmentation.** Existing re-plan loop runs (today's behavior, capped by `auto_recovery_attempts`). After cap, mark item `parked_plan_quality_failure` and surface to operator dashboard. Don't loop forever — that's exactly today's StateTrace 962 bug.

### Decomposer failures

- **Decomposer returns 0 sub-items or crashes.** Park the original item as if decomposer wasn't called; log decision-log entry `decompose_failed_will_park`.
- **Decomposer produces sub-items, all still codex_only.** Park original; *don't* park the sub-items (they'd be orphan rows). Decomposition reverts: reattach a "decompose attempted" marker to the original item to avoid retrying decomposition every cycle.

### Park/resume integrity

- **Park-resume on untrip is idempotent.** `UPDATE work_items SET status = 'pending' WHERE status = 'parked_codex_unavailable'` — safe under concurrent fires.
- **Long-parked items.** A `parked_codex_unavailable` item that's been sitting for 24h+ should still resume cleanly. Park doesn't carry a TTL; resume re-evaluates priority at PRIORITIZE.

### Free-provider chain failures

- **All providers in chain fail on one task.** Re-queue with 10-min backoff; up to 3 exhaustion cycles; on 3rd, park with status `parked_chain_exhausted`. Surfaces to operator; *not* automatically resumed on Codex untrip — operator decides whether to retry on Codex or abandon.
- **Provider mid-chain returns "context overflow."** Skip to next provider in chain (don't count as a real failure for the chain-exhaustion counter); tag the plan as "may exceed context" so future runs route to large-context providers (google-ai) earlier.

### Operator-visible signals

Every breaker trip, untrip, canary attempt, project-policy change, and chain-exhaustion park writes a decision-log entry with `actor`, `stage`, `reasoning`, `outcome`. Same shape as existing `auto_recovery_*` entries. Dashboard surfaces under Operations > Codex Breaker.

### What doesn't get a special path

- **Free-provider commits that break the build.** Existing VERIFY stage and auto-recovery handle these. No new code; same recovery path as Codex-shipped breakage.
- **Plan-quality gate rejection on first attempt.** Existing re-plan loop. The new auto-augmenter just lowers the rejection rate; doesn't change recovery.

---

## Testing

### Per-component unit coverage

**Circuit breaker** (`server/routing/codex-circuit-breaker.test.js`)
- Trip on `providers.enabled = 0` (immediate).
- Trip on 3 failures within 15min window with allowed error codes; *don't* trip on 3 failures spanning 16+ minutes.
- Don't increment counter from canary tasks (verify `is_canary: true` is honored).
- Untrip on canary success; idempotent under concurrent canary completions.
- Trip/untrip race: most-recent-timestamp wins.
- Manual `trip(reason)` / `untrip(reason)` paths set the right fields and emit events.

**Free-eligibility classifier** (`server/routing/eligibility-classifier.test.js`)
- Each of 9 task categories returns the documented eligibility.
- Size cap fires: a `simple_generation` plan with `files: 5` returns `codex_only`.
- Size cap fires: a `simple_generation` plan with `lines: 250` returns `codex_only`.
- Project policy `wait_for_codex` overrides everything → always `codex_only`.

**Plan auto-augmenter** (`server/factory/plan-augmenter.test.js`)
- Plan with all tasks already having acceptance criteria: pass-through, no LLM call.
- Plan missing acceptance criteria: Groq call adds them, output passes schema validation.
- Groq call fails: deterministic template runs, output passes plan-quality gate.
- LLM returns malformed JSON: schema validation rejects, deterministic template runs.

**Decompose-on-park** (`server/factory/workflow-decompose.test.js` extension)
- Codex_only item + decomposer produces eligible sub-items: original removed, sub-items routed.
- Codex_only item + decomposer produces 0 sub-items: original parked, no orphans.
- Codex_only item + decomposer produces sub-items, all still codex_only: original parked, sub-items not created.
- Decomposer crashes: original parked, decision-log records `decompose_failed_will_park`.

**`codex_fallback_policy` field** (`server/handlers/configure-codex-policy.test.js`)
- `auto`: tripped breaker → free-eligible work routes; codex_only decomposes-or-parks.
- `manual`: tripped breaker → behaves as untripped (existing error path).
- `wait_for_codex`: tripped breaker → all selected items park; SENSE/PRIORITIZE run, PLAN/EXECUTE skipped.

### Integration tests (`server/tests/integration/codex-fallback.test.js`)

- **Full cycle.** Healthy state → simulate 3 Codex failures → breaker trips → submit free-eligible work → verify it completes via Cerebras → simulate canary success → breaker untrips → verify parked items resume.
- **Multi-project differing policies.** Three test projects with `auto`, `wait_for_codex`, `manual`; trip breaker; assert each behaves per its policy in the same tick.
- **Plan-quality-with-augmentation.** Plan that previously triggered the StateTrace 962 5x re-plan loop now passes after augmenter pass.
- **Chain exhaustion.** Stub all 3 providers in a chain to fail; assert item re-queues with backoff up to 3 exhaustions, then parks with `parked_chain_exhausted`.

### Fixtures

- New: `server/tests/fixtures/codex-fallback/` — sample plans (with/without acceptance criteria), sample provider failure responses for the four trip-eligible error codes, sample canary success/failure responses.

### Per-phase smoke gates

Each phase ships behind a smoke test that proves its visible behavior:

- **Phase 1 smoke.** Disable Codex via `/torque-config codex-breaker trip`; assert breaker state visible; assert `parked_codex_unavailable` items appear in DB; manually untrip; assert items resume.
- **Phase 2 smoke.** Trip breaker; submit a `simple_generation` task; assert it routes through Cerebras and ships a commit.
- **Phase 3 smoke.** Trip breaker; submit a previously-failing plan-quality item (StateTrace 962 fixture); assert auto-augmenter passes it through the gate; assert decompose-on-park converts a `large_code_gen` item into 3 simple sub-items that route successfully.

### Existing test infrastructure to reuse

- `vitest` + remote test execution via `torque-remote` (per memory).
- DB-fixture pattern already used in `server/tests/fixtures/`.
- `setDb` global state pattern for in-memory DB swap during tests.

### Out of scope for testing

- Real Codex auth/quota errors. Stubbed in tests; real verification happens in production via the actual breaker behavior.
- Real Groq/Cerebras provider behavior. Stubbed; integration with their APIs is already covered by existing provider tests.
- Performance regression. Existing perf gate (Phase 0 baseline) catches this if it shows up.

---

## Phasing

Three phases, each shippable independently. Each phase delivers usable behavior even if subsequent phases never ship.

### Phase 1 — Foundation (components A + F + G + H)

**Ships:** Codex circuit breaker; per-project `codex_fallback_policy` field; CLI/dashboard controls; `parked_codex_unavailable` work-item state; park-resume on untrip.

**Visible behavior:** When Codex is disabled or fails repeatedly, breaker trips. Projects with `wait_for_codex` policy freeze at PRIORITIZE. Projects with `auto` policy *would* fall back, but no routing is wired yet, so they also park work for now. Operator can manually trip/untrip via CLI.

**Why this is useful alone:** Replaces today's silent `Provider codex is disabled` error spam with explicit tripped state, parked items with clear status, and operator-visible signals. Stops the wasted-cycle problem even before the routing layer lands.

### Phase 2 — Routing (components B + D)

**Ships:** Free-eligibility classifier; "Codex-Down Failover" routing template with category-aware chains.

**Visible behavior:** When breaker is tripped, projects with `auto` policy route free-eligible EXECUTE work through the failover chain. Free providers actually pick up commits. Plan-quality gate failures still happen at the rate they do today; chain-exhaustion park happens; complex work parks (no decomposer yet).

**Why this is useful alone:** Free providers ship code. The success rate is bounded by plan-quality gate rejections (Phase 3 fixes this) and the lack of decomposition (Phase 3), but the factory keeps producing commits during Codex outages.

### Phase 3 — Quality (components C + E)

**Ships:** Plan auto-augmenter; decompose-on-park.

**Visible behavior:** Free-provider plans pass the quality gate at a much higher rate. Complex work decomposes into smaller pieces before parking; many small pieces ship a whole.

**Why this is useful alone:** Closes the gap between "free providers work" (Phase 2) and "free providers work *well*." Without it, Phase 2 has a high re-plan rate and a lot of parked complex work; with it, the factory's throughput on free providers approaches Codex's for the work both can do.

---

## Migration / Rollout

- **No data migration.** Phase 1 adds `provider_circuit_breaker` table (clean create) and `codex_fallback_policy` JSON field (default `"auto"`, no schema change).
- **Existing projects.** All five active factory projects (DLPhone, StateTrace, SpudgetBooks, bitsy, torque-public) get `codex_fallback_policy: "auto"` on first read. DLPhone's existing `provider_lane_policy` is independent (it's a hard restriction; this is a fallback policy). torque-public is currently paused (`baseline_broken`) — when it resumes, it picks up `auto` policy automatically; no special migration path.
- **Config defaults.** `codex_fallback_policy` defaults to `"auto"` for new projects too. Operators who want different behavior set it explicitly.
- **Interaction with existing `provider_lane_policy`.** When a project has both, the lane policy is the *outer* gate (which providers are eligible at all) and the fallback chain is selected *within* that gate. DLPhone's lane policy already lists `["openrouter", "google-ai", "cerebras", "groq", "ollama-cloud", "ollama"]`, so when the breaker trips, DLPhone's failover chain is the intersection of the template's chain and the lane policy's allowlist. If the intersection is empty for a given category, the item parks (decision-log entry: `chain_empty_under_lane_policy`).
- **Backwards compatibility.** Untripped breaker = today's behavior, byte-for-byte. No risk of regression in steady state.

## Out of Scope

- **Replacing Codex in steady state.** Healthy Codex still does EXECUTE.
- **Improving local Ollama agentic capability.** We route around its ceiling; we don't fix it.
- **Per-task-category classifiers beyond the existing 9.**
- **Auto-resuming `parked_chain_exhausted` items.** Operator decides.
- **A separate "Codex healthy but slow" detection.** Slow Codex is observable via existing stall-detection; doesn't trip this breaker.
- **Multi-provider circuit breakers.** This spec only covers Codex. The architecture generalizes (`provider_circuit_breaker` table is keyed on `provider_id`), but other providers don't get breakers in this spec.
