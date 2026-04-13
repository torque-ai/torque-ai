# Factory Gap Plan: Preserve the Selected Work Item into EXECUTE

**Date:** 2026-04-12
**Gap:** `wi1_not_selected_by_loop`
**Source:** `docs/findings/2026-04-12-factory-bringup-plan-1.md`

## Goal
Keep the exact work item chosen during PRIORITIZE bound to the subsequent PLAN skip and EXECUTE stages so the loop does not drift to another open item.

## Scope
- `server/factory/loop-controller.js`
- `server/db/factory-intake.js`
- `server/tests/factory-selected-work-item.test.js`

## Task 1: Preserve the selected work item through the loop

- [ ] **Step 1: Test-first — selected plan reaches EXECUTE unchanged** — add `server/tests/factory-selected-work-item.test.js` covering a pre-written plan item that reaches EXECUTE without being replaced by a different open work item.
- [ ] **Step 2: Thread selected work-item identity through loop-controller** — thread the selected work-item identity through `server/factory/loop-controller.js` with the smallest persistence change needed in `server/db/factory-intake.js`, then rerun `npx vitest run tests/factory-selected-work-item.test.js` and `npm run lint:di`.
