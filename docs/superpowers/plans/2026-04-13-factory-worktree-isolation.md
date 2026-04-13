# Factory Worktree Isolation — Implementation Plan

**Date:** 2026-04-13
**Problem:** The factory's EXECUTE stage currently spawns Codex tasks with `working_directory` set to the LIVE TORQUE main worktree. Codex edits the code TORQUE is actively running from, commits land directly on main, and there is no verify-before-merge gate. An infra-touching refactor can break TORQUE mid-run and stop the operator from driving any further loops without manual recovery.

**Goal:** Isolate factory-generated changes in per-batch git worktrees, run verification on the remote station against that branch, and only merge to main when verification passes.

---

## Architecture

### Current flow (unsafe)

```
EXECUTE
  → plan-executor.submit({ working_directory: project.path /* main worktree */ })
  → Codex edits files under project.path
  → close-handler auto-commits to current HEAD (main)
  → next push hits pre-push hook on main
```

Problem: the live TORQUE process is reading from `project.path`. Concurrent factory edits + runtime reads race. Merge conflicts with in-session edits are routine. Broken commits take TORQUE down.

### Target flow (isolated)

```
EXECUTE start
  → worktreeManager.create({ base: project.path, branch: 'factory/<work-item-id>-<slug>' })
    → .worktrees/factory-<batch_id>/ on the new branch (based on current main)
  → plan-executor.submit({ working_directory: worktreePath }) for each task
  → each Codex task edits + commits inside the worktree
EXECUTE complete
  → after all tasks are 'completed':
  → torque-remote --branch factory/<...> <verify_command>
  → on verify pass:
      → vc_merge_worktree (ff or merge to main), delete branch + worktree
      → push main (pre-push hook gates as usual)
      → LEARN ships the work item
  → on verify fail:
      → record failure, pause loop with paused_at_stage = VERIFY_FAIL
      → human can approve remediation (resubmit failing tasks) or reject
VERIFY stage (renamed "MERGE_VERIFY")
  → pure go/no-go gate on the worktree verify result
```

## Scope

### In scope

1. New helper module `server/factory/worktree-runner.js`
2. Changes in `server/factory/loop-controller.js executeNonPlanFileStage` + `executePlanFileStage` to route working_directory through worktree
3. Changes in `server/factory/plan-executor.js` to accept + thread `working_directory` override
4. New decision-log actions: `worktree_created`, `worktree_verify_passed`, `worktree_verify_failed`, `worktree_merged`, `worktree_abandoned`
5. Extension of VERIFY stage to perform the remote test + merge
6. Retry / remediation path when verify fails
7. Tests for the new flow

### Out of scope

