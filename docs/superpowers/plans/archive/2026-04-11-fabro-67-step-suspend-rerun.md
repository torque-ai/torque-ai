# Fabro #67: Step-Native Suspend + Rerun — DROPPED

**Decision date:** 2026-05-01
**Theme:** Generic workflow-engine clones (see `docs/superpowers/plan-scope-decisions.md`, Theme 1)
**Version intent:** `internal`
**Recommendation:** Move this file to `docs/superpowers/plans/archive/` (or delete) — it is preserved here only as a historical pointer.

---

## TL;DR

The original plan proposed an in-step `suspend_task({ resume_token, timeout_ms })` MCP tool plus a `POST /api/tasks/resume/:token` webhook so an externally-driven payload could re-enter a paused task with `$.resume_payload` injected into its prompt context. It was explicitly layered on **fabro-30 (signals/queries)** and **fabro-43 (human tasks)**, both of which were dropped in the spirit-of-TORQUE audit as generic-workflow-engine bloat that does not serve the code-factory loop.

With its load-bearing siblings dropped, fabro-67 also drops. The remaining pause/resume use cases are already covered by existing TORQUE primitives at a more honest granularity than "pause a single MCP tool call mid-token."

## Why this drops cleanly (not a redesign)

The plan named four motivating use cases. Each one already has a first-class TORQUE primitive:

| Original use case | Existing TORQUE primitive |
|---|---|
| Wait for a human to approve before continuing | Factory **gate pause** at LEARN/EXECUTE/etc. + `approve_factory_gate` / `reject_factory_gate` (`server/factory/loop-controller.js`, `paused_at_stage`) |
| Wait for an external system / webhook callback | Factory **project pause** (`pause_project` / `resume_project`) and the auto-verify-retry loop, which already re-prompts a fresh task with new context |
| Wait for a downstream task to finish | Workflow **DAG dependencies** (`create_workflow` + `add_workflow_task`) — completion events wake dependents via the event bus |
| Cleanly stop a runaway in-flight task | `cancel_task` + the **restart-barrier** task primitive (`server/execution/restart-barrier.js`) |

None of these require a new `suspended_tasks` table, a new `suspend_task` MCP tool, or a public `POST /resume/:token` endpoint.

## Why the proposed shape is wrong for TORQUE specifically

1. **Provider invocations are atomic shell-outs.** TORQUE drives `codex`, `ollama`, `claude-cli`, and friends as subprocess calls. There is no in-process pause primitive that lets a model "yield" mid-completion and re-enter later with extra fields in its prompt — the plan's "solution" is to kill the process, persist context, then later re-prompt a fresh provider invocation with the payload appended. That is **a retry with augmented context**, which TORQUE already does as auto-verify-retry (`auto_verify_on_completion`, Phase 6.5 in the close-handler pipeline) and as factory replan-on-rejection.
2. **`POST /api/tasks/resume/:token` is the human-task / webhook-trigger surface.** That is exactly the "system task kinds (inline / jq / http / human)" shape rejected as fabro-43, and the same trigger-admission shape rejected as fabro-45. Re-introducing it under a different name reopens the door to the generic-workflow-engine product TORQUE is deliberately not building.
3. **`$.resume_payload` injection is a generic-engine flow-variable.** TORQUE prompts are built from task descriptions, plan context, codegraph snapshots, and verify-error feedback — not from a generic step-scoped variable bag. Adding `$.resume_payload` introduces a new authoring surface (and a new failure mode: small models parroting the variable name; see `feedback_no_prompt_placeholder_examples.md`) for a problem we already solve by re-prompting with concrete context.
4. **Timeout sweeper duplicates existing machinery.** `setInterval` + `sweepTimeouts` for suspended tasks duplicates what factory tick + auto-recovery + stall detection (`configure_stall_detection`) already do at the right level (per-provider, configurable, with auto-resubmit and provider fallback).

## What stays in scope

Nothing from this plan needs to be re-homed. Existing pause/resume coverage is sufficient:

- **In-flight task control:** `cancel_task`, restart-barrier, stall detection.
- **Human-in-the-loop approval:** factory gates + `approve_factory_gate` / `reject_factory_gate` + trust-level policy (`set_factory_trust_level`).
- **Project-level pause:** `pause_project`, `pause_all_projects`, `resume_project`, `factory_projects.status='paused'`.
- **Cross-task waiting:** workflow DAGs and the event bus.
- **Re-enter-with-context:** auto-verify-retry, factory replan with violation context (Phase P).

If a future need surfaces that genuinely cannot be expressed by these — for example, a long-running external poll where the model itself would benefit from "go to sleep, come back later" semantics — the right move is to revisit it as a **factory-loop stage** or a **plugin** (consistent with the observability/eval-platform precedent: those live in plugins, not core), not as a new core primitive.

## Cross-references

- `docs/superpowers/plan-scope-decisions.md` — Theme 1 (generic workflow-engine clones), Theme 2 (generic agent SDK / authoring abstractions).
- `CLAUDE.md` — "Restart — Barrier Task Primitive", "Factory Auto-Pilot", "Quality Safeguards" (auto-verify-retry).
- `server/factory/loop-controller.js` — `paused_at_stage`, gate handling, `approve_factory_gate`.
- `server/execution/restart-barrier.js` — barrier task primitive.

## Action

This file should be moved to `docs/superpowers/plans/archive/2026-04-11-fabro-67-step-suspend-rerun.md` (or deleted) so the active `plans/` directory only contains live work.
