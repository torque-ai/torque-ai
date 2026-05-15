# Pre-push gate: phantom failure on concurrent same-SHA push

**Date observed:** 2026-05-15
**Severity:** Medium — user-visible "push failed" with a green gate; doesn't corrupt anything but burns operator time and gate cycles.
**Components:** `scripts/pre-push-hook`, `scripts/repo-coordination-lock.sh`, `bin/torque-remote` (indirectly, when remote is unreachable and we fall back to local).
**Status:** Triaged, not fixed.

---

## TL;DR

When two `git push origin main` invocations race against the same local HEAD and the first push's parent process dies (or is severed by the harness's output cap) while its gate is still running, the second push waits, observes the gate finishing successfully, but then **falls through to running its own gate from scratch** because the cleanup contract is "the leader push pushes to origin; followers ride along". With the leader's parent gone, nobody pushes — the follower has no signal that the work it just waited 10–13 minutes for actually passed.

Symptom from the operator's chair: gate green, artifact `status=passed`, exit code 0, **and the push exits 1 anyway**.

---

## Observed run (2026-05-15, SHA `7b3e530c4b61`)

1. `T+0` (`19:09:51Z`) — first `git push` starts. Hook acquires main-gate lock, owner `pid=18899` / `windows_pid=19732`.
2. `T+3s` (`19:09:54Z`) — first artifact written: `status=running`, `execution_mode=local_fallback` (remote workstation unreachable per `remote_probe_reason=unavailable:ssh_unreachable:host=<remote-host>`).
3. `T+43s` (`19:10:37Z`) — last `pre_push_set_gate_phase` write: `phase=Local gate`, `detail=running`, artifact's `updated_at` frozen here for the next 12 minutes.
4. `T+~60s` — operator's parent bash for the first push reports exit 1 to the harness. The child gate process (PID 18899) keeps running, now orphaned.
5. `T+~90s` — second `git push origin main` invoked. Hook calls `wait_for_matching_pre_push_gate()` (scripts/pre-push-hook:345–411), sees the same `purpose=pre-push main gate: 7b3e530c4b61` lock, begins polling.
6. `T+~90s..~13min` — follower sees lock-dir heartbeat ticking (`output_bytes` grows 21020 → 23640 → 30545 → 33315 → 43904 → 46599 → 56392 → 69320; `heartbeat_age` stays single-digit seconds). All reap checks pass: owner alive, lease fresh, purpose unchanged.
7. `T+~13min` (`19:22:53Z`) — leader gate's `pre_push_cleanup` trap fires:
   - artifact updates to `status=passed`, `exit_code=0`, `combined_exit=0`, `gate_end_marker=[gate-end] dash_exit=0 serv_exit=0 perf_exit=0`
   - lock released, `lock_dir` removed
8. Follower's `while [ -d "$lock_dir" ]` loop exits naturally.
9. Follower runs `origin_main_matches_local_head` (scripts/pre-push-hook:405) — **false**, because the leader's parent died at step 4 and never executed `git push`'s actual ref-update protocol stage.
10. Follower falls through with `return 1` and the message *"Previous matching gate finished without updating origin/main; this push will run the gate."* (line 409).
11. Hook proceeds to `repo_coord_lock_acquire` (line 691) and starts the follower's own gate from scratch. That gate fails for some reason in its first phase (port collisions with the just-finished leader's tail processes, leftover worktree contents at `/tmp/pre-push-local-gate.NlPRxs/`, or coalescing artifact path — undetermined without re-run).
12. Operator sees `EXIT=1` on the second push.

Final state: origin/main not updated despite a clean gate pass. Operator pushes a third time with `--no-verify` to actually land the commits.

---

## Root cause analysis

Three independently-correctable defects compound:

### Defect A — Artifact freshness lags behind heartbeat freshness

`pre_push_write_gate_artifact "running"` is only called from `pre_push_set_gate_phase` (line 454) and `pre_push_start_gate_artifact` (line 554). The heartbeat file (`$lock_dir/heartbeat.env`) updates every poll inside `pre_push_write_gate_heartbeat_once` — but that's a **separate file** read by `repo_coord_lock_describe`, not the artifact.

Consequence: a follower that wants ground truth from the artifact (e.g. to know if the leader has actually crossed `gate_end_marker`) gets a 12-minute-old snapshot during long local-gate phases. The artifact transitions `running → passed/failed` only in the EXIT trap (line 681).

### Defect B — Leader-dies-mid-gate orphans the work

`wait_for_matching_pre_push_gate` (line 345–411) implicitly assumes the leader will perform the push-to-origin step after its gate passes. There's no contingency for "leader bash died, gate child kept running, gate passed, but no one pushed."

The proximate trigger here was the harness's 35.7 KB output cap on the first background bash — the bash wrapper got disconnected from its child process tree, exit code 1 propagated up. On a normal CLI session this is rarer but still possible (Ctrl-C, SIGHUP, terminal closed). The hook design makes the leader's parent process a single point of failure for the push outcome.

### Defect C — Follower can't claim a passed result

When the lock dir disappears, the follower checks `origin_main_matches_local_head`. If false, it runs its own gate. There's no third option: **"a same-SHA gate just passed; let me push directly without re-running."**