- UI for inspecting worktree state (use existing vc_list_worktrees MCP tool)
- Cross-batch worktree reuse
- Rebasing mid-batch when main advances (take snapshot, accept potential merge on close)
- Shadow-git checkpoints (Fabro #20 — different feature)

## File structure

```
server/factory/worktree-runner.js           # NEW: per-batch worktree lifecycle
server/factory/loop-controller.js            # MODIFY: EXECUTE uses worktree, VERIFY merges
server/factory/plan-executor.js              # MODIFY: accept working_directory override
server/handlers/factory-handlers.js          # MODIFY: status endpoints show worktree info
server/tests/factory-worktree-runner.test.js # NEW
server/tests/factory-execute-in-worktree.test.js # NEW
```

## Task 1: Worktree lifecycle helper

- [ ] **Step 1: Create `server/factory/worktree-runner.js`**

    Export a DI factory `createWorktreeRunner({ worktreeManager, runRemoteVerify, logger })` returning:

    - `async createForBatch({ project, workItem, batchId }) -> { worktreePath, branch }`
      Uses `worktreeManager.createWorktree({ basePath: project.path, branch: 'factory/<workItem.id>-<slug>', name: 'factory-<batchId>' })`. Slug from work item title, sanitized.

    - `async verify({ worktreePath, branch, verifyCommand, workingDirectory }) -> { passed: boolean, output: string, durationMs }`
      Invokes `runRemoteVerify({ branch, command: verifyCommand, cwd: workingDirectory })` which under the hood shells out to `torque-remote --branch <branch> <verifyCommand>`. Capture stdout/stderr, exit code, duration.

    - `async mergeToMain({ project, branch, worktreePath, commitMessage }) -> { mergedSha: string }`
      Uses `worktreeManager.mergeWorktree({ branch, target: 'main', strategy: 'ff-only' | 'merge' })`. Falls back to merge-commit if ff-only fails. After merge, delete the worktree via `worktreeManager.removeWorktree`.

    - `async abandon({ branch, worktreePath, reason }) -> void`
      Logs, calls `worktreeManager.removeWorktree({ discardChanges: true })`.

- [ ] **Step 2: Commit**

    ```bash
    git commit -m "feat(factory): worktree-runner for per-batch isolation"
    ```

## Task 2: Thread worktree working_directory through plan-executor

- [ ] **Step 1: Add `working_directory` override to `createPlanExecutor`**

    Today `server/factory/plan-executor.js createPlanExecutor` takes `{ submit, awaitTask, projectDefaults, onDryRunTask }`. Add:
    - The `.execute(...)` call already accepts a `working_directory` arg — ensure it flows to every `submit({ working_directory })` call and every `awaitTask` options object.
    - Do NOT change the existing pending_approval / suppress paths.

- [ ] **Step 2: Commit**

    ```bash
    git commit -m "feat(plan-executor): thread working_directory through submit + await calls"
    ```

## Task 3: EXECUTE creates the worktree

- [ ] **Step 1: Wire worktree-runner into loop-controller**

    In `server/factory/loop-controller.js`:
    - Near the top of `executePlanFileStage` (before submit), call `worktreeRunner.createForBatch({ project, workItem: targetItem, batchId })`. Use an existing batch_id if one was attached, else generate `factory-<projectId>-<workItemId>-<timestamp>`.
    - Log decision `execute worktree_created` with branch, worktree path, batch_id.
    - Pass `worktreePath` as the `working_directory` to `createPlanExecutor`'s execute call.
    - Attach the branch and worktreePath to the loop state (reuse loop_batch_id OR add a small in-memory map keyed by project_id).

    Same wire-in for `executeNonPlanFileStage` AFTER plan is generated and written to `docs/superpowers/plans/auto-generated/`. The plan file itself stays in the main worktree (shared across both), but the actual code edits happen in the worktree.

- [ ] **Step 2: Commit**

    ```bash
    git commit -m "feat(factory): EXECUTE creates worktree before submitting plan tasks"
    ```

## Task 4: VERIFY runs remote tests against the worktree branch

- [ ] **Step 1: Replace the current VERIFY skeleton with real verification**

    Today `executeVerifyStage` is a stub that returns `{ status: 'skipped', reason: 'no_batch_id' }`. Replace with:

    1. Look up batch_id from loop state / most recent `started_execution` decision context.
    2. Find the branch and worktreePath for that batch (from worktree-runner state OR from `started_execution` context if we persisted it there).
    3. Determine the verify command: project config `verify_command` (defaults to `npx vitest run` today).
    4. Call `worktreeRunner.verify({ worktreePath, branch, verifyCommand })`.
    5. If passed: log `verify passed`, return `{ status: 'passed', branch, mergedSha: null /* merge happens in LEARN */ }`.
    6. If failed: log `verify failed` with output excerpt, pause loop with `paused_at_stage: VERIFY_FAIL` so operator can decide between remediation or abandonment.

- [ ] **Step 2: Commit**

    ```bash
    git commit -m "feat(factory): VERIFY now runs remote tests against the batch worktree"
    ```

## Task 5: Merge on successful LEARN + cleanup on abandonment

- [ ] **Step 1: Merge worktree into main during LEARN shipping**

    In `executeLearnStage`, when `shipped_work_item` is about to be logged:
    1. Call `worktreeRunner.mergeToMain({ project, branch, worktreePath })`.
    2. Push main (or signal the existing push path). The existing pre-push hook then runs its gate — this is belt-and-suspenders with the remote verify step that already passed.
    3. Log `worktree_merged` with the resulting commit SHA.
    4. Remove the worktree.

    If LEARN decides `skipped_shipping`, leave the worktree in place and let the operator decide later (don't auto-delete unsuccessful work).

    Add a new MCP tool `abandon_factory_worktree(batch_id, reason)` that calls `worktreeRunner.abandon` — the operator can reject work from the Approvals page and clean up.

- [ ] **Step 2: Commit**

    ```bash
    git commit -m "feat(factory): LEARN merges worktree to main on successful ship"
    ```

## Task 6: Tests

- [ ] **Step 1: Worktree-runner unit tests**

    `server/tests/factory-worktree-runner.test.js`:
    - createForBatch returns a worktreePath that exists, on the requested branch
    - verify passes given a stub that returns exit 0; failed given exit 1
    - mergeToMain fast-forwards when possible, falls back to merge-commit
    - abandon removes worktree + discards changes

- [ ] **Step 2: Loop integration tests**

    `server/tests/factory-execute-in-worktree.test.js`:
    - Stub worktreeManager + runRemoteVerify
    - Drive SENSE → PRIORITIZE → PLAN → EXECUTE with a plan_file work item
    - Assert: plan tasks were submitted with `working_directory` = worktreePath (not project.path)
    - Assert: VERIFY calls runRemoteVerify with the expected branch
    - Assert on pass: LEARN merges + ships + worktree removed
    - Assert on fail: loop pauses at VERIFY_FAIL, worktree preserved

- [ ] **Step 3: Commit**

    ```bash
    git commit -m "test(factory): worktree runner + execute-in-worktree regression coverage"
    ```

## Hard constraints

- Preserve backwards compatibility for non-factory task submission — only the factory's plan-executor path gets worktree routing.
- Never edit files under the live project.path from inside EXECUTE. Every code change must land in a worktree first.
- The pre-push hook on main stays as-is — it's the final safety net.
- Remote verification is synchronous and can take minutes. Use `heartbeat_minutes: 0` on any `await_task` it wraps (same lesson from earlier heartbeat fix).
- Test files MUST use ESM imports: `import { describe, it, expect, vi } from 'vitest';`.
- `cd server && npm run lint:di` stays clean.

## Risks and mitigations

- **Worktree leaks**: factory crashes mid-batch → orphan worktrees accumulate. Mitigation: startup sweep via `worktreeManager.cleanupStale({ maxAgeDays: 7 })` scheduled after server start.
- **Merge conflicts**: main advances between branch creation and merge → ff-only fails → auto merge-commit. If merge conflicts, pause at VERIFY_FAIL for human.
- **Remote test flakes**: torque-remote dashboards flake (we've seen this) → retry verify once; pause if second run also fails.
- **Codex CLI needs the worktree to exist on disk before spawning** → createForBatch must await worktree physical creation before returning.

## Out of scope (track separately)

- Automated remediation (re-submit failing tasks with error context) — Fabro #20 + existing retry framework overlap.
- Shadow-git checkpoints — separate feature.
- UI for worktree inspection — use existing `vc_list_worktrees` tool.
- Cross-batch worktree reuse — premature optimization.
