#!/usr/bin/env node
'use strict';

/**
 * process-exit-wrapper — small Node shim that runs another binary with
 * inherited stdio and writes a `[process-exit] code=X signal=Y duration_ms=Z
 * provider=W model=M` annotation to its own stderr after the child exits.
 *
 * Used by the subprocess-detachment arc (Phase B): when codex / codex-spark
 * is spawned detached, the TORQUE parent never sees `child.on('close')`,
 * so the post-task annotation we ship today (see execute-cli.js close
 * handler) would otherwise be lost. Wrapping the binary preserves the
 * annotation in the per-task stderr.log even after TORQUE restarts.
 *
 * Design notes:
 *   - Stdio is inherited end-to-end, so the wrapper adds zero buffering
 *     overhead. The annotation is the only line the wrapper writes itself.
 *   - The real program path and argv are passed via env vars
 *     (TORQUE_PEW_PROGRAM / TORQUE_PEW_ARGS) instead of positional argv
 *     so we never need to worry about argv splitting / quoting rules.
 *   - When TORQUE_PEW_STDIN_FILE is set, the wrapper opens a stdin pipe
 *     to the child and streams the file contents to it. This is how the
 *     detached path delivers the codex prompt (codex `exec -` reads its
 *     prompt from stdin). When unset, child stdin is left ignored.
 *   - Parent signals (SIGTERM/SIGINT) are forwarded so cancel_task and
 *     similar lifecycle operations still terminate the real binary.
 *   - Wrapper-only env vars are stripped before exec so they don't leak
 *     into codex's environment.
 */

const fs = require('fs');
const { spawn } = require('child_process');
const {
  formatProcessExitLine,
  formatTorqueSpawnLine,
} = require('./process-exit-format');

const PROGRAM = process.env.TORQUE_PEW_PROGRAM;
const ARGS_JSON = process.env.TORQUE_PEW_ARGS;
const PROVIDER = process.env.TORQUE_PEW_PROVIDER || 'unknown';
const MODEL = process.env.TORQUE_PEW_MODEL || '';
const STDIN_FILE = process.env.TORQUE_PEW_STDIN_FILE || '';
// PID-reuse defense (subprocess-detachment.md #8): spawner sets this to
// the task UUID; wrapper emits it in the [torque-spawn] startup marker.
// Re-adoption verifies the marker matches the row's id before adopting.
const TASK_ID = process.env.TORQUE_PEW_TASK_ID || '';

if (!PROGRAM || !ARGS_JSON) {
  process.stderr.write('[process-exit-wrapper] missing TORQUE_PEW_PROGRAM or TORQUE_PEW_ARGS\n');
  process.exit(2);
}

let args;
try {
  args = JSON.parse(ARGS_JSON);
  if (!Array.isArray(args)) throw new Error('TORQUE_PEW_ARGS must be a JSON array');
} catch (err) {
  process.stderr.write(`[process-exit-wrapper] failed to parse TORQUE_PEW_ARGS: ${err.message}\n`);
  process.exit(2);
}

const childEnv = { ...process.env };
delete childEnv.TORQUE_PEW_PROGRAM;
delete childEnv.TORQUE_PEW_ARGS;
delete childEnv.TORQUE_PEW_PROVIDER;
delete childEnv.TORQUE_PEW_MODEL;
delete childEnv.TORQUE_PEW_STDIN_FILE;
delete childEnv.TORQUE_PEW_TASK_ID;

// Emit the spawn marker BEFORE exec'ing the real binary so it lands at
// the front of stderr.log. Re-adoption reads it from offset 0 to verify
// the subprocess matches the persisted row's taskId. Empty TASK_ID
// (older spawners that don't pass the env var) emits taskId=unknown,
// which re-adoption treats as "pre-marker spawn — fall back to log
// mtime defense."
process.stderr.write(`${formatTorqueSpawnLine({
  taskId: TASK_ID || 'unknown',
  wrapperPid: process.pid,
  startedAtEpoch: Math.floor(Date.now() / 1000),
})}\n`);

const stdinMode = STDIN_FILE ? 'pipe' : 'ignore';
const start = Date.now();
const child = spawn(PROGRAM, args, {
  stdio: [stdinMode, 'inherit', 'inherit'],
  env: childEnv,
  windowsHide: true,
});

