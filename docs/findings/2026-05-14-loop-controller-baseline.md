# `server/factory/loop-controller.js` — Refactor Baseline (2026-05-14)

Snapshot taken at the start of the loop-controller refactor arc. All measurements are against `cfc2b6b6` on `main` (the tip when Phase 0 opened).

This document anchors Phases 1-4 of the refactor. After each phase ships, compare against this baseline to confirm size is shrinking and behavior is preserved.

## Current size

| Metric | Value |
|---|---|
| Total lines | **16,748** |
| Top-level function declarations | **406** |
| Average lines per function | ~41 |
| Public exports (`module.exports`) | 70+ named entries |
| Direct importers | 11 files (6 tests + 5 production) |
| Stage-executor lines | 4,289 / 25.6% of file |

## Stage executors (the heavy hitters)

| Function | Lines | % of file | Target file |
|---|--:|--:|---|
| `executeSenseStage` | 61 | 0.4% | `stages/sense.js` |
| `executePrioritizeStage` | 167 | 1.0% | `stages/prioritize.js` |
| `executePlanStage` | 243 | 1.5% | `stages/plan.js` |
| `executeNonPlanFileStage` | 1,082 | 6.5% | `stages/execute-non-plan-file.js` |
| `executePlanFileStage` | 1,422 | 8.5% | `stages/execute-plan-file.js` |
| `executeVerifyStage` | 1,257 | 7.5% | `stages/verify.js` |
| `executeLearnStage` | 57 | 0.3% | `stages/learn.js` |

## Direct importers (modules to update if the public surface ever moves)

Production:
- `server/handlers/factory-handlers.js`
- `server/factory/startup-reconciler.js`
- `server/factory/factory-tick.js`
- `server/container.js`
- `scripts/factory-direct-timing.js`

Tests (importers via `require('./loop-controller')` or relative paths):
- `server/tests/factory-execute-non-plan-file.test.js`
- `server/tests/factory-dep-resolver-integration.test.js`
- `server/tests/factory-auto-pilot-regressions.test.js`
- `server/tests/factory-architect-prompt-guide.test.js`
- `server/tests/decompose-on-park.test.js`
- `server/tests/attempt-history-prompt.test.js`

## Safety net (existing test coverage)

**25 test files** reference stage executors or the public lifecycle API. The full server suite is the regression net; the following are the highest-leverage files to watch after each phase cutover:

End-to-end smoke (lifecycle gates):
- `server/tests/factory-bringup-plan-1.test.js` — SENSE→PRIORITIZE, PLAN→EXECUTE, VERIFY/LEARN gates, rejection→IDLE (5 transitions, 71 lines, fastest signal)

Stage-execution dedicated coverage:
- `server/tests/factory-execute-non-plan-file.test.js`
- `server/tests/factory-loop-controller.test.js` (3,412 lines — biggest)
- `server/tests/factory-loop-shipping.test.js`
- `server/tests/factory-loop-prioritize-starved.test.js`
- `server/tests/factory-pending-approval.test.js`
- `server/tests/factory-verify-review-integration.test.js`
- `server/tests/factory-dep-resolver-integration.test.js`
- `server/tests/factory-hardening-e2e.test.js`
- `server/tests/loop-controller-plans-dir.test.js`

Plan-builder coverage (relevant to Phase 1a):
- `server/tests/plan-prompt-scope-files.test.js`
- `server/tests/plan-prompt-ollama-trim.test.js`
- `server/tests/plan-quality-gate.test.js`
- `server/tests/plan-executor.test.js`
- `server/tests/factory-scorers.test.js` and the `factory-scorers-*` family

## Discipline reminders for the arc

1. **Pure code movement only.** No logic edits, no "while we're here" tweaks. Each phase is a `git mv`-shaped commit.
2. **Re-export from `loop-controller.js`** so external callers keep working through the whole arc. Migration of import paths (if desired) happens in a separate later sweep, not within the same phase.
3. **Each phase ships in its own worktree** under the standard `scripts/worktree-cutover.sh` path. Restart barrier on every cutover; never bypass the drain.
4. **Tests must be green before opening the next phase's worktree.** Use `torque-remote npx vitest run server/tests` between phases, or the targeted stage-test files above for fast iteration.
5. **No interleaving with concurrent factory work.** If a `fix(factory): ...` lands on main mid-arc, rebase the open worktree onto it before continuing — don't reverse-merge.

## Phase checklist

- [x] **Phase 0 — baseline** (`feat/refactor-0-baseline`, this commit)
- [ ] **Phase 1a — plan-builders** (`feat/refactor-1a-plan-builders`)
- [ ] **Phase 1b — codex-fallback** (`feat/refactor-1b-codex-fallback`)
- [ ] **Phase 1c — recovery** (`feat/refactor-1c-recovery`)
- [ ] **Phase 1d — plan-generation** (`feat/refactor-1d-plan-generation`)
- [ ] **Phase 2a — verify-helpers** (`feat/refactor-2a-verify-helpers`)
- [ ] **Phase 2b — lifecycle (read-only)** (`feat/refactor-2b-lifecycle-readonly`)
- [ ] **Phase 2c — lifecycle (mutating)** (`feat/refactor-2c-lifecycle-mutating`)
- [ ] **Phase 3a — trivial stages** (`feat/refactor-3a-stages-trivial`)
- [ ] **Phase 3b — prioritize** (`feat/refactor-3b-stage-prioritize`)
- [ ] **Phase 3c — plan** (`feat/refactor-3c-stage-plan`)
- [ ] **Phase 3d — verify** (`feat/refactor-3d-stage-verify`)
- [ ] **Phase 3e — execute-plan-file** (`feat/refactor-3e-stage-execute-plan-file`)
- [ ] **Phase 3f — execute-non-plan-file** (`feat/refactor-3f-stage-execute-non-plan-file`)
- [ ] **Phase 3g — worktree-mgmt** (`feat/refactor-3g-worktree-mgmt`)
- [ ] **Phase 4 — doc cross-refs** (`feat/refactor-4-doc-paths`)

Target end state: `loop-controller.js` ~500 lines, pure orchestration, all bodies moved.
