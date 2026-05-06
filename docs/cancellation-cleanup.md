# Cancellation + Cleanup Reference

This document is the canonical reference for TORQUE's cancellation and cleanup paths. Same audit playbook as `docs/recovery-decisions.md` and `docs/factory-loop-states.md`. Cleanup paths have historically been a source of stuck-state bugs (terminal-zombie subprocess leftovers, orphaned worktree dirs, retry timers firing on already-failed tasks); this doc consolidates what the system actually does so future changes don't drift.

---

## TL;DR

Cleanup is **9 distinct concerns** mixed across many files. They share state — the same `runningProcesses` Map, `cleanupGuard`, finalization marker, etc. — but enter from different triggers (operator cancel, timer sweep, restart, finalize). Race conditions hide at the edges where one path's "done" doesn't match another path's "still active."

**Real bug found and fixed in this audit:** retry-framework's setTimeout callback only checked for `status === 'cancelled'` before resuming a delayed retry. If any other path (orphan-cleanup's stale-check, batch_cancel, factory rejection sweep, manual API call) marked a `retry_scheduled` task `failed` (or `completed`/`shipped`/`unactionable`/`escalation_exhausted`) while the timer was pending, the callback would *resurrect* it as `queued` and re-run a deliberately-terminated task. Fix: gate on `status === 'retry_scheduled'` instead.

---

## The 9 cleanup concerns

| # | Concern | Entry point | Trigger | Scope |
|---|---|---|---|---|
| 1 | **Task-level cancel** | `task-cancellation.js cancelTask` | Operator API, workflow cascade | Single task subprocess + trackers |
| 2 | **Workflow cancel** | `cancelWorkflow` (cascading task cancels) | Operator API | All tasks in workflow DAG |
| 3 | **Bulk cancel** | `batch_cancel` (filter-based) | Operator API | All matching queued/running/retry-scheduled |
| 4 | **Orphan task cleanup** (sweep) | `maintenance/orphan-cleanup.js` `cleanupTerminalTaskSubprocesses`, `checkStaleRunningTasks` | Timer ~30s | DB rows ↔ live processes mismatch |
| 5 | **Worktree cleanup** | `version-control/worktree-manager.js forceRmSync`, `factory/worktree-reconcile.js forceRmDir` | Factory reconciler, manual | Filesystem + git metadata |
| 6 | **Factory orphan reconciler** | `factory/orphan-reconciler.js findOrphanFactoryBranches` | Manual audit | Origin branches with no merged commits |
| 7 | **Tracker cleanup** | `processTracker.cleanup`, `finalizationTracker.delete` | Close handler, cancel, finalize | In-memory state maps |
| 8 | **Restart-time cleanup** | `cleanupStaleRestartBarriers`, `startup-task-reconciler` | Server boot | Stale barrier tasks + re-adopt-vs-fail decisions |
| 9 | **Terminal zombie cleanup** | `orphan-cleanup.js checkZombieProcesses` | Timer ~30s | Tracked processes whose `close` event never fired |

Most operator-visible stuck-state bugs come from **gaps between concerns**: e.g., a task in (1)'s scope that (4)'s sweep also reaches, or (7)'s tracker state surviving (5)'s worktree disappearance.

---

## State maps (the cleanup currency)

Cleanup is partly about removing entries from in-memory state. These are the maps cleanup operations touch. All currently live in `processTracker` (post-DI consolidation) but were historically scattered.

| Map | Owner | Cleanup site(s) | Lifetime / TTL | Leak risk |
|---|---|---|---|---|
| `runningProcesses` | `process-tracker.js` | `cleanup(taskId)`, close handler, zombie check | Process lifetime | Medium — guarded by zombie check (~30s cadence) + finalization marker |
| `finalizingTasks` (FinalizationTracker) | `finalization-tracker.js` | `delete(taskId)` on close-handler exit | 15min idle TTL via stale-check | Low — bounded by `finalizing_task_stale_minutes` config |
| `cleanupGuard` | inside `processTracker` | TTL sweep (60s TTL, 30s passive sweep) | 60s | Low — passive sweep on each `markCleanedUp` call |
| `pendingRetryTimeouts` | inside `processTracker` | `cancelTask`, retry callback fires | Until timer fires or task cancelled | **Was MEDIUM** — callback didn't bail on terminal statuses other than `cancelled`. **Fixed 2026-05-06** (this audit) |
| `apiAbortControllers` | inside `processTracker` | `cancelTask`, `cleanup` | API request lifetime | Low |
| `stallRecoveryAttempts` | inside `processTracker` | `cancelTask`, stale-check, zombie check, `cleanup` | Process lifetime | Low |

