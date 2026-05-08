# Subprocess Detachment Reference

This document is the canonical reference for the subprocess-detachment arc — Phases A through H, plus the follow-on fixes that hardened the path. Same audit playbook as `docs/recovery-decisions.md`, `docs/factory-loop-states.md`, `docs/cancellation-cleanup.md`, `docs/routing-templates.md`, `docs/torque-remote.md`. The arc is actively evolving; this catalog compresses the "what does each phase do, what invariants matter, where does the next change land" question for future sessions.

For the original design rationale, see `docs/design/2026-05-03-subprocess-detachment-codex-spike.md` (543-line spike). This audit doc supersedes that spike for current-state reference; the spike is preserved as historical context.

---

## TL;DR

Before the arc: TORQUE restarts killed in-flight codex/claude-cli subprocesses because the parent held stdio pipes. After the arc: the same subprocesses survive a TORQUE restart with output captured to disk; the new TORQUE instance re-adopts them via PID liveness + log file tailing.

**The redesign in one sentence.** Spawn with `detached: true` and stdio routed to on-disk log files (not in-memory pipes); persist `subprocess_pid`, `output_log_path`, `error_log_path`, `output_log_offset`, `error_log_offset`, `last_activity_at` on the task row; on TORQUE startup, reconcile orphaned `running` rows by checking PID liveness and either re-adopting (re-attach a Tail watcher + PID-liveness loop) or cancelling (same as today's reconciler did before).

**Default state**: ON since Phase G (2026-05-04). Opt-out via `TORQUE_DETACHED_SUBPROCESSES=0`.

**Provider coverage**: codex, codex-spark, claude-cli (Phase F). Skipped on purpose: ollama (HTTP-based; no subprocess to detach), ollama-agentic (HTTP), claude-code-sdk (promise-coupled), deepinfra/hyperbolic/groq/cerebras/google-ai/openrouter/anthropic (all HTTP API providers — nothing to detach).

---

## The 8 phases (chronological catalog)

| # | Date | Commit | Title | What it added |
|---|---|---|---|---|
| **A** | pre-arc | various | PID liveness helper | `server/utils/pid-liveness.js` `isPidAlive(pid)` cross-platform wrapper around `process.kill(pid, 0)`. Building block; no caller wired. |
| **B** | 2026-05-03 | `c4a06f45` | Flag-gated detached spawn for codex/spark | `spawnAndTrackProcessDetached` in execute-cli.js. Stdio → `<data-dir>/task-logs/<taskId>/{stdout,stderr}.log`. `process-exit-wrapper.js` shim runs the real binary and emits `[process-exit] code=X signal=Y duration_ms=Z provider=W model=M` to stderr.log on exit. PID-liveness polling replaces `child.on('close')`. Schema cols added: `subprocess_pid`, `output_log_path`, `error_log_path`, `output_log_offset`, `error_log_offset`, `last_activity_at`. Flag-gated via `TORQUE_DETACHED_SUBPROCESSES=1` (off by default in B). |
| **C** | 2026-05-04 | `c66a883a` | Re-adopt detached subprocesses on startup | `tryReAdoptDetachedSubprocess` in `startup-task-reconciler.js`. Rows with valid persisted state AND live PID AND fresh log mtime get a fresh `runningProcesses` entry instead of being cancelled-and-cloned. PID-reuse mtime defense via `TORQUE_READOPT_LOG_STALE_MS` (default 5 min). New `re_adopted` action counter on the reconciler's return value. |
| **D** | 2026-05-04 | `a952f3c7` | drain_timeout_ms + cancel_task force/abandon | `restart_server { drain_timeout_ms: <ms> }` parameter (default 60s; 0 = immediate). `cancel_task { force: true }` (immediate SIGKILL/taskkill /F /T). `cancel_task { abandon: true }` (mark cancelled in DB, leave subprocess alive — escape hatch). `cancel_reason` records the mode. Cutover script `--graceful` flag (10-min drain). `BARRIER_TIMEOUT_MIN` env override. |
| **E** | 2026-05-04 | `d2618042` | Task-log retention | gzip-on-finalize (always; ~10× compression). `task_log_retention_days` DB config (default 30). Maintenance scheduler runs prune. `get_task_log_disk_usage` MCP tool surfaces total bytes + oldest log age. 13 new tests. |
| **F** | 2026-05-04 | `65187d09` | Extend dispatch to claude-cli | `shouldUseDetachedPath` helper extracted. Dispatch extended from `{codex, codex-spark}` to `{codex, codex-spark, claude-cli}`. Same prompt-via-stdin contract (claude-cli's `-p` print mode reads stdin like codex's `exec -`). ollama-agentic + claude-code-sdk skipped (different transport shape). |
| **G** | 2026-05-04 | `7526fd98` | Default flipped ON | `TORQUE_DETACHED_SUBPROCESSES` default-on. Opt-out via `=0` / `=false` / `=no` / `=off` (case-insensitive). Phases B-G become live. |
| **H** | 2026-05-04 | `01c2cfec` → `c763378c` | Wiring fix | **Discovery**: Phases B-G never ran in production. `task-manager.js:519` went straight to process-lifecycle's pipe path, bypassing `execute-cli`'s dispatcher entirely. H connects them: process-lifecycle now calls `executeCli.spawnAndTrackProcessDetached` when `isSubprocessDetachmentEnabled()` AND provider is detachable. Cancelled-task guard (`d02cf3f8`) prevents re-adopting tasks the operator just cancelled. mcp-sse path fix (`c763378c`) ensures startup re-adoption can reach the new code. |

After Phase H, the arc is "live in production" — every prior phase actually executes. Most subsequent commits are post-G/H hardening (see "Follow-on fixes" below).

---

## Follow-on fixes (post-Phase H)

These commits hardened the live detachment path. None added new phases; they fix bugs that surfaced once detachment was actually running in production.

| Date | Commit | Issue | Fix |
|---|---|---|---|
| 2026-05-05 | `944a0ec3` | DLPhone WI #783 cutover-killed an 8-min ollama agentic task | `worktree-cutover.sh` auto-extends drain to 30 min when running tasks include non-detachable providers. `CUTOVER_NONDETACH_MIN` env override (0 disables). |
| 2026-05-05 | `8651798b` | Codex `[process-exit]` banner regex (`\s*$` with `/m`) matched every blank line → every chunk misclassified as banner → `proc.lastOutputAt` frozen at spawn for every codex task | Replaced inline regex with `every()` pattern from process-streams.js. |
| 2026-05-05 | `ba4620d3` → `03a88393` | `getTaskProgress` returned "(no output yet)" when stdout was empty even though stderr had codex tool traces — misleading the operator | Counts stderr in progress for codex/codex-spark/claude-cli when stdout empty. New v2 progress endpoint contract: `output_length`, `error_output_length`, `last_output_at`, `status`, `elapsed_seconds`. MCP `get_progress` shows `### Latest Stderr` section. |
| 2026-05-05 | `d8462d0e` | v2 progress endpoint missing `error_output_bytes` (was MCP-only); cutover orphan retry budget too short | Endpoint symmetry; cutover cleanup uses exponential backoff (31s budget, was 3s) + post-prune retry. |
| 2026-05-06 | `1cdbbb59` | `getTaskProgress` reported "bytes since re-adoption" instead of disk total → visible "shrinking" on restart | `getTaskProgress` prefers `proc.outputLogOffset` / `errorLogOffset` over in-memory buffer length. New `max_task_lifetime_seconds` config (default 0 = disabled, max 86400 = 24h) for tool-call-loop defense. |
| 2026-05-06 | `3b39d45a` | `reAdoptDetachedSubprocess` was setting `proc.lastOutputAt = Date.now()` on restart → silent stall-detection gap, codex clones running 12+ hours undetected | `resolveReAdoptLastOutputAt` helper preserves persisted `last_activity_at`. |
| 2026-05-06 | `a8f05279` | Cutovers spammed `cancel_reason='server_restart'` rows by SIGTERMing detached subprocesses the reconciler should have re-adopted | `task-manager.shutdown` loop branches on `proc.detached` — abandons detached, graceful-kills pipe-path. Eliminates the wave of restart-cancellation rows. |
| 2026-05-06 | `1168c9f9` | Orphan-cleanup zombie sweep was cancelling rows that had been intentionally `server_restart`-cancelled | Skip `cancel_reason='server_restart'` rows. `estimateProgress` exported from task-manager. |
| 2026-05-06 | `82388112` | `stopTaskForRestart` defined in task-manager.js:725 but missing from `Object.assign(module.exports, {...})` → every periodic `checkStalledTasks → tryStallRecovery()` crashed with TypeError | One-line export fix. 3 regression tests assert fallback-retry's required exports. |
| 2026-05-06 | `b0ea85ab` → `18a605d2` | uncaughtException + unhandledRejection handlers logged to torque.log via debug (filtered out) AND failed to arm restart pending → 3 silent crashes per session, no auto-restart | Logger.error/warn (visible) AND `process._torqueRestartPending=true` so existing spawn-successor block fires. `TORQUE_NO_RESTART_ON_CRASH=1` escape hatch. |
| 2026-05-05 | `8595c424` | Successor stdio was lost (restart-helper's bash piped to /dev/null) | Capture to `~/.torque/successor.log`; shutdown signals to torque.log. |
| 2026-05-08 | _wrapper-leak-fix_ | The 1168c9f9 skip for `cancel_reason='server_restart'` rows had no upper bound. Re-adoption is an episodic startup event — once it has run, those rows are permanently terminal but the zombie sweep kept skipping them, leaking the wrapper PID forever. ~80 leaked wrappers observed in production. | `cleanupTerminalTaskSubprocesses` skip is now bounded by a re-adoption grace window (default 15 min, env-tunable via `TORQUE_SERVER_RESTART_REAP_GRACE_MS`); past the grace, the row is reaped like any other terminal row. `cancel_reason='abandon'` rows remain permanently exempt (operator-owned). |
| 2026-05-08 | _wrapper-leak-fix_ | Independently of the cleanup path: when `PROGRAM` was a `.cmd`/`.bat` shim and the underlying binary exited, `child.on('close')` sometimes never fired and the wrapper sat forever with a dead child — same Windows-zombie shape orphan-cleanup.js Check 1 documents for in-memory tracking. | `process-exit-wrapper.js` self-watchdog: every 30 s (env-tunable for tests via `TORQUE_PEW_WATCHDOG_INTERVAL_MS`) probes `process.kill(child.pid, 0)`; if the child is gone but no event fired, force-exits via the same `safeExit` path. Idempotency flag prevents the watchdog and `close` from racing. |

---

## Schema additions

The `tasks` table gained these columns to persist detached-subprocess state across restarts:

| Column | Type | Purpose |
|---|---|---|
| `subprocess_pid` | INTEGER | Detached subprocess PID. Reconciler probes via `process.kill(pid, 0)` for re-adoption decision. |
| `output_log_path` | TEXT | Absolute path to `<data-dir>/task-logs/<taskId>/stdout.log`. |
| `error_log_path` | TEXT | Absolute path to `<data-dir>/task-logs/<taskId>/stderr.log`. |
| `output_log_offset` | INTEGER | Byte offset into stdout.log up to which output has been processed. Re-adoption resumes tailing from here. |
| `error_log_offset` | INTEGER | Same for stderr.log. |
| `last_activity_at` | TEXT (ISO ts) | Last time any output was observed. Survives restart so re-adoption can preserve stall-detection clock (closes the 3b39d45a regression). |

When `subprocess_pid` is NULL, the row is from a non-detached spawn (ollama, anthropic, deepinfra, etc.) — reconciler skips re-adoption and falls through to today's cancel-and-clone path.

---

## End-to-end lifecycle (detached path, single task)

1. **Submit**: `submit_task` writes the row with `status='queued'`. No subprocess yet.
2. **Dispatch**: queue scheduler picks the task; `task-manager.js` calls `process-lifecycle.js spawnAndTrackProcess(taskId, task, spawnConfig)`.
3. **Detachment decision** (`process-lifecycle.js:585`): if `isSubprocessDetachmentEnabled()` AND `shouldUseDetachedPath(provider)`, delegate to `executeCli.spawnAndTrackProcessDetached`. Otherwise fall through to legacy pipe spawn.
4. **Detached spawn** (`execute-cli.js:1511 spawnAndTrackProcessDetached`):
   - Create `<data-dir>/task-logs/<taskId>/` if missing.
   - Open `stdout.log` and `stderr.log` for append.
   - Spawn `node process-exit-wrapper.js` with `TORQUE_PEW_PROGRAM`, `TORQUE_PEW_ARGS`, `TORQUE_PEW_PROVIDER`, `TORQUE_PEW_MODEL`, optional `TORQUE_PEW_STDIN_FILE` (codex prompt), with `detached: true`, `unref()`, stdio = `[stdin?, fd-of-stdout-log, fd-of-stderr-log]`.
   - Persist `subprocess_pid`, `output_log_path`, `error_log_path` on the row.
   - Start a `Tail` watcher on each log; chunk handler is the same one the pipe path uses (close handlers, completion detection, stall detection).
   - Start a PID-liveness loop (`isPidAlive` every N seconds) to detect exit.
5. **Run**: stdout/stderr accumulate in the log files; `Tail` watchers feed chunk handlers; `proc.lastOutputAt` updates on each chunk.
6. **Exit detection**: PID-liveness loop notices `kill -0` failure → reads remaining log content → finds the wrapper's `[process-exit] code=X signal=Y duration_ms=Z` annotation → emits a synthetic `close` event with that code → close handler runs the same finalize pipeline as the pipe path.
7. **Finalize**: gzip both logs (Phase E). Update DB status. Webhooks fire.

If TORQUE restarts mid-task (steps 5-6):
- The `[process-exit]` wrapper subprocess is detached + unref'd, so it survives the parent.
- Per-task log files keep accumulating (the wrapper's stdio = `inherit` writes directly to the FD).
- New TORQUE instance starts up.
- `startup-task-reconciler.reconcileOrphanedTasksOnStartup` queries `tasks WHERE status IN ('running','claimed','retry_scheduled')`.
- For each row with `subprocess_pid`: `tryReAdoptDetachedSubprocess` checks PID liveness + log mtime freshness.
  - **Alive + fresh logs**: re-attach Tail watchers + PID-liveness loop, restore `lastOutputAt` from persisted `last_activity_at`. Counter `actions.re_adopted++`.
  - **Dead PID OR stale logs (>5 min, `TORQUE_READOPT_LOG_STALE_MS`)**: fall through to today's cancel-and-clone path. Mtime-fresh check is the PID-reuse defense (a 12-hour-old PID matching some unrelated new process would have stale logs).

---

## Cancellation modes (Phase D contract)

`cancel_task` exposes three modes via flags. Documented in `docs/cancellation-cleanup.md` "Abandon mode contract" section; summarized here.

| Mode | Flag | Subprocess |
|---|---|---|
| **graceful** (default) | `{}` | SIGTERM → 5s wait → SIGKILL (or `taskkill /F /T` on Windows) |
| **force** | `{ force: true }` | Immediate SIGKILL — for stuck-in-tight-loop subprocesses where SIGTERM doesn't help |
| **abandon** | `{ abandon: true }` | No signal sent; subprocess left alive. DB row marked `cancelled`, tracking released. Operator owns subsequent monitoring (`ps`/`tasklist`). |

`force: true` + `abandon: true` resolves to `abandon` (higher-leverage instruction wins). `cancel_reason` lands in the row for forensics: `'graceful'` / `'force'` / `'abandon'` (or `'user'` / `'timeout'` / `'fallback_retry_exhausted'` etc. depending on caller).

---

## Restart / shutdown lifecycle

Three distinct shutdown paths interact with detachment:

| Path | What happens to detached subprocesses |
|---|---|
| **`restart_server` barrier (normal restart)** | Drain barrier waits `drain_timeout_ms` (default 60s; tunable per-call; `restart_server { drain_timeout_ms: 0 }` for immediate). When barrier completes, `task-manager.shutdown` loop runs: detached subprocesses get `abandon: true`, pipe-path subprocesses get graceful kill. Successor TORQUE re-adopts the abandoned ones via reconciler. (a8f05279 fix) |
| **`worktree-cutover.sh`** | Same as `restart_server` barrier, but with `CUTOVER_NONDETACH_MIN` auto-extension to 30 min when running tasks include non-detachable providers (944a0ec3). Pass `--graceful` to use the legacy 10-min drain. |
| **Crash / uncaughtException** | Detached subprocesses survive (they're detached). Logger.error captures the stack to torque.log. `process._torqueRestartPending=true` arms the spawn-successor block, which re-launches TORQUE. Reconciler picks up the survivors. `TORQUE_NO_RESTART_ON_CRASH=1` for diagnostic sessions. (b0ea85ab → 18a605d2) |

---

## Provider compatibility matrix

| Provider | Detached path? | Notes |
|---|---|---|
| **codex** | ✅ Phase B | Prompt via `TORQUE_PEW_STDIN_FILE` (codex `exec -` reads stdin) |
| **codex-spark** | ✅ Phase B | Same as codex |
| **claude-cli** | ✅ Phase F | claude-cli `-p` print mode reads stdin same way |
| **claude-ollama** | ❌ | Currently classed with claude-cli but the `ollama` half is HTTP — left on legacy path pending evaluation |
| **ollama** | ❌ | HTTP-only; no subprocess to detach |
| **ollama-agentic** | ❌ | HTTP + promise-coupled tool loop |
| **claude-code-sdk** | ❌ | promise-coupled (no `child_process.spawn` to detach) |
| **anthropic** | ❌ | Direct API |
| **deepinfra** / **hyperbolic** / **groq** / **cerebras** / **google-ai** / **openrouter** | ❌ | All HTTP API providers |

`shouldUseDetachedPath(provider)` (Phase F refactor) is the single source of truth. New providers default to non-detached; opt-in by adding to that helper.

---

## Operator-controllable env vars

| Var | Default | Purpose |
|---|---|---|
| `TORQUE_DETACHED_SUBPROCESSES` | enabled (Phase G) | `0` / `false` / `no` / `off` opts out. Anything else (incl. unset) → enabled. |
| `TORQUE_READOPT_LOG_STALE_MS` | `300000` (5 min) | Freshness window for re-adoption's PID-reuse defense |
| `TORQUE_NO_RESTART_ON_CRASH` | unset | Set to `1` to disable auto-restart on uncaughtException (diagnostic sessions only) |
| `BARRIER_TIMEOUT_MIN` | unset | Override drain barrier timeout (minutes) |
| `CUTOVER_NONDETACH_MIN` | `30` | Cutover drain auto-extension (minutes) when non-detachable providers are running. `0` disables auto-extension. |

DB config keys (via `set_project_defaults` or direct):

| Key | Default | Purpose |
|---|---|---|
| `task_log_retention_days` | `30` | Phase E prune scheduler retention |
| `max_task_lifetime_seconds` | `0` (disabled) | Hard cap on task runtime regardless of activity rescues; max `86400` (24h). Tool-call-loop defense. |
| `finalizing_task_stale_minutes` | `15` | See `docs/cancellation-cleanup.md` #9 + `docs/factory.md` |

---

## Exit codes / sentinels

| Code | Source | Meaning |
|---|---|---|
| `[process-exit] code=N signal=M duration_ms=K provider=P model=M` | `process-exit-wrapper.js` | Wrapper-emitted annotation in stderr.log; close handler reads to determine real exit |
| `2` | wrapper itself | Bad `TORQUE_PEW_PROGRAM` / `TORQUE_PEW_ARGS` env (configuration error) |
| `127` | wrapper | Spawn error (`child.on('error')`) — binary not found etc. |
| `128 + signo` | wrapper fallback | Child died from signal with no exit code |
| `-101`, `-102`, `-103` | execute-cli.js exit sentinels (`adf4ec65`, 2026-04-20) | Cancel reason classification: graceful, force, fallback-retry-exhausted |

---

## Cleanup integrations (where detachment touches other layers)

- **Orphan-cleanup zombie sweep** (`maintenance/orphan-cleanup.js`): skips `cancel_reason='server_restart'` rows so the reconciler's re-adoption window isn't fought by zombie-cleanup. (1168c9f9)
- **Cancellation `abandon` mode** (`task-cancellation.js:164-220`): only meaningful for detached subprocesses; for pipe-path children the parent owning stdio means "leave alive" is best-effort (child SIGPIPEs when parent closes streams). Documented in `docs/cancellation-cleanup.md` "Abandon mode contract".
- **Startup-task-reconciler retry_scheduled handling** (`startup-task-reconciler.js:632-669`): orthogonal to detachment but in the same reconciler path. Re-adoption check (lines 685-700) runs before retry-budget check (632-669) so an alive detached subprocess is preferred over re-queueing.
- **Factory-loop pause states**: detached subprocesses survive across `restart_server`, so factory loop instances don't lose progress when a cutover happens mid-stage. Factory's stage-occupancy reservations still serialize correctly because the reconciler's re-adoption restores `runningProcesses` before the factory tick runs.

---

## Open questions / risks

These surfaced during the audit. Each is bounded enough to address in a follow-up commit.

### 1. ✅ ~~Re-adoption test coverage is asymmetric~~ RESOLVED 2026-05-07

Audit was based on a partial read. `startup-task-reconciler.test.js` already had 7 reconciler-level tests for `tryReAdoptDetachedSubprocess` covering missing-state, missing-paths, PID-dead, stale-logs, happy-path, executeCli-throws, and the integration "re-adopts before cancel" path. Two combinatorial gaps closed in this commit:

1. **`PID dead + log mtime combinations`** — parameterized test covering both fresh-logs (recent death) and stale-logs (long-dead) with dead PID. Verifies the dead-PID short-circuit fires regardless of log freshness (no false-readopt window).
2. **Structured-log contract pin** — new test asserts each decision branch (`no_re_adopt_function`, `missing_detached_state`, `pid_dead`, `log_mtime_stale`, `adopted`) emits a log line with the documented `reason` field. Forces explicit acknowledgment when removing operator-visible re-adoption signal.

### 2. claude-ollama investigation — **VERIFIED SAFE 2026-05-07**

Audit was based on a misread of the provider. `claude-ollama` is its own provider (`server/providers/claude-ollama.js:34`) that spawns the `ollama` binary directly (line 246) with pipe stdio. There is no claude-cli subprocess to detach — claude-cli appears in the provider name as a brand reference (claude-style tool-loop on top of ollama), not as an actual CLI wrapper.

Because claude-ollama doesn't go through `execute-cli`'s `spawnAndTrackProcess` pipeline at all, `shouldUseDetachedPath` is never consulted for it. The provider has its own session loop, its own host-mutex coordination, and its own stdout/stderr pipe handlers. Detachment doesn't apply.

No code change. Mark verified.

### 3. `last_activity_at` is updated optimistically per-chunk — **VERIFIED SAFE 2026-05-07**

Audit was based on an incorrect read of the chunk handler. The actual code at `execute-cli.js:1722` (and the analog at line 2180) already throttles via `offsetPersistThrottleMs = 2000` — DB writes happen at most once every 2 seconds per stream. For a task with both stdout and stderr, that's max 60 writes/min/task. Already batched. No code change needed.

### 4. ✅ ~~Wrapper-detection in close-handler is regex-based~~ RESOLVED 2026-05-07

`server/utils/process-exit-format.js` is the single source of truth for the `[process-exit]` annotation contract — exports `PROCESS_EXIT_PREFIX`, `PROCESS_EXIT_LINE_REGEX`, `formatProcessExitLine` (writer), `parseProcessExitLine` (reader), and `findLastProcessExitAnnotation` (multi-line buffer scan). Both ends now use it: `process-exit-wrapper.js` calls `formatProcessExitLine` instead of building the line inline, and `parseProcessExitAnnotation` in `execute-cli.js` delegates to `findLastProcessExitAnnotation`. New regression test (`tests/process-exit-format.test.js`) round-trips 4 representative cases (0+null, 137+SIGKILL, null+SIGTERM, with/without model) — any future contributor who edits one side without the other will break the test.

### 5. `task-logs/<taskId>/` directory cleanup — **VERIFIED SAFE 2026-05-07**

Audit was incorrect. `pruneOldTaskLogs` (`server/utils/task-log-retention.js:154-200`) already handles empty-dir reaping at lines 178-183: when `dirSizeBytes` reports `entryCount === 0` or `newestMtimeMs === 0`, the dir is `rmSync`-ed without being counted as a delete. So the prune cycle reaps both contents-deleted dirs and dirs that were already empty for any reason. No code change needed.

### 6. ✅ ~~Re-adoption doesn't preserve `completionDetected` flag~~ RESOLVED 2026-05-07

Migration v57 adds `tasks.completion_detected_at` (TEXT). `process-streams.js armCompletionGraceIfDetected` persists the moment when it sets `proc.completionDetected = true`. `reAdoptDetachedSubprocess` restores both the flag (presence implies true) and the original timestamp via the new `resolveReAdoptCompletionDetectedAt` helper, mirroring the `resolveReAdoptLastOutputAt` pattern. The grace-window math after re-adoption uses the original detection moment instead of restarting the 30s/60s clock from scratch.

Column added to `ALLOWED_TASK_COLUMNS` (writes) and `LIST_TASKS_ALLOWED_COLUMNS` (reads — same silent-drop precedent as `cancel_reason`). 6 unit tests pin the parser (valid ISO, missing, null task, empty string, garbage, 5-min-old preservation).

### 7. Disk pressure → log truncation contract — **DOCUMENTED 2026-05-07**

When `<data-dir>` runs out of disk mid-task, log writes start failing. The wrapper's `stdio: 'inherit'` means the EIO/ENOSPC happens inside the child's libc `write()` — TORQUE's parent never sees it directly. Behavior depends on the child:

- **codex / codex-spark / claude-cli**: most CLIs treat write failure as fatal and exit non-zero. The wrapper's `child.on('close')` handler still emits the `[process-exit]` annotation (best-effort; if disk is truly full the wrapper's own write may also fail). The close-handler emulation reads what's there and finalizes the task as failed.
- **stdout/stderr stream divergence**: if stdout fills first but stderr has space (rare with shared volume), the task may report partial output with no error message — operator sees "task completed but result is empty."
- **`get_task_log_disk_usage` reports `total_bytes`**: operators monitoring the dashboard will see growth approaching disk capacity. No automatic admission gate yet.

**Operator mitigations** (until #7's full action lands):
- Periodically run `get_task_log_disk_usage` (MCP tool) to track total bytes vs. available disk.
- Set `task_log_retention_days` aggressively (e.g. `7` for high-throughput environments).
- Pre-allocate `<data-dir>` on a separate volume so disk pressure doesn't impact `torque.db`.
- If disk fills, manually delete old `task-logs/<taskId>/` dirs; the next prune cycle will normalize state.

**Deferred from this commit** (still worth doing): periodic disk-space check that pauses new task admission when free space is below `task_log_disk_min_mb` config. Implementation requires `fs.statfs` (Linux/macOS) or `wmic logicaldisk` / PowerShell on Windows; not bundled here because the operator workaround above suffices for current scale.

### 8. ✅ ~~PID-reuse defense relies on log-mtime freshness~~ RESOLVED 2026-05-07

`process-exit-wrapper.js` now writes a `[torque-spawn] taskId=<id> wrapper-pid=<pid> started_at_epoch=<sec>` line on init, before exec'ing the real CLI. The format helpers (`formatTorqueSpawnLine`, `parseTorqueSpawnLine`, `findFirstTorqueSpawnAnnotation`) live alongside `[process-exit]` in `server/utils/process-exit-format.js` so writer and reader can't drift.

`reAdoptDetachedSubprocess` now invokes `verifyTorqueSpawnMarker(stderrPath, taskId)` after the PID/path validation but before the heavy Tail/liveness setup. Decision matrix:

- `verified` — marker taskId matches → adopt
- `mismatch` — marker taskId differs from row → REJECT (recycled PID); reconciler falls through to cancel-and-clone
- `unknown` — marker present but taskId='unknown' (env var was empty when the wrapper spawned — pre-marker rollout subprocess) → adopt with WARN log
- `absent` — no marker line in scanned head → adopt (older subprocess from before the marker shipped; log-mtime defense remains)
- `unreadable` — fs read failed → adopt (downstream Tail watcher will surface the same I/O error)

Spawner (`spawnAndTrackProcessDetached`) passes `TORQUE_PEW_TASK_ID: taskId` in both env-build branches; wrapper strips the env var before exec'ing the real CLI so the inner process can't see it.

8 unit tests in `tests/execute-cli.test.js` cover the matrix (verified / mismatch / unknown / absent / unreadable / null path / leading banner before marker / 64KB head-window cutoff).

Performance note: only the first 64KB of stderr.log is scanned, so the check is O(1) on log size. A pathologically slow startup that buffered >64KB before the wrapper line is treated as `absent` and falls back to log-mtime defense — the more dangerous failure mode (false reject) cannot happen.

### 9. ✅ ~~process-exit-wrapper bash signal forwarding is incomplete~~ RESOLVED 2026-05-07

Wrapper now forwards `SIGTERM`, `SIGINT`, `SIGHUP`, `SIGQUIT`, `SIGBREAK` (Ctrl+Break on Windows). Each registration is wrapped in try/catch so Node throwing on unsupported-signal platforms (e.g. `SIGHUP` on older Windows) doesn't crash the wrapper. The actual `child.kill(sig)` is also try-wrapped (child may have already exited between signal arrival and forward). `SIGKILL` deliberately NOT forwarded — uncatchable, shouldn't be in the list.

### 10. ✅ ~~No dashboard surface for "is this task on the detached path?"~~ RESOLVED 2026-05-07

`TaskDetailDrawer.jsx` renders a `Subprocess` MetaItem just below `Host` when `task.subprocess_pid` is truthy:

> Subprocess: Detached (pid 54321) — survives restart

Pipe-path tasks (`subprocess_pid IS NULL`) don't render the row, keeping the meta grid uncluttered for the 90% case. The API surface needed no change — `getTask` already does `SELECT *` and `resolveV2Task` returns the row unfiltered, so `subprocess_pid` flows through to the React layer.

3 unit tests in `TaskDetailDrawer.test.jsx`:
1. Visible + correct text when `subprocess_pid: 54321`
2. Hidden when `subprocess_pid: null` (pipe-path task)
3. Hidden when column absent (pre-detachment task)

This closes the last subprocess-detachment audit question. **All 12 questions now resolved.**

### 11. ✅ ~~Re-adoption logging is sparse~~ RESOLVED 2026-05-07

`tryReAdoptDetachedSubprocess` now emits a single info-level log line per decision with `task_id` + `reason`:
- `no_re_adopt_function` — executeCli not wired
- `missing_detached_state` — row lacks subprocess_pid / log paths
- `pid_dead` — `kill -0` failed
- `log_mtime_stale` — PID-reuse defense fired (includes age + threshold)
- `adopted` — successful re-adoption (includes log age)
- `adopter_returned_false` — `executeCli.reAdoptDetachedSubprocess` declined
- `adopter_threw` (warn level) — exception during adopt

Operators can now reconstruct "what happened on the last restart" with one grep: `grep '\[re-adopt\]' torque.log`.

### 12. Phase H wiring fix exposed pre-existing test debt — **OUT OF SCOPE 2026-05-07**

Confirmed not a detachment issue. The ~280 failing tests at Phase H push time were tracked back to concurrent-session arcs (DI Phase 3/4/5 fallout, schema drift, refactored signatures) that pre-dated the subprocess-detachment work. The gate-cleanup arc is a separate priority and would benefit from its own audit doc + drainage; not bundled here. Closed as out-of-scope for the subprocess-detachment audit; future session can pick up "test-infra reliability" as a new audit candidate.

---

## When changing subprocess detachment

- **Schema additions**: any new `tasks` column for detached state must be readable by `tryReAdoptDetachedSubprocess` AND survive the gzip-on-finalize step (E). Persist BEFORE the spawn, not after, so a crash between spawn and DB write doesn't strand the subprocess.
- **Provider expansion**: route through `shouldUseDetachedPath(provider)`; don't sprinkle conditionals at call sites. Add a regression test for the new provider's prompt-via-stdin shape (codex-style, claude-cli-style, or new).
- **Drain timeout changes**: any change to the cutover script's drain logic must preserve `count_nondetachable_running` auto-extension. Otherwise non-detachable providers (ollama, etc.) get force-killed mid-task.
- **`process-exit-wrapper` emit format**: writer + reader regex must change in lock-step. Add a regression test that round-trips an exit event.
- **Re-adoption changes**: PID-liveness + mtime freshness + (eventually) startup marker — all three must check the same row, not hand off mid-decision.
- **Cancellation contract**: graceful / force / abandon mode semantics are documented in `docs/cancellation-cleanup.md` "Abandon mode contract"; don't drift them.

---
*Sibling references: `docs/recovery-decisions.md`, `docs/factory-loop-states.md`, `docs/cancellation-cleanup.md`, `docs/routing-templates.md`, `docs/torque-remote.md`. Original design spike: `docs/design/2026-05-03-subprocess-detachment-codex-spike.md`.*
