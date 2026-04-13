# Factory Gap Plan: PRIORITIZE Scores the Selected Work Item

**Date:** 2026-04-12
**Gap:** `prioritize_stage_did_not_score_work_item`
**Source:** `docs/findings/2026-04-12-factory-bringup-plan-1.md`

## Goal
Persist scorer output onto the exact work item the loop is about to advance so the PRIORITIZE gate changes queue order for real work.

## Scope
- `server/factory/loop-controller.js`
- `server/db/factory-intake.js`
- `server/tests/factory-prioritize-score-work-item.test.js`

## Task 1: Score the selected work item at PRIORITIZE

- [ ] **Step 1: Test-first — PRIORITIZE updates selected work-item priority** — add `server/tests/factory-prioritize-score-work-item.test.js` to prove a supervised loop run updates the selected work item's `priority` before the PRIORITIZE gate is approved.
- [ ] **Step 2: Minimal scoring + persistence path** — implement the minimal scoring + persistence path in `server/factory/loop-controller.js` and `server/db/factory-intake.js`, then rerun `npx vitest run tests/factory-prioritize-score-work-item.test.js` and `npm run lint:di`.