if (STDIN_FILE) {
  const stream = fs.createReadStream(STDIN_FILE);
  stream.on('error', (err) => {
    process.stderr.write(`[process-exit-wrapper] prompt-file read error: ${err.message}\n`);
    try { child.stdin.end(); } catch { /* ignore */ }
  });
  stream.pipe(child.stdin);
}

function emitAnnotation(code, signal) {
  const line = formatProcessExitLine({
    code,
    signal,
    durationMs: Date.now() - start,
    provider: PROVIDER,
    model: MODEL || undefined,
  });
  process.stderr.write(`\n${line}\n`);
}

// Idempotent exit. The 'close' / 'error' handlers and the watchdog can
// each fire — first one wins, the rest are no-ops. Without this flag
// the watchdog could re-emit an annotation racing with a successful close.
// `watchdogHandle` is `let` because safeExit may close over it before
// setInterval runs (handler events are deferred but TDZ on `const` would
// still bite if a handler ever became synchronous).
let exited = false;
let watchdogHandle = null;
function safeExit(code, signal) {
  if (exited) return;
  exited = true;
  if (watchdogHandle) {
    try { clearInterval(watchdogHandle); } catch { /* ignore */ }
    watchdogHandle = null;
  }
  emitAnnotation(code, signal);
  process.exit(typeof code === 'number' ? code : (signal ? 128 : 0));
}

child.on('error', (err) => {
  process.stderr.write(`[process-exit-wrapper] spawn error: ${err.message}\n`);
  safeExit(127, null);
});

child.on('close', (code, signal) => {
  safeExit(code, signal);
});

// Self-watchdog: defends against Windows zombie-wrapper edge cases where
// the real binary exits but `child.on('close')` never fires (typically
// when PROGRAM is a .cmd / .bat shim — the same failure mode the in-memory
// zombie sweep documents at orphan-cleanup.js Check 1). Without this
// fallback the wrapper would sit in the process table indefinitely with a
// dead child, accumulating across restarts until manual cleanup. Polls
// every 30 s by default; cheap (one process.kill(pid, 0) probe) and
// unref'd so it never extends the wrapper's lifetime past a normal close.
// TORQUE_PEW_WATCHDOG_INTERVAL_MS is a test-only override; clamped to >=10ms.
const WATCHDOG_INTERVAL_MS = (() => {
  const override = Number(process.env.TORQUE_PEW_WATCHDOG_INTERVAL_MS);
  return Number.isFinite(override) && override >= 10 ? override : 30_000;
})();
watchdogHandle = setInterval(() => {
  if (exited) return;
  if (!child.pid) return;
  try {
    process.kill(child.pid, 0);
  } catch (err) {
    process.stderr.write(`[process-exit-wrapper] watchdog: child PID ${child.pid} is gone (${err.code || err.message}) but 'close' did not fire; forcing exit.\n`);
    const fallbackCode = (typeof child.exitCode === 'number') ? child.exitCode : 1;
    const fallbackSignal = child.signalCode || null;
    safeExit(fallbackCode, fallbackSignal);
  }
}, WATCHDOG_INTERVAL_MS);
watchdogHandle.unref();

// Forward standard termination signals to the child so cancel_task,
// SIGHUP from terminal disconnect, and Windows-specific termination all
// reach the real binary. Only POSIX signals are forwarded; SIGKILL can't
// be caught and shouldn't be forwarded explicitly. SIGBREAK is Windows-
// specific (Ctrl+Break in cmd.exe / PowerShell). Each signal is registered
// in a try block because Node throws on platforms that don't support it
// (e.g. SIGHUP on Windows pre-0.10), and we'd rather skip than crash the
// wrapper. The actual `child.kill(sig)` is also wrapped in try because
// the child may have already exited between signal arrival and forward.
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGBREAK'];
for (const sig of FORWARDED_SIGNALS) {
  try {
    process.on(sig, () => {
      try { child.kill(sig); } catch { /* ignore */ }
    });
  } catch {
    // Platform doesn't support this signal — skip silently.
  }
}
