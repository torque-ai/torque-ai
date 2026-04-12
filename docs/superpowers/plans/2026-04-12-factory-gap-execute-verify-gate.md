# Factory Gap Plan: Enter VERIFY Immediately After EXECUTE Success

**Date:** 2026-04-12
**Gap:** `execute_success_pauses_before_verify`
**Source:** `docs/findings/2026-04-12-factory-bringup-plan-1.md`

## Goal
Make a successful EXECUTE transition enter `VERIFY` immediately under supervised trust, while keeping the approval gate on `VERIFY -> LEARN`.

## Scope
- `server/factory/loop-states.js`
- `server/factory/loop-controller.js`
- `server/tests/factory-bringup-plan-1.test.js`

## Tasks
1. Test-first: unskip the `EXECUTE -> VERIFY after successful plan run` case in `server/tests/factory-bringup-plan-1.test.js` and add any focused transition coverage needed to lock the intended behavior.
2. Adjust `server/factory/loop-states.js` and `server/factory/loop-controller.js` so supervised trust pauses when leaving `VERIFY`, not when entering it from EXECUTE, then rerun `npx vitest run tests/factory-bringup-plan-1.test.js` and `npm run lint:di`.
