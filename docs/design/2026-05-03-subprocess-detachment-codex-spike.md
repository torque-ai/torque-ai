# Subprocess Detachment + Re-adoption — Codex Provider Spike

**Status:** Design draft for the codex (and codex-spark) provider only.
**Goal:** Make TORQUE restart no longer a lifecycle event for in-flight subprocesses. After the change, restarting TORQUE while a codex task is running should leave the codex process alive, its output captured to disk, and the new TORQUE instance able to re-adopt it without losing work.
**Scope of this doc:** End-to-end walk of one provider (codex) with every code site, schema change, edge case, and test path enumerated. Other providers (claude-cli, ollama, claude-code-sdk, agentic worker) follow the same pattern; deferred to follow-up docs.

## 1. Why the current design loses work

Today's pipeline (see `server/providers/execute-cli.js`):

1. `spawnAndTrackProcess(taskId, task, cmdSpec, 'codex')` calls `spawn(cliPath, finalArgs, options)` with default stdio. The child is a normal child of the TORQUE node process — same process group on POSIX, same job object on Windows.
2. `child.stdout.on('data')` and `child.stderr.on('data')` accumulate output into `runningProcesses.get(taskId).output` / `.errorOutput`. These maps live in node memory; nothing on disk except the streaming-chunk persistence in `db.addStreamChunk(streamId, text, 'stdout' | 'stderr')` which is for dashboard live-tail and isn't designed to be re-read for re-adoption.
3. Stall detection runs off `proc.lastOutputAt` (in-memory). Completion detection runs off `proc.completionDetected` flag on the same in-memory object.
4. The close handler at `child.on('close', ...)` is the only path that finalizes the task row — it computes `extractModifiedFiles`, runs the worktree merge, applies extracted codex diffs (`extractCodexDiffs(proc.errorOutput)`), updates DB status, etc.

When TORQUE shuts down for a restart:

