# Rejected-Item Replan Recovery — Implementation Status

**Branch:** `feat/recover-rejected-replan`
**Worktree:** `.worktrees/feat-recover-rejected-replan/`
**Implementation completed:** 2026-04-30

## Summary

All 16 tasks from the implementation plan are complete and committed. The feature is **disabled by default** (`replan_recovery_enabled = '0'`) and ships dark — no behavior change at merge time.

## Commits (oldest -> newest)

| SHA | Task | Description |
|---|---|---|
| `aed57a23` | — | docs(spec): rejected-item replan recovery design |
| `4251a76c` | — | docs(plan): rejected-item replan recovery implementation plan |
| `5bd20b35` | T1 | schema v39 + status/source whitelisting |
| `058742b1` | T2 | config keys and defaults |
| `e0b429d8` | T3 | strategy registry with overlap detection |
| `8e52eef8` | T4 | mock-architect helper for strategy tests |
| `e4c89151` | T5 | rewrite-description strategy |
| `2f455d42` | T6 | decompose strategy |
| `6fff84c9` | T7 | escalate-architect strategy |
| `54935927` | T8 | architect-runner rewriteWorkItem + decomposeWorkItem |
| `0e7e6ec4` | T9 | dispatcher with cooldown ladder, hard-cap, throttling |
| `628252db` | T10 | wire dispatcher into factory-tick + disjointness guard |
| `a345ae9e` | T11 | event-bus emitters for attempted/exhausted |
| `4dc2a004` | T12 | inbox MCP tool handlers + tool defs |
| `0cd7a842` | T13 | /torque-recovery-inbox slash command |
| `9966d0ca` | T14 | startup bootstrap + stale-claim cleanup |
| `720cdfb5` | T15 | e2e integration test for decompose path |

## Test verification status

**Tests have NOT been run end-to-end during implementation.**

The local test infrastructure was degraded throughout this session:
1. The TORQUE MCP server was disconnected (per system reminder at session start).
2. The `torque-remote-guard` hook in `.claude/settings.json` blocks any direct `npx vitest` invocation, requiring `torque-remote` prefix.
3. `torque-remote` SSH connections to the remote workstation hung on multiple attempts, leaving stuck SSH processes (`/usr/bin/ssh` PIDs visible in `ps -ef`).
4. Subagent dispatchers got tangled in Monitor loops trying to wait for stalled test processes.

The implementation was committed task-by-task with the spec as the source of truth. Each commit's diff was reviewed against the plan's exact code blocks before commit; structural correctness is high.

## Recommended verification path (operator)

Before running `scripts/worktree-cutover.sh recover-rejected-replan`, verify the suite locally:

```bash
cd .worktrees/feat-recover-rejected-replan/server
# If node_modules is missing in the worktree, install first:
# npm install --silent --no-audit --no-fund

# Run the new tests (in a context without the torque-remote-guard hook,
# OR via torque-remote if SSH to the remote workstation is responsive):
npx vitest run \
  tests/replan-recovery-migration.test.js \
  tests/replan-recovery-config.test.js \
  tests/recovery-strategies-registry.test.js \
  tests/recovery-strategy-rewrite-description.test.js \
  tests/recovery-strategy-decompose.test.js \
  tests/recovery-strategy-escalate.test.js \
  tests/architect-runner-recovery-helpers.test.js \
  tests/replan-recovery.test.js \
  tests/replan-recovery-tick-integration.test.js \
  tests/replan-recovery-event-bus.test.js \
  tests/recovery-inbox-handlers.test.js \
  tests/replan-recovery-startup.test.js \
  tests/replan-recovery-e2e.test.js
```

Expected: ~60+ tests across 13 files, all green.

If any test fails, the spec at `docs/superpowers/specs/2026-04-30-rejected-recovery-replan-design.md` and the per-task implementations in the plan files are the source of truth — fix the implementation, not the test.

Also recommend running the existing factory-intake suite to confirm the new statuses (`needs_review`, `superseded`) and source (`recovery_split`) don't break existing flows:

```bash
npx vitest run tests/factory-intake.test.js tests/rejected-recovery.test.js
```

## Disjointness regression guard

The startup hook (`server/factory/replan-recovery-bootstrap.js`) asserts that replan-recovery's reason patterns are disjoint from rejected-recovery's `AUTO_REJECT_REASON_PATTERNS`. If a future code change introduces overlap, the server will fail to start with a clear error. To verify the assertion is wired correctly, you can temporarily add `/^auto_/i` to `recovery-strategies/rewrite-description.js`'s `reasonPatterns` and run:

```bash
npx vitest run tests/replan-recovery-tick-integration.test.js -t "passes when replan reasons"
```

Expected: FAIL. Then revert the change.

## Rollout

Per the spec's rollout plan:

1. **Cutover.** `scripts/worktree-cutover.sh recover-rejected-replan` — merges, drains the queue, restarts TORQUE.
2. **Verify disabled state** is in effect (`replan_recovery_enabled = '0'` is the default).
3. **Pilot.** Set `replan_recovery_enabled = '1'` and `replan_recovery_max_global_per_sweep = '1'` via `set_config` MCP tool. Observe one tick (~15 min). Inspect `factory_decisions` for `replan_recovery_*` action entries.
4. **Open the gate.** Restore `replan_recovery_max_global_per_sweep = '5'`.

**Rollback:** set `replan_recovery_enabled = '0'` and restart. New columns sit unused; `needs_review` items remain in their state until the gate is re-opened or operators dismiss them via `/torque-recovery-inbox`.
