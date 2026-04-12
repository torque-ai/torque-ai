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

## Tasks
1. Test-first: add `server/tests/factory-plan-executor-dry-run.test.js` covering a dry-run EXECUTE path that returns a successful stage result without submitting mutating tasks or creating commits.
2. Add the smallest dry-run / no-commit execution mode needed in `server/factory/plan-executor.js` and wire it through `server/factory/loop-controller.js`, then rerun `npx vitest run tests/factory-plan-executor-dry-run.test.js` and `npm run lint:di`.
