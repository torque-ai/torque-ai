# Factory Gap Plan: Record LEARN in the Factory Decision Log

**Date:** 2026-04-12
**Gap:** `factory_decisions_stage_enum_missing_learn`
**Source:** `docs/findings/2026-04-12-factory-bringup-plan-1.md`

## Goal
Allow the decision log API to accept `learn` so end-to-end bring-up runs can capture the full factory state machine.

## Scope
- `server/db/factory-decisions.js`
- `server/tests/factory-decisions-learn-stage.test.js`

## Tasks
1. Test-first: add `server/tests/factory-decisions-learn-stage.test.js` proving `recordDecision` and `listDecisionStats` accept and count a `learn` stage entry.
2. Update `server/db/factory-decisions.js` to include `learn` in the validated stage set, then rerun `npx vitest run tests/factory-decisions-learn-stage.test.js` and `npm run lint:di`.