- The drain barrier (`server/tools.js:635-695`) waits for `running=0` across two consecutive 10s polls before emitting `eventBus.emitShutdown`.
- `emitShutdown` triggers process exit, which closes node's pipes to children.
- On POSIX with default `spawn` options, the child stays alive (it inherited stdio FDs but not the parent's process group membership) — but the in-memory `runningProcesses` entry vanishes, and stdout/stderr are now writing to a closed pipe (the child gets EPIPE/SIGPIPE on next write).
- On Windows, the child's stdio FDs are connected back to TORQUE's process; when TORQUE exits, the child often dies too, depending on how the CLI was launched (codex.exe wraps the actual binary).

Either way, the task row stays `running` with the dead instance's `mcp_instance_id`. On startup, `server/execution/startup-task-reconciler.js:399-410` finds these orphans and marks them `cancelled` (with `cancel_reason='server_restart'`), occasionally cloning eligible ones for retry. The comment is honest:

> "Restart-killed tasks land here regardless of whether the drain actually held them — the subprocess died with the parent process."

The 10 cancellations on 2026-05-03 traced exactly to this path.

## 2. The redesign in one paragraph

Spawn codex with `detached: true` and stdio routed to **on-disk log files**, not in-memory pipes. Persist `subprocess_pid`, `output_log_path`, `error_log_path`, `output_log_offset`, `error_log_offset`, and `last_activity_at` on the task row. Output handlers become file-tailers (read from offset, advance offset) instead of pipe consumers. On TORQUE startup, read `tasks WHERE status IN ('running','claimed')`, liveness-check each PID, and either re-adopt (re-attach a tailer, restore stall-detection state) or reconcile (mark cancelled — same as today). Restart no longer kills work; the only lost time is the seconds between TORQUE exiting and the new TORQUE re-adopting the tailer.

## 3. Today's codex execution pipeline (file-by-file)

Mapped from `server/providers/execute-cli.js` plus its callers:

### 3.1 Spawn site — `spawnAndTrackProcess` (line 325)

```js
const child = spawn(cliPath, finalArgs, options);
// options.cwd, options.env, options.stdio default to ['pipe','pipe','pipe']
// no detached flag, no windowsHide (already set elsewhere), no detached process group
```

`runningProcesses.set(taskId, { process: child, output: '', errorOutput: '', startTime, lastOutputAt, ..., baselineCommit, workingDirectory, worktreeInfo })`.

The map is purely in-memory. Nothing about this entry is recoverable from the DB or disk after a restart.

### 3.2 Stdout handler — line 553-651

Pipeline per chunk:
1. Append to `proc.output` (capped at 10 MB, trailing-half on overflow)
2. Estimate progress, update `proc.lastOutputAt`
3. Run `_helpers.estimateProgress(proc.output, proc.provider)` and persist via `taskCore.updateTaskProgress`
4. Run `_helpers.detectOutputCompletion(proc.output, proc.provider)` — sets `proc.completionDetected` and starts a grace timer that force-kills the child if it doesn't exit cleanly
5. Buffer to `db.addStreamChunk(streamId, text, 'stdout')` for dashboard live-tail, with stream-error counting
6. `dashboard.notifyTaskOutput(taskId, { content: text, type: 'stdout' })` for SSE push to dashboard

### 3.3 Stderr handler — line 658-773

Same shape as stdout, plus codex-specific completion detection (codex writes its task summary to **stderr** — `[Completion] Task ${taskId} stderr indicates work complete`). Banner-filtering is applied before bumping `proc.lastOutputAt` so the prompt-echo doesn't reset stall timers.

### 3.4 Exit/close handler — line 749-1000

`child.on('exit')` capture signal (SIGKILL/SIGTERM/etc.) for diagnostics. `child.on('close')` is the finalizer:

1. Read `proc.errorOutput` for completion / signal annotations (the `[process-exit] code=X signal=Y duration_ms=Z` line shipped 2026-05-03)
2. Worktree merge if `worktreeInfo` is set:
   - `gitWorktree.mergeWorktreeChanges` on success
   - `extractCodexDiffs(proc.errorOutput)` if filesChanged === 0 (codex sandbox sometimes reverts disk writes — extract from stderr instead)
   - `git apply` each extracted diff with 3-way fallback
   - `git add -A && git commit -m '...'`
3. Auto-commit non-worktree changes via `extractModifiedFiles`
4. Decrement host slot count if `proc.ollamaHostId` was set
5. `runningProcesses.delete(taskId)`, `stallRecoveryAttempts.delete(taskId)`
6. `finalizeTask(taskId, { exitCode, output, errorOutput, procState, filesModified })` — persists the final task row (status, output, error_output, files_modified, summary)

### 3.5 Stall detection — `server/utils/process-activity.js` + `activity-monitoring.js`

Reads `proc.lastOutputAt` from the in-memory map. If the gap exceeds the configured per-provider threshold (120-180s for codex), marks the task stalled and (depending on config) cancels + auto-resubmits with provider fallback.

### 3.6 Stream consumers — `db.addStreamChunk`, `dashboard.notifyTaskOutput`

`addStreamChunk` writes to a `task_stream_chunks` table indexed by `(task_id, sequence)` for dashboard live-tail. The dashboard subscribes via SSE and replays chunks in order.

## 4. The proposed pipeline

### 4.1 Spawn — `spawnAndTrackProcessV2`

```js
const fs = require('fs');
const path = require('path');

// Resolve a per-task log directory: <data-dir>/task-logs/<taskId>/
const logDir = path.join(getDataDir(), 'task-logs', taskId);
fs.mkdirSync(logDir, { recursive: true });
const stdoutPath = path.join(logDir, 'stdout.log');
const stderrPath = path.join(logDir, 'stderr.log');

const stdoutFd = fs.openSync(stdoutPath, 'a');
const stderrFd = fs.openSync(stderrPath, 'a');

const child = spawn(cliPath, finalArgs, {
  cwd: options.cwd,
  env: options.env,
  windowsHide: true,
  detached: true,                      // POSIX: setsid; Windows: DETACHED_PROCESS
  stdio: ['ignore', stdoutFd, stderrFd], // child writes to files, not pipes
});

fs.closeSync(stdoutFd);
fs.closeSync(stderrFd);

// On POSIX, unref so the parent can exit independently:
child.unref();

// Persist the recovery anchors immediately, BEFORE any output arrives:
taskCore.updateTaskRow(taskId, {
  subprocess_pid: child.pid,
  output_log_path: stdoutPath,
  error_log_path: stderrPath,
  output_log_offset: 0,
  error_log_offset: 0,
  server_epoch: getCurrentEpoch(),
  last_activity_at: new Date().toISOString(),
});
```

The child writes directly to the log files via the OS — no node pipe involvement. When TORQUE exits, the child keeps writing.

### 4.2 Output capture — file tailers

Replace `child.stdout.on('data', ...)` with a per-task tailer:

```js
const { Tail } = require('./utils/file-tail'); // new — see 4.6

const stdoutTail = new Tail(stdoutPath, {
  startOffset: proc.output_log_offset,
  pollIntervalMs: 250, // matches typical pipe latency
});

stdoutTail.on('chunk', (text, newOffset) => {
  // SAME logic as today's stdout handler from this point on:
  proc.output += text;
  proc.lastOutputAt = Date.now();
  // ...progress estimation, completion detection, stream-chunk persistence...
  proc.output_log_offset = newOffset;

  // Persist offset every K chunks or every M ms so re-adoption knows
  // where to resume. Throttled to avoid hot-loop UPDATE storms.
  maybePersistOffset(taskId, 'output', newOffset);
});

stdoutTail.start();
```

Stderr tailer is symmetric. `Tail` itself is the new utility — see 4.6.

### 4.3 Stall detection — unchanged shape, different source

`proc.lastOutputAt` still drives the stall timer. The only difference is that "no output" now means the file's mtime/size hasn't advanced — the tailer detects that and emits no chunks, so `lastOutputAt` doesn't bump. Stall behavior is identical from the watcher's perspective.

The new wrinkle: `last_activity_at` should also be persisted to the DB column at low frequency (every 30s, say) so re-adoption restores a recent floor for stall detection rather than starting from "now" and missing a real stall that was about to fire.

### 4.4 Exit detection — PID liveness watcher, not pipe-close

`child.on('close')` no longer fires usefully because the parent no longer holds a pipe to the child. Replace with a polled liveness check:

```js
const livenessTimer = setInterval(() => {
  if (!isPidAlive(child.pid)) {
    clearInterval(livenessTimer);
    onSubprocessExit(taskId);
  }
}, 1000);
```

`isPidAlive(pid)` is the cross-platform helper:

```js
function isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    // POSIX + Windows both honor signal 0 in node — sends nothing,
    // throws ESRCH if the PID doesn't exist, EPERM if it does but
    // we lack rights (counts as alive — wrong PID space wouldn't
    // give EPERM).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    if (err.code === 'ESRCH') return false;
    return false;
  }
}
```

PID reuse: theoretically an exited PID could be reassigned to an unrelated process between liveness polls. Real risk is low (PIDs cycle slowly under normal load) but to be safe, also check that the on-disk log files' mtime is advancing — if the PID is "alive" but the log file hasn't grown in 5+ minutes, treat as exited and run `onSubprocessExit`. This is the same signal stall detection uses; reuse it.

### 4.5 Finalizer — `onSubprocessExit(taskId)`

Same logic as today's close handler, refactored to read the final state from the log files instead of the in-memory map:

1. Determine exit code: read the last `[process-exit]` annotation from stderr if present; otherwise mark exit code as `null` and signal as `'detached_exit'`. (Codex CLI doesn't emit `[process-exit]` itself; that's our annotation. We'd need a small wrapper script or a final mtime check to infer clean-vs-killed exit.)
2. Worktree merge: read full `proc.errorOutput` from disk (the log file, not the in-memory map — they're now identical content but the disk version survived restart)
3. `extractCodexDiffs(diskErrorOutput)` → `git apply` (no change)
4. `extractModifiedFiles((diskOutput || '') + (diskErrorOutput || ''))` (no change)
5. `finalizeTask(taskId, {...})` (no change)
6. `runningProcesses.delete(taskId)`, stop the tailers, close the file handles
7. **Optional log archival**: move the per-task `task-logs/<taskId>/` directory into a compressed archive after finalization. Today's run-dir manager already does something similar for codex artifacts; extend it.

### 4.6 New utility — `server/utils/file-tail.js`

A simple poller — fs.watch is unreliable on Windows / network drives, so just stat + read:

```js
class Tail extends EventEmitter {
  constructor(filePath, { startOffset = 0, pollIntervalMs = 250 } = {}) {
    super();
    this.filePath = filePath;
    this.offset = startOffset;
    this.pollIntervalMs = pollIntervalMs;
    this._fd = null;
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    if (this._fd != null) {
      try { fs.closeSync(this._fd); } catch (_) { /* ignore */ }
      this._fd = null;
    }
  }

  _poll() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.offset) return; // no new data

      if (this._fd == null) {
        this._fd = fs.openSync(this.filePath, 'r');
      }

      const bufSize = Math.min(stat.size - this.offset, 64 * 1024);
      const buf = Buffer.alloc(bufSize);
      const bytesRead = fs.readSync(this._fd, buf, 0, bufSize, this.offset);
      if (bytesRead > 0) {
        const text = buf.slice(0, bytesRead).toString('utf8');
        this.offset += bytesRead;
        this.emit('chunk', text, this.offset);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.emit('error', err);
        this.stop();
      } else {
        this.emit('error', err);
      }
    }
  }
}
```

Polled, not event-driven, because `fs.watch` semantics differ across platforms and because we want a deterministic cadence for stall-detection alignment. 250ms × 64KB chunks handles ~256KB/s of subprocess output before lagging, well above codex's normal rate (~5KB/s).

### 4.7 Re-adoption at startup — `reAdoptRunningTasks`

Replaces the existing `startup-task-reconciler.js` cancel-everything path:

```js
async function reAdoptRunningTasks() {
  const candidates = db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('running','claimed')
      AND subprocess_pid IS NOT NULL
      AND output_log_path IS NOT NULL
  `).all();

  for (const task of candidates) {
    if (!isPidAlive(task.subprocess_pid)) {
      // Subprocess actually died — fall through to the existing
      // reconciler path (mark cancelled or clone for retry).
      continue;
    }

    // Re-adopt: rebuild runningProcesses entry, attach tailers
    // pointing at the saved offset.
    const proc = {
      process: null,                             // we didn't spawn it; treat as PID-only
      pid: task.subprocess_pid,
      output: '',                                // tailers will repopulate the trailing window
      errorOutput: '',
      startTime: new Date(task.started_at).getTime(),
      lastOutputAt: new Date(task.last_activity_at || task.started_at).getTime(),
      provider: task.provider,
      model: task.model,
      // ...everything else needed by stall detection / completion detection...
      output_log_path: task.output_log_path,
      error_log_path: task.error_log_path,
      output_log_offset: task.output_log_offset,
      error_log_offset: task.error_log_offset,
      reAdopted: true,
    };
    runningProcesses.set(task.id, proc);

    attachTailers(task.id, proc);
    startLivenessWatcher(task.id, task.subprocess_pid);

    logger.info(`[ReAdopt] task=${task.id} pid=${task.subprocess_pid} resuming from offsets ${task.output_log_offset}/${task.error_log_offset}`);
  }
}
```

The reconciler still runs after re-adoption for the candidates whose PIDs are dead (subprocess actually exited during the parent's downtime, or PID was reused and the new PID isn't ours). That path is unchanged.

## 5. Schema changes

```sql
-- Migration N: add subprocess re-adoption anchors
ALTER TABLE tasks ADD COLUMN subprocess_pid INTEGER;
ALTER TABLE tasks ADD COLUMN output_log_path TEXT;
ALTER TABLE tasks ADD COLUMN error_log_path TEXT;
ALTER TABLE tasks ADD COLUMN output_log_offset INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN error_log_offset INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_activity_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_subprocess_pid
  ON tasks(subprocess_pid)
  WHERE subprocess_pid IS NOT NULL;
```

`output_log_offset` / `error_log_offset` are persisted on every Nth tailer chunk (or every M ms — throttled). Worst case after a restart: the new instance re-tails from a slightly stale offset and emits a few duplicated chunks to the dashboard live-tail. Acceptable; the SSE consumer is idempotent on chunk content.

`last_activity_at` is the persisted floor for stall detection. Updated alongside the offsets at the same throttled cadence.

`server_epoch` (already exists) becomes vestigial for subprocess identification — PID is now the source of truth. It can stay for the meta question "did the controlling instance die" but the orphan-cancel path that uses it can be removed.

## 6. Edge cases and unknowns

### 6.1 PID reuse

POSIX PID space is small (32k on Linux by default). On a busy system with a torque process spawning 50 tasks/hr, PID reuse is plausible across a multi-hour restart. Defense: combine PID liveness with log-file-mtime advancement. If `kill(pid, 0)` says alive but the log file hasn't grown in 60s + the task hasn't been completion-detected, treat as dead.

Windows PIDs are 32-bit and recycle slowly — less of a concern, but the same defense applies.

### 6.2 `[process-exit]` annotation depends on the close handler

The current `[process-exit] code=X signal=Y duration_ms=Z provider=W model=M` annotation is added in the close handler (`execute-cli.js:944`). With detached subprocesses, the parent doesn't see the close. Options:

- **Wrap the codex command in a shell that appends the annotation on exit** — e.g. `bash -c 'codex "$@"; echo "[process-exit] code=$? ..." >&2' --`. Adds shell complexity but keeps the annotation.
- **Have the liveness watcher write the annotation when it detects the PID has exited** — but it doesn't know the exit code; just `code=null signal=detected_dead`. Less informative but no shell wrapping needed.
- **Polling `getrusage`/`waitpid` for orphaned PIDs** — POSIX-only; messy.

Recommendation: shell wrap. The wrapper script is ~5 lines, runs once per task, costs nothing, and preserves the annotation we ship today.

### 6.3 Worktree merge timing

Today's worktree merge runs in the close handler, which means it runs AFTER the codex subprocess has fully written to disk. With detached subprocesses, there's a window where the liveness watcher detects exit but the kernel hasn't flushed the codex process's last stderr/stdout writes to the log file yet. Defense: on detected-exit, sleep 500ms before reading final disk state. Codex writes are line-buffered so this is enough in practice; tests should validate.

### 6.4 Stream chunks — duplicates on re-adoption

`db.addStreamChunk` is idempotent on `(task_id, sequence)`. Re-adopting and replaying the last few seconds of output would generate duplicate chunks unless we persist the highest sequence number alongside the file offset. Add `last_stream_sequence` to the task row, or compute `MAX(sequence) FROM task_stream_chunks WHERE task_id=?` at re-adoption time. The latter is simpler and the chunk table is small per task.

### 6.5 Disk space

Per-task logs grow unbounded today (the in-memory cap doesn't apply to disk). A typical codex task writes 50KB-2MB of stderr; a runaway one could write GB. Mitigations:

- After finalization, gzip the per-task log dir into the existing run-dir archive (already exists for codex artifacts).
- Stream-truncate the `task_stream_chunks` table for completed tasks via the existing maintenance scheduler (already exists).
- Set a per-task hard cap (e.g. 100 MB) and have the tailer truncate from the head when exceeded. Logs longer than 100 MB are unreadable anyway.

### 6.6 Cross-restart `runningProcesses` reconstruction

The in-memory `runningProcesses.get(taskId).process` field is the child handle — methods like `child.kill('SIGTERM')` are called from cancellation paths. Re-adopted entries have `process: null`; a substitute is needed:

```js
proc.kill = function (signal) {
  try { process.kill(this.pid, signal); }
  catch (err) { /* no-op */ }
};
```

Add a `proc.killSubprocess(signal)` method everywhere today's code calls `proc.process.kill(signal)`. Audit `cancelTask` and `taskkill` paths in execute-cli.js.

### 6.7 `provider_switched_at` and stall-on-restart

Today's stall detection compares `Date.now() - proc.lastOutputAt` against the configured threshold. After re-adoption, `proc.lastOutputAt` is restored from `task.last_activity_at`; if the task was stalled before restart, the stall watcher will fire immediately. This is correct behavior — the task WAS stalled. But the persistence cadence (30s) means we may miss a stall by up to 30s. Fine for the 120-180s thresholds.

### 6.8 Codex CLI specifics

Codex echoes the prompt to stderr, so log files start with kilobytes of prompt + study-intelligence text. The existing `isCodexStartupBannerOnlyOutput` heuristic (used by `isCodexBannerOnly` in the error summarizer) already handles this. No changes.

Codex sometimes invokes its own subprocesses (e.g. `git status` exec calls). These show up in stderr as `exec ... succeeded in Xms:` blocks. Handled today by the existing parser; no changes.

## 7. Test strategy

### 7.1 Unit tests

- `file-tail.js`: read from offset, advance offset, handle file rotation/truncation, handle ENOENT during creation race.
- `isPidAlive`: alive PID, dead PID, EPERM PID (root-owned), invalid input.
- `re-adoption logic`: given a task row + a synthetic log file, re-attach tailer at offset, emit deferred chunks, verify in-memory state mirrors expected.

### 7.2 Integration tests

- Spawn a `node -e 'process.stdout.write("hello"); setTimeout(...)'` test process detached with stdio→files. Verify TORQUE process can exit; the test process stays alive; a fresh TORQUE invocation re-adopts and reads the remaining output.
- Restart simulation: spawn the test process, kill the parent's TORQUE process group (not the child), start a new TORQUE, verify re-adoption.
- Stall detection across restart: test process pauses output, original TORQUE exits, new TORQUE re-adopts, stall fires within threshold + 30s.

### 7.3 End-to-end manual test

A scratch codex task that runs 5 min on a small file. Trigger a TORQUE restart at the 1-min mark. Verify: codex keeps running (visible via `Get-Process codex` on Windows / `pgrep codex` on POSIX), the task row's `subprocess_pid` survives, the new TORQUE picks up the tailer, the close handler eventually runs the worktree merge against the codex output, the task ends in `completed` state with full stdout/stderr captured.

## 8. Migration plan

Behind a feature flag — `TORQUE_DETACHED_SUBPROCESSES=1` (env var, opt-in). Default off for one release.

1. **Phase A — schema + utilities** (1 day). Migration adds the new columns + index. Add `file-tail.js`, `is-pid-alive.js` utilities. No behavior change. No flag required.
2. **Phase B — codex spawn under flag** (3 days). When flag is set, codex spawns detached with file-redirected stdio and uses tailer-based handlers. When flag is off, behavior is unchanged. New `runningProcesses` entries carry `output_log_path` / `pid` for re-adoption.
3. **Phase C — re-adoption** (2 days). Add `reAdoptRunningTasks` to startup. Only applies to flagged tasks. Existing reconciler still runs for non-flagged.
4. **Phase D — soak + extend to other providers** (1 week). Run with the flag on for codex only. Once verified across 3+ restarts with no orphan-cancel rows, replicate the pattern for claude-cli, ollama-agentic, claude-code-sdk.
5. **Phase E — flip the default** (0.5 day). Flag default flips to on. The legacy pipe-based path is kept as `TORQUE_LEGACY_PIPE_SUBPROCESSES=1` for a release.
6. **Phase F — delete legacy** (0.5 day). Remove the pipe-based code path. Update `startup-task-reconciler.js` to expect re-adoption to handle most cases; only PID-dead orphans go through the cancel path.

Total: ~8 working days for codex; ~4 more for the other three providers in Phase D.

## 9. Risks

- **Buffer flushing on subprocess exit**: kernel may take 100ms-1s to flush the last writes after the child exits. The 500ms post-exit sleep in §6.3 mitigates but isn't airtight. Need to validate with real codex runs.
- **PID reuse on long restarts**: if TORQUE is down for >24h, PID space could cycle. Cross-check with log-file mtime is the safety net.
- **Tailer CPU at scale**: 250ms poll × 50 concurrent tasks = 200 polls/sec. Each poll is one stat() + maybe one read(). Probably fine; benchmark before merging.
- **Windows process detachment quirks**: `detached: true` on Windows uses `DETACHED_PROCESS` flag, which suppresses console attachment. Some CLI tools (claude-cli historically) misbehave without a console. Validate codex behaves correctly; may need `windowsHide: true` + explicit console handle inheritance.
- **The `[process-exit]` annotation depends on a shell wrapper** if we want exit-code preservation. Adds a small fragility surface.

## 10. Recommendation

This is the right architecture, and the codex spike justifies the full 8-day investment. The win is concrete: today's 4 long-running cancellations and 6 epoch-orphan cancellations both go to zero, restart latency drops from "drain timeout minutes" to "handoff seconds," and operators stop losing 30-60min codex work to control-plane cutovers.

I'd schedule it as a six-phase arc with daily-cutover discipline (each phase ships and goes live before the next starts). Phase A is genuinely zero-risk — it's a schema addition + utility files with no behavior change — and would land in the next session.

Phases B–F are an architectural change to the most performance-sensitive code path and warrant a dedicated session each, with the shipped changes soaked in production for a day before the next phase lands.

## Appendix A — file change inventory (codex only)

| File | Change |
|---|---|
| `server/db/migrations.js` | New migration: add `subprocess_pid`, `output_log_path`, `error_log_path`, `output_log_offset`, `error_log_offset`, `last_activity_at` columns + PID index |
| `server/db/schema-tables.js` | Mirror columns for fresh DBs |
| `server/utils/file-tail.js` | NEW — poller-based file tailer (§4.6) |
| `server/utils/pid-liveness.js` | NEW — `isPidAlive` cross-platform helper (§4.4) |
| `server/utils/data-dir.js` | Add `getTaskLogDir(taskId)` helper |
| `server/providers/execute-cli.js` | `spawnAndTrackProcess` gains a flag-gated detached path that uses files + tailers |
| `server/providers/execute-cli.js` | `child.on('close')` replaced with liveness-watcher + delayed exit handler in detached mode |
| `server/providers/execute-cli.js` | Add a small shell wrapper around the codex command to emit `[process-exit] code=$?` to stderr (§6.2) |
| `server/utils/process-activity.js` | Persist `last_activity_at` to DB at throttled cadence |
| `server/utils/activity-monitoring.js` | Restore `proc.lastOutputAt` from `task.last_activity_at` on re-adoption |
| `server/execution/startup-task-reconciler.js` | Add `reAdoptRunningTasks()` step before the existing reconciliation loop |
| `server/index.js` | Wire `reAdoptRunningTasks()` into startup, BEFORE the reconciler |
| `server/handlers/task/core.js` | `cancelTask` uses `proc.killSubprocess(signal)` (works for both pipe-children and detached PIDs) |
| `server/maintenance/orphan-cleanup.js` | Audit — any remaining `mcp_instance_id`-based cleanup paths should defer to PID liveness |
| `server/handlers/workflow/await.js` | The epoch-orphan-cancel path (`Task orphaned — server epoch ...`) becomes a no-op for tasks with valid `subprocess_pid` |
| `server/tools.js` | Drain barrier becomes optional for correctness; can be shortened to "wait for handoff staging then shutdown immediately" |
| `server/tests/...` | New tests per §7 |

## Appendix B — open questions for the user

1. **Disk location for task logs.** `~/.torque/task-logs/<taskId>/` (consistent with run-dirs) vs. `<server-data-dir>/task-logs/<taskId>/`. Same place as today's run artifacts? Different? Operator preference matters because backups and disk-quota rules differ.

2. **Log retention policy.** Today's `task_stream_chunks` table is pruned by the maintenance scheduler. Per-task log files should be archived on completion and deleted after N days. What's N? 30? 7?

3. **Should the drain barrier still wait?** With re-adoption, drain becomes a UX preference (let awaiters see results before the new instance loads) rather than a correctness requirement. Default could become "shorter drain timeout, e.g. 30s, then restart anyway because re-adoption catches the survivors." Or keep the current minutes-long drain for graceful behavior. Either is fine; depends on how aggressive you want restarts to be.

4. **Force-kill escape hatch.** Today an operator can `cancel_task` to kill stuck work. With detached subprocesses, the parent has less control over the child — the cancel path becomes "send SIGTERM via PID, wait, send SIGKILL." Need an explicit operator-visible "force kill" verb separate from "graceful cancel" so stuck tasks (like today's `c8ba9257` Git recovery loop) can still be cleared without restart. Confirms the existing `cancel_task` tool is sufficient or warrants a `force_kill_task`.
