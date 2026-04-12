# Factory Bring-Up: Plan 1 (Workflow-as-Code)

**Date:** 2026-04-12
**Project:** torque-public
**Trust level:** supervised
**Work item:** WI_104
**Outcome:** partial

Expected flow: `SENSE -> PRIORITIZE -> PLAN -> EXECUTE -> VERIFY -> LEARN -> IDLE`. Observed flow from `server/tests/fixtures/factory-plan1-decision-log.json`: `SENSE -> PRIORITIZE -> EXECUTE`, with `PLAN` recorded as a skip event and the capture intentionally stopping before a live EXECUTE run. Manual intervention was required once at the supervised PRIORITIZE gate.

## Timeline
| Time | State | Duration | Notes |
|------|-------|----------|-------|
| 2026-04-12T22:47:52.058Z | SENSE | 64ms | Scanned 221 plan files, created 0 new work items, and matched WI_104. |
| 2026-04-12T22:47:52.122Z | PRIORITIZE | 3ms | Human approval advanced the loop to PRIORITIZE, but WI_104 stayed at priority 50 instead of being rescored. |
| 2026-04-12T22:47:52.125Z | PLAN (skipped) | 1ms | `plan_stage_skipped` fired because `origin.plan_path` existed, but the branch pointed EXECUTE at WI_209 instead of WI_104. |
| 2026-04-12T22:47:52.126Z | EXECUTE | stopped before completion | Capture stopped intentionally because there is no safe dry-run path for Plan 1; WI_209 entered `executing` while WI_104 remained `pending`. |

## Gaps Found
1. **Stale MCP tool directory assumption** — Task 2 expected `server/mcp-tools`, but the live factory registry is in `server/tool-defs/factory-defs.js` and `server/handlers/factory-handlers.js`. **Fix:** update `docs/superpowers/plans/2026-04-12-software-factory-phase11-end-to-end-bringup.md:10`.
2. **Decision-log table name mismatch** — The plan still references `factory_decision_log`, while this repo records bring-up evidence in `factory_decisions`. **Fix:** update `docs/superpowers/plans/2026-04-12-software-factory-phase11-end-to-end-bringup.md:10`.
3. **Approval tool name mismatch** — The bring-up instructions expect `approve_factory_transition`, but the implemented tool is `approve_factory_gate`. **Fix:** update `docs/superpowers/plans/2026-04-12-software-factory-phase11-end-to-end-bringup.md:95`.
4. **Advance tool name mismatch** — The bring-up instructions expect `tick_factory_loop`, but the implemented tool is `advance_factory_loop`. **Fix:** update `docs/superpowers/plans/2026-04-12-software-factory-phase11-end-to-end-bringup.md:95`.
5. **PRIORITIZE does not rescore the selected work item** — `server/factory/loop-controller.js` never updates work-item priority during the PRIORITIZE gate, so WI_104 stayed at 50 throughout the capture. **Fix:** new task `docs/superpowers/plans/2026-04-12-factory-gap-prioritize-score-work-item.md`.
6. **Loop selects the wrong work item at EXECUTE** — `getLoopWorkItem` re-queries open work items during the plan skip branch and the run entered EXECUTE with WI_209 instead of WI_104. **Fix:** new task `docs/superpowers/plans/2026-04-12-factory-gap-work-item-selection.md`.
7. **Decision log cannot record LEARN** — `server/db/factory-decisions.js:5` omits `learn` from `VALID_STAGES`, so an exact end-to-end replay cannot capture the final gate. **Fix:** new task `docs/superpowers/plans/2026-04-12-factory-gap-learn-stage-decision-log.md`.
8. **No safe live EXECUTE path for bring-up** — The fixture stopped before live execution because the current executor lacks a dry-run or no-commit mode for a broad repo-changing plan. **Fix:** new task `docs/superpowers/plans/2026-04-12-factory-gap-plan-executor-dry-run.md`.
9. **EXECUTE success still pauses before VERIFY under supervised trust** — While writing the regression test, `getNextState('EXECUTE', 'supervised', null)` returned `PAUSED` because `server/factory/loop-states.js:23` gates `VERIFY` itself instead of the `VERIFY -> LEARN` exit. **Fix:** new task `docs/superpowers/plans/2026-04-12-factory-gap-execute-verify-gate.md`.

## Next Plan to Try
`2026-04-11-fabro-7-per-task-verify.md` is the best next live plan after these gaps land: it stays backend-only, directly exercises the VERIFY handoff that is currently under-specified, and has a much smaller mutation surface than Fabro 1 while the executor still lacks a safe dry-run mode.

## Follow-up Plans
- `docs/superpowers/plans/2026-04-12-factory-gap-prioritize-score-work-item.md`
- `docs/superpowers/plans/2026-04-12-factory-gap-work-item-selection.md`
- `docs/superpowers/plans/2026-04-12-factory-gap-learn-stage-decision-log.md`
- `docs/superpowers/plans/2026-04-12-factory-gap-plan-executor-dry-run.md`
- `docs/superpowers/plans/2026-04-12-factory-gap-execute-verify-gate.md`
