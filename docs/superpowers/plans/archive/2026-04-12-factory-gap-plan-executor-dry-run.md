# Factory Gap Plan: Add a Safe Plan-Executor Dry-Run Path

**Date:** 2026-04-12
**Gap:** `execute_stage_not_attempted_live`
**Source:** `docs/findings/2026-04-12-factory-bringup-plan-1.md`

## Goal
Let supervised bring-up runs exercise EXECUTE without mutating the repo or creating commits, so large plan files can be smoke-tested safely.

## Scope
- `server/factory/plan-executor.js`
- `server/factory/loop-controller.js`
- `server/tests/factory-plan-executor-dry-run.test.js`

## Task 1: Safe plan-executor dry-run path

- [ ] **Step 1: Test-first — dry-run EXECUTE succeeds without mutation** — add `server/tests/factory-plan-executor-dry-run.test.js` covering a dry-run EXECUTE path that returns a successful stage result without submitting mutating tasks or creating commits.
- [ ] **Step 2: Add the dry-run mode and wire it through** — add the smallest dry-run / no-commit execution mode needed in `server/factory/plan-executor.js` and wire it through `server/factory/loop-controller.js`, then rerun `npx vitest run tests/factory-plan-executor-dry-run.test.js` and `npm run lint:di`.
