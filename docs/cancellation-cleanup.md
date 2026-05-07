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

## Abandon mode contract

`cancelTask(id, reason, { abandon: true })` is one of three cancel modes (default / `force` / `abandon`). It is a deliberate operator opt-in to **release the TORQUE slot while leaving the OS subprocess running**. The contract is precise — abandon does NOT mean "best-effort kill" or "kill if possible." It means "TORQUE walks away."

### What abandon does

- **DB**: Task row marked `status='cancelled'`, `cancel_reason='abandon'` (forensic trail).
- **OS subprocess**: Left alive. No SIGTERM, no SIGKILL, no taskkill. The process runs until it exits on its own (or you kill it manually).
- **Process tracking**: Tail watchers, PID-liveness loops, stall-detection, finalization markers, host-slot reservation — all released. TORQUE has no further visibility into the process.
- **Stdout/stderr**: For detached subprocesses (`spawnAndTrackProcessDetached` — codex/codex-spark/claude-cli on Phase D+), output continues writing to the persisted log files. For pipe-based children (legacy non-detached spawn), the parent stops reading; the child eventually SIGPIPEs when its buffer fills.
- **Webhooks**: Cancellation webhook fires with `cancel_reason='abandon'` so external observers know.

### What abandon does NOT do

- It does NOT guarantee the subprocess will eventually finish. A hung/looping subprocess will keep running indefinitely. **The operator is on the hook** for noticing and killing it via OS-level tools.
- It does NOT hand the subprocess off to a successor TORQUE process. After abandon, no TORQUE instance will ever re-adopt or reap that subprocess.
- It does NOT clean up the worktree the subprocess might be writing into. The factory's `worktree-reconcile` sweep eventually catches abandoned worktrees, but if the abandoned subprocess is still actively writing files into one, sweep will skip it (live-in-use detection) and quarantine layer will eventually fire.
- It does NOT play well with `force: true` — passing both is treated as `abandon` (abandon wins because it's the higher-leverage instruction). The kill is skipped.

### When to use abandon vs force vs default

| Mode | Use when | What happens to subprocess |
|---|---|---|
| **default** (`{}`) | Normal cancellation | SIGTERM, 5s grace, then SIGKILL (or taskkill /F /T on Windows) |
| **force** (`{ force: true }`) | Subprocess wedged, SIGTERM not working | Immediate SIGKILL — no grace |
| **abandon** (`{ abandon: true }`) | "I want my slot back; the subprocess will exit eventually OR I'll handle it manually" | Subprocess left alive; no signal sent |

### Operator responsibility

After abandoning a task, **monitor the subprocess yourself**. On Linux: `ps -ef | grep <pid>` or `cat /proc/<pid>/status`. On Windows: `Get-Process -Id <pid>` or `tasklist /FI "PID eq <pid>"`. If you intend the subprocess to keep producing useful output, also tail the log file — TORQUE will not surface it after abandon.

### Where this is wired

- `server/execution/task-cancellation.js:133-220` — abandon branch (logs `[Cancel] Task <id> abandoned — leaving detached subprocess pid=<pid> alive` for detached, or `non-detached child may exit on stream close` for pipe-based).
- `server/handlers/task/core.js:1310-1363` — MCP `cancel_task` tool surfaces the option, pre-flight modeNote, and post-cancel suffix `(abandoned — subprocess left alive)`.
- `server/tool-defs/task-management-defs.js:148-149` — tool description says "use `abandon` to release the TORQUE slot while leaving a detached subprocess running."

---

## Open questions / risks

These are real ambiguities the audit surfaced. Each is worth addressing the next time their area comes up.

### 1. ✅ ~~Retry timer resurrects terminal-status tasks~~ RESOLVED 2026-05-06

retry-framework's setTimeout callback only bailed on `cancelled`; other terminal statuses (`failed`, `completed`, `shipped`, `unactionable`, `escalation_exhausted`) silently flipped back to `queued`. Fixed: gate on `status === 'retry_scheduled'`.

### 2. ✅ ~~`.torque-delete-pending` has no size budget or operator alert~~ RESOLVED 2026-05-06

`worktree-reconcile.js` now runs `auditQuarantineDir` on every `reconcileProject` call (per-project, every factory tick) and emits a single `warn` log via a 15-min suppressor (`shouldLogDeletePendingWarn`) when total bytes exceed `TORQUE_DELETE_PENDING_SIZE_WARN_BYTES` (default 10 GB) or any entry's age exceeds `TORQUE_DELETE_PENDING_AGE_WARN_MS` (default 24 h). The audit traverses the quarantine tree with a 100k-entry cap; symlinks are NOT followed (security: prevents counting outside-quarantine state). The audit result is included in `reconcileProject`'s return as `quarantineAudit` so callers can surface it in dashboards if needed. Pinned by 11 regression tests in `tests/worktree-reconcile.test.js` covering missing-dir / empty / sums-recursively / symlink-non-follow / suppressor-interval / per-project-isolation / env-overrides / breach-via-size / no-breach / early-return-path.

### 3. ✅ ~~cleanup-guard TTL (60s) << finalizingTasks stale-check (15min)~~ RESOLVED 2026-05-07

`ProcessTracker._cleanupGuardTtlMs` default raised from 60s to 900000ms (15 min) to align with `finalizing_task_stale_minutes` default. The two TTLs now both reach the long-line stale-check window, eliminating the prior 14-min gap where a close-handler crash with leaked finalizingTasks marker could lead to double-finalize. Operators can tune via `TORQUE_CLEANUP_GUARD_TTL_MS` (positive integer, ms).

### 4. ✅ ~~POSIX zombie detection weaker than Windows~~ RESOLVED 2026-05-06

`server/utils/proc-status.js` adds `checkProcStatusLinux(pid, opts)` which reads `/proc/<pid>/status` and parses the `State:` field. Returns `'alive' | 'zombie' | 'dead' | 'unknown'`. `Z` (zombie) and `X` (transitional dead) both classify as `zombie`; ENOENT classifies as `dead`; non-Linux platforms (macOS, Windows, BSD) return `unknown` (conservative skip). `checkZombieProcesses` Check 4b wires this in next to the Windows tasklist Check 4 — only force-cleanup on definitive `dead` or `zombie` verdicts; `unknown` preserves prior (Check 3 / process.kill) behavior. Pinned by 12 regression tests using a fake `/proc` tmpdir tree (R/S/D alive, Z/X zombie, missing-dir dead, unparseable unknown, non-Linux unknown, invalid PIDs, EISDIR unknown).

### 5. Tracker cleanup on shutdown is best-effort — **VERIFIED SAFE 2026-05-06**

`cleanupAll()` is called explicitly on shutdown but not on crash. After restart, `cleanupStaleRestartBarriers` clears barrier tasks; per-task retry timeouts from the prior process vanish with the dead process. **The reconciler closes the gap on the DB side**: `startup-task-reconciler.js:612-669` queries rows with `status IN ('running','claimed','retry_scheduled')` and the `retry_scheduled` branch (lines 632-669) re-queues or fails based on `retry_count vs max_retries`. The bba865d8 (2026-05-03) fix enforces the same `>` boundary as `shouldRetry`'s `<=` — a final retry whose timer was lost to a restart still gets its run instead of being marked failed. There is no in-memory state to reconcile because the timer handle dies with the process; the DB row is the only authority, and the reconciler reads it correctly.

**Test coverage** (`server/tests/startup-task-reconciler.test.js:865-1026`): 5 regression tests pin the behavior — re-queue with budget remaining, fail with budget exhausted, re-queue at boundary (count==max, the bba865d8 case), conservative re-queue with null retry fields, and skip when owner instance is still alive. Open question resolved with verified-safe status.

### 6. ✅ ~~Worktree reconciler 1-min "fresh dir" age check can race with slow vc_worktrees insert~~ RESOLVED 2026-05-07

`ORPHAN_DIR_MIN_AGE_MS` raised from 60s to 5min. Slow inserts (DB contention, fsync, antivirus stat) had a much wider window before the orphan sweep would reclaim. 5min is well past any observed insert delay while still reclaiming actually-orphaned dirs within a single factory tick window. Operators can tune via `TORQUE_ORPHAN_DIR_MIN_AGE_MS` (positive integer ms). The audit's "explicit ready_for_reconcile flag" alternative (schema change) was deferred — wall-clock grace is simpler and the new 5min default is conservative enough to make the race vanishingly rare in practice.

### 7. Stall-recovery attempt counter never resets on provider fallback — **VERIFIED SAFE 2026-05-07**

Investigated. The counter-persistence is intentional: `stallRecoveryAttempts[taskId]` measures **total stalls on this task across all providers**, not per-provider. A task that consistently stalls regardless of which provider executes it is genuinely problematic; capping at `stall_recovery_max_attempts` (default 3) across the union prevents resource burn.

Resetting on provider fallback would multiply effective attempts by N providers (3×3=9 stalls before exhaustion) — that's strictly worse for the operator's resource bill.

The audit's "misleading logs" concern is real but is an observability issue, not a correctness issue. Per-provider attempt breakdown can be reconstructed from existing log lines (`[StallRecovery] Task X: Attempt N — strategy Y`); no code change needed.

`fallback-retry.js:516` reads existing recovery state, increments, and stores back. Counter is deleted only on terminal paths (`stallRecoveryAttempts.delete(taskId)`) when recovery is exhausted or task transitions to terminal status. This is the correct contract.

### 8. ✅ ~~Abandon path leaves detached process unmonitored~~ RESOLVED 2026-05-06

Documented in the "Abandon mode contract" section above. Covers: what abandon does (DB row, subprocess left alive, tracking released, log files keep accumulating), what it does NOT do (no kill guarantee, no successor handoff, no worktree cleanup), the three-mode comparison table (default/force/abandon), explicit operator responsibility (`ps`/`tasklist` on the PID after the call), and the three wiring sites (`task-cancellation.js`, MCP tool handler, tool def description).

### 9. ✅ ~~Finalization-marker idle timeout vs factory hard-cap mismatch~~ RESOLVED 2026-05-07

`docs/factory.md` gains a new "Long-running task config: `finalizing_task_stale_minutes`" subsection documenting the relationship: 15-min default is sized for general-purpose tasks, not factory-scale work; raise to 30-60 min if factory plan-generation regularly takes >15 min; pair with `TORQUE_CLEANUP_GUARD_TTL_MS` so both values stay aligned (raising one in isolation reopens the gap #3 closed). Symptom-of-mistuning callout included.

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