A correct design would check the most-recent artifact in `.git/torque-pre-push-gate-artifacts/` for the local HEAD's short SHA. If `status=passed && exit_code=0 && created_at_epoch within $PRE_PUSH_PASS_TRUST_WINDOW_SECS && head_sha == local HEAD`, the follower should be allowed to skip its gate and proceed to the actual `git push` protocol step. The artifact already records `head_sha` and `gate_plan_hash` — both required to make this safe against ref drift.

---

## Repro recipe

Easiest synthetic repro (no harness needed):

```bash
# Terminal 1
git push origin main          # blocks in gate

# Terminal 2, ~5s later
git push origin main          # waits, eventually exits 1
```

To force the leader-dies condition:

```bash
# Terminal 1
nohup git push origin main >/tmp/leader.log 2>&1 &
sleep 5
# kill ONLY the bash wrapper, not the gate child:
pkill -P $! bash || true
# leader's gate keeps running, parent is gone

# Terminal 2
git push origin main          # waits, sees gate pass, exits 1
```

Expected (current): second push exits 1 after wait + own-gate-run.
Desired: second push detects passed artifact for current HEAD and either pushes directly or exits 75 (`PRE_PUSH_COALESCED_EXIT_CODE`).

---

## Fix sketch

Recommend addressing in this order:

1. **Defect A — periodic artifact refresh.**
   Wire a timer into `pre_push_start_gate_heartbeat` that calls `pre_push_write_gate_artifact "running" ""` every N seconds (configurable, default 30s). Today's heartbeat-vs-artifact split is more confusing than useful; one of them should be canonical for "is the gate making progress."

2. **Defect C — follower-claims-passed-result.**
   In `wait_for_matching_pre_push_gate`'s post-loop block (after the `while` exits because `lock_dir` went away), before checking `origin_main_matches_local_head`:

   - Glob `.git/torque-pre-push-gate-artifacts/${local_head_short}-*.txt`, sort by `updated_at_epoch`, pick newest.
   - If `status=passed`, `exit_code=0`, `head_sha == $(git rev-parse HEAD)`, and `now - created_at_epoch < ${PRE_PUSH_PASS_TRUST_WINDOW_SECS:-1800}` (30 min default — short enough that ref drift is unlikely, long enough to cover a gate run plus the time to detect a follower):
     - Print a clear message: *"Concurrent gate already passed for $local_head_short at $updated_at; proceeding with push."*
     - Return 0. The hook script's normal flow then continues to the actual `git push` protocol step.
   - Else fall through to today's behavior.

3. **Defect B — leader-died observability.**
   When the follower's wait loop reaps an owner via `repo_coord_lock_reap_if_dead_owner`, log the dead PID + heartbeat-age and surface it in the cleanup artifact so a future operator can correlate "why did my push fail?" with "the leader bash got killed." Today the reap is silent.

---

## Test plan

New test file `server/tests/pre-push-gate-coordination.test.js`:

1. **Concurrent passers ride one gate.** Spawn two `bash scripts/pre-push-hook` invocations against an isolated fixture repo with a stub gate that sleeps 3s and writes `status=passed`. Both should succeed; only one should run the gate command.
2. **Leader-dies-after-pass produces follower-rides.** Same setup, but `SIGKILL` the leader bash after the artifact is written. The follower should detect the passed artifact and complete the push.
3. **Leader-dies-mid-gate forces follower-runs.** Same setup, but `SIGKILL` before the artifact reaches `status=passed`. The follower must run its own gate (today's behavior — pin the negative case).
4. **Stale passed artifact is ignored.** Write an artifact dated 1h ago with `status=passed`. The follower must NOT trust it; run its own gate.

Pin the trust window with `PRE_PUSH_PASS_TRUST_WINDOW_SECS=0` in test 4 to make the gate behavior deterministic.

---

## Related context

- This was hit on 2026-05-15 while pushing the `2026-05-15-efficiency-backlog.md` doc. The remote workstation was SSH-unreachable, so the gate ran in `execution_mode=local_fallback` and took ~13 minutes instead of the ~7 minute remote norm.
- Operator memory `project_gate_infra_arc_2026_05_07_08.md` documents the prior gate-infra arc that took gate runs from 30 min down to 7 min on remote. This new failure mode only surfaces when remote is down AND a second push races on the same SHA.
- Operator memory `project_gate_parallelism_arc_shipped.md` introduced multi-lane gate parallelism on remote — orthogonal to this bug; lane locks are separate from the main-gate coordination lock this spec targets.
- `PRE_PUSH_COALESCED_EXIT_CODE=75` is already the exit-code convention for "we deliberately didn't push because the work is already on origin." Reuse it from defect-C's success path to keep behavior consistent.

---

## Out of scope for this spec

- The underlying SSH unreachability of the remote workstation. Separate concern; tracked elsewhere.
- The harness-side output cap on background bash that severed the leader's parent. Claude-Code-harness limitation, not a TORQUE bug.
- General gate performance work on the local-fallback path. The 13-minute local run is real but expected when remote is down.