### TTL alignment caveat

`cleanupGuard` (60s TTL) is much shorter than `finalizingTasks` stale-check (15min). The `finalizingTasks` marker is the real guard against double-finalize for long-running close handlers (auto-verify can take 60-90s). `cleanupGuard` is best-effort — if a close handler runs >60s, the guard expires but `finalizingTasks` still protects via heartbeat-based staleness. If close handler crashes such that `finalizingTasks.delete()` never fires, the task stays in finalization for the full 15min before stale-check picks it up. Worth knowing when debugging a "task stuck at finalizing" report.

---

## Task lifecycle → cleanup matrix

For each terminal-or-near-terminal status transition, who calls cleanup:

| Status transition | Who calls it | Cleanup invoked |
|---|---|---|
| `running` → `completed` | Close handler (process-lifecycle.js) → `finalizeTask` | `processTracker.cleanup`, `finalizingTasks.delete`, host slot decrement |
| `running` → `failed` | Same path; finalizer's pipeline determines failure | Same as completed |
| `running` → `cancelled` | `cancelTask` API | `cleanupChildProcessListeners` (skipped on abandon), `cleanupProcessTracking` (releases trackers + locks) |
| `running` → `failed` (timeout) | `orphan-cleanup.js checkStaleRunningTasks → requeueOrFailDeadOwner` | DB status update, but **doesn't clear `pendingRetryTimeouts`** if a retry was scheduled in parallel — see "real bug" below |
| `retry_scheduled` → `queued` | retry-framework's setTimeout callback | timer cleanup, `pendingRetryTimeouts.delete`. **NEW (2026-05-06): refuses to resume if status moved to any non-`retry_scheduled` value while pending** |
| `retry_scheduled` → `failed` (final attempt) | retry-framework callback's `startTask` rejection | `db.updateTaskStatus(...failed)` |
| any → restart-survivor | `startup-task-reconciler` | Re-adopt or mark failed based on PID liveness + retry count |

### The retry-vs-fail race (fixed in this audit)

Pre-fix, this sequence was a real correctness bug:

1. Task fails. retry-framework writes `status='retry_scheduled'`, schedules `setTimeout(...30s)`, stores handle in `pendingRetryTimeouts[taskId]`.
2. Within 30s, another path determines the task should terminate:
   - `orphan-cleanup.js requeueOrFailDeadOwner` writes `status='failed'` because `retry_count >= max_retries` (line ~526-538).
   - Or `batch_cancel` writes `status='cancelled'` (this case was guarded).
   - Or factory-tick rejection sweep writes `status='unactionable'`.
   - Or operator manually rejects the work item, which propagates to its tasks.
3. Original setTimeout fires. The callback only bailed on `status === 'cancelled'`. For `failed` (and others), it proceeded to write `status='queued'` and call `startTask(taskId)` — **resurrecting a deliberately-terminated task**.

Fix: callback now bails for any `status !== 'retry_scheduled'`. Same protection pattern as the loop's `approveGate` pre-flight check (gate state must still be paused) — if the world has moved on, we don't act.

---

## Worktree cleanup layered fallback

`forceRmSync` / `forceRmDir` try four layers, each handling a different OS-level failure mode. Every later layer assumes the prior layer's specific failure shape.

