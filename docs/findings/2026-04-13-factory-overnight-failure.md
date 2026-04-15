# Factory Overnight Run — Failure Report (2026-04-13 → 2026-04-14)

## Outcome
Overnight autonomous run was aborted after ~20 min setup + 1 failed loop attempt. Main working tree was corrupted by factory executing against it. Corruption has been reverted. Factory is idle. No further loops ran.

## Timeline
1. Trust set to `autonomous`, pipeline parallelism on. Cron `bf30e57b` scheduled for recurring drive.
2. Item #232 (Fabro #99 managed-oauth) had been shipped earlier in the day (commit `c88a8d18`, worktree merged at 18:21:58), but status was never flipped to `completed` — stayed `verifying`/`in_progress`.
3. PRIORITIZE re-picked item #232.
4. `03:46:56 [execute] worktree_creation_failed: UNIQUE constraint failed: factory_worktrees.branch` — `factory_worktrees` row #7 still held the branch name from the prior merged run.
5. Factory **silently fell back to `main_worktree`** and ran Codex against the primary working tree.
6. Codex partially re-did Fabro #99 work (auth stores, managed-oauth handlers, tool-registry behavioral tags wiring, plan checkboxes).
7. `03:55:51 [execute] execution_failed: task 3 failed` — factory aborted, leaving main dirty.
8. Cron deleted at wake-up, files reverted, stale worktree row deleted, item #232 marked completed.

## Bugs to fix (ordered by severity)

### Critical: fallback-to-main-worktree on worktree_creation_failed
**Location:** factory execute stage, worktree creation path.
**Behavior:** When `factory_worktrees` UNIQUE constraint fires (or any other worktree creation error), factory emits `worktree_creation_failed` with `"fallback": "main_worktree"` and runs the execute task against the primary working directory.
**Impact:** Workspace corruption, unreviewed commits to main, plan files mutated outside a worktree.
**Fix:** Remove fallback. `worktree_creation_failed` must fail loud — transition instance to VERIFY_FAIL or a new EXECUTE_BLOCKED state, surface to user, never silently use main.

### High: shipped items re-picked because status stays `in_progress`
**Symptom:** Item #232 merged successfully but `factory_work_items.status` was never advanced to `completed`/`shipped`. PRIORITIZE then re-claims it.
**Fix:** Ensure the merge path sets terminal status atomically. Confirm `update_work_item` → `completed` transitions are durable (user reported flip-back from completed → executing earlier in the session).

### High: stale `factory_worktrees` rows collide with future runs
**Symptom:** Rows with `status = 'merged'` still hold unique branch names. Any attempt to re-create the same branch hits UNIQUE and (today) falls through to main.
**Fix options:** (a) relax UNIQUE to partial index on `status != 'merged'`, (b) include a generated suffix (timestamp or instance id) in the branch, or (c) purge merged rows after a grace period. Combined with the critical fix above, the symptom goes from "workspace corruption" to "instance fails cleanly" — but avoiding the collision entirely is still preferable.

### Medium: advance job hangs block subsequent advances
Advance job `d5b93eb1` stayed `running` after EXECUTE failure and blocked further `advanceLoopInstance` calls. Restart cleared in-memory state but DB instances persisted. Needs a reject/terminate path for non-gate states.

### Low: cron `durable: true` is ignored
Scheduled cron was session-only despite the durability flag. Separate issue, documented for tracking.

## Remaining DB state to review
- `factory_worktrees` rows #3 (wi 222, status=active, 2026-04-14 02:24) and #4 (wi 221, status=active, 2026-04-14 04:09) — marked active but have no matching git branch or `.worktrees/` directory. Left in place pending user review.
- Items #221, #222 — shipped earlier today, status unchecked. Likely same flip-back risk as #232.

## What was reverted
`git checkout --` on 7 files:
- `docs/superpowers/plans/2026-04-11-fabro-99-managed-oauth.md` (checkboxes)
- `server/auth/auth-config-store.js`
- `server/auth/connected-account-store.js`
- `server/handlers/managed-oauth-handlers.js`
- `server/mcp/tool-registry.js`
- `server/tests/auth-config-store.test.js`
- `server/tools.js`

Working tree now clean on `main`, no pending commits.

## Recommendation before resuming overnight runs
Do not re-enable autonomous cron until the critical fallback-to-main bug is fixed. Single supervised loop attempts are safe.