| # | Layer | Handles | Failure mode |
|---|---|---|---|
| 1 | `fs.rmSync` (recursive + force, 3 retries × 100ms) | Common case | Read-only files, file locks (AV scan), symlinks |
| 2 | `chmod 0o666` recursive + retry `fs.rmSync` | Read-only barrier (git internals, build outputs marked 0o444) | AV still holds handle (chmod doesn't release locks) |
| 3 | Shell `rmdir /s /q` (Windows) or `rm -rf` (POSIX) | Different OS unlink semantics | Path too long, AV scanning, process holding handle |
| 4 | Quarantine rename to `.torque-delete-pending/<name>-<ts>-<pid>-<i>` | Last resort if delete fails | Rename also fails (very rare) |

### `.torque-delete-pending` mechanism

Worktrees that hit Layer 4 land in a sibling `.torque-delete-pending/` directory. The factory reconciler's next sweep retries deletion via `reclaimDir` (4-step sequence: git worktree remove --force → fs.rmSync → git worktree prune → git branch -D). No fixed cadence; tied to factory loop tick (~1-2 min per project). **No size budget, no operator alert, no escalation.** A directory that AV permanently locks accumulates indefinitely — the operator must manually `Remove-Item` after resolving the lock.

This is the source of the "Access is denied" log spam observed during cutovers — the reconciler logs the same failures every 15 minutes (suppressed-spam interval). See open question #2 below.

---

## Cancel-vs-finalize race guards

Multiple paths can terminate a task. Guards prevent double-finalize:

| Guard | Mechanism | Coverage |
|---|---|---|
| `cleanupGuard` (TTL Map) | `markCleanedUp(taskId)` returns false if already cleaned. 60s TTL. | First-line guard; primary close handler entry. |
| `finalizingTasks` heartbeat marker | Close handler calls `start()` on entry, `touch()` per stage. Idle >15min triggers stale-check abandonment. | Long-line guard; protects through 60s+ finalization (auto-verify) for the common case. |
| DB status re-read | Operations re-read `task.status` and bail if it's not what they expected. | Race protection for cancel-vs-close-handler. |
| `closeEventFired` (per-spawn) | Set true by `close` handler; checked by 2s instant-exit watchdog and 5s exit→close fallback. | Process-level race protection (see `process-lifecycle.js`). |

Edge case still possible: close handler crashes with finalizingTasks marker leaked, cleanupGuard expires after 60s, stale-check fires after the 15min `finalizing_task_stale_minutes` window, and the original handler's exception path eventually runs another finalize. Result: double DB update / double webhook. Mitigated by DB status re-read but not strictly prevented. See open question #1.

---

## Open questions / risks

These are real ambiguities the audit surfaced. Each is worth addressing the next time their area comes up.

### 1. ✅ ~~Retry timer resurrects terminal-status tasks~~ RESOLVED 2026-05-06

retry-framework's setTimeout callback only bailed on `cancelled`; other terminal statuses (`failed`, `completed`, `shipped`, `unactionable`, `escalation_exhausted`) silently flipped back to `queued`. Fixed: gate on `status === 'retry_scheduled'`.

### 2. `.torque-delete-pending` has no size budget or operator alert

Directories quarantined under Layer 4 accumulate indefinitely if AV permanently locks files. No quota, no dashboard warning, no cleanup policy — just retry-on-next-sweep with a 15-minute log-spam suppressor. **Action:** Add periodic alert if `.torque-delete-pending` size exceeds threshold (e.g., 10GB) or if any quarantined entry is >24h old.

### 3. cleanup-guard TTL (60s) << finalizingTasks stale-check (15min)

If close handler runs >60s, `cleanupGuard` expires before finalization marker. Mitigated by `finalizingTasks` heartbeat in normal operation. Edge case: close-handler crash with leaked marker → 15min window where stale-check could fire but guard already expired. Realistic exposure: hung webhook + close-handler exception. **Action:** Consider raising cleanup-guard TTL to match finalization-marker timeout, or tying both to a shared config knob.

### 4. POSIX zombie detection weaker than Windows

`checkZombieProcesses` runs Check 4 (Windows tasklist) only on Windows. POSIX falls back to `process.kill(pid, 0)` which can report false-alive after exit. **Action:** Add a Linux-equivalent kernel check (e.g., `/proc/<pid>` existence) for parity.

### 5. Tracker cleanup on shutdown is best-effort — **VERIFIED SAFE 2026-05-06**

`cleanupAll()` is called explicitly on shutdown but not on crash. After restart, `cleanupStaleRestartBarriers` clears barrier tasks; per-task retry timeouts from the prior process vanish with the dead process. **The reconciler closes the gap on the DB side**: `startup-task-reconciler.js:612-669` queries rows with `status IN ('running','claimed','retry_scheduled')` and the `retry_scheduled` branch (lines 632-669) re-queues or fails based on `retry_count vs max_retries`. The bba865d8 (2026-05-03) fix enforces the same `>` boundary as `shouldRetry`'s `<=` — a final retry whose timer was lost to a restart still gets its run instead of being marked failed. There is no in-memory state to reconcile because the timer handle dies with the process; the DB row is the only authority, and the reconciler reads it correctly.

**Test coverage** (`server/tests/startup-task-reconciler.test.js:865-1026`): 5 regression tests pin the behavior — re-queue with budget remaining, fail with budget exhausted, re-queue at boundary (count==max, the bba865d8 case), conservative re-queue with null retry fields, and skip when owner instance is still alive. Open question resolved with verified-safe status.

### 6. Worktree reconciler 1-min "fresh dir" age check can race with slow vc_worktrees insert

If DB insert is delayed (contention, fsync), the reconciler's `ORPHAN_DIR_MIN_AGE_MS` could allow reclamation of a worktree mid-creation. **Action:** Add an explicit `ready_for_reconcile` flag or grace period tied to creation acknowledgement, not wall-clock age.

### 7. Stall-recovery attempt counter never resets on provider fallback

`stallRecoveryAttempts[taskId]` is deleted on terminal paths but not reset when a task switches providers via fallback-retry. Each provider's stall history is isolated, but logs combining them can be misleading. **Action:** Track per-(taskId, provider) attempts if cross-provider analysis matters; benign otherwise.

### 8. Abandon path leaves detached process unmonitored

`cancelTask(..., { abandon: true })` unhooks tracking but leaves the subprocess alive. Tail watchers + liveness loops are stopped, so the process runs to completion (or stalls) without TORQUE knowing. **Action:** Document the abandon contract more loudly — operator opts into "I'll watch this manually" semantics.

### 9. Finalization-marker idle timeout vs factory hard-cap mismatch

Factory plan generation can legitimately run 30-60min. If close handler is doing post-task work tied to that, the finalization marker's 15min default could go stale. Config `finalizing_task_stale_minutes` exists but isn't documented as factory-correlated. **Action:** Document the relationship in `docs/factory.md` or add a derived-config helper.

### 10. cancelTask after task moved to retry_scheduled is partially guarded

Cancel path checks status and bails on terminal states, but `retry_scheduled` is treated as "still active" — cancel proceeds. The cancel writes `status='cancelled'`. retry-framework's NEW guard (#1 fix) handles the timer side: it sees `cancelled` and bails. But if cancel races with the timer fire itself (both happen in same event loop tick), there's a brief window where status could flip cancelled → queued → cancelled. Order-dependent; in practice the timer's status re-read protects via the new guard. **Action:** Confirm behavior under concurrent cancel + timer-fire test; current node single-threaded execution should serialize them safely.

---

## When changing cleanup paths

If you're adding or modifying cancellation/cleanup logic:

1. **New cleanup site** — add to the 9-concern table above. Identify which state maps it touches (see "State maps" table). Document idempotency and any guards.
2. **New status transition** — the retry-vs-fail bug class is well-known: any setTimeout/setInterval callback that resumes a task by status MUST gate on the *expected* status, not just bail-out for one or two terminal states. Use `status === 'expected_state'` allow-list, not `status !== 'unwanted_state'` deny-list.
3. **New tracker map** — register it with `processTracker` (post-DI consolidation). Add to the State maps table. Specify cleanup sites + leak risk.
4. **New worktree cleanup layer** — read worktree-manager.js's existing layers carefully. Each later layer assumes a specific failure mode of the prior. Don't add layers that overlap.
5. **New `.torque-delete-pending` interaction** — be aware there's no quota/escalation. If your code adds quarantine entries, consider whether it also needs an alert path.

---

## Related references

- `docs/recovery-decisions.md` — the recovery layer that runs ON failed tasks. Cleanup is what happens BEFORE recovery decides anything (terminating the task subprocess, releasing trackers).
- `docs/factory-loop-states.md` — state-machine for the factory loop. The `paused` variants there interact with cancellation: project-pause vs gate-pause vs stage-occupancy park have different cleanup semantics.
- `docs/factory.md` — factory operator runbook.
- `server/execution/task-cancellation.js` — task-level cancel + abandon paths.
- `server/maintenance/orphan-cleanup.js` — periodic sweep + zombie checks (the biggest cleanup file).
- `server/factory/worktree-reconcile.js` — factory worktree GC + `.torque-delete-pending` mechanism.
- `server/plugins/version-control/worktree-manager.js` — `forceRmSync` layered fallback.
