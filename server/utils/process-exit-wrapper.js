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

const PROGRAM = process.env.TORQUE_PEW_PROGRAM;
const ARGS_JSON = process.env.TORQUE_PEW_ARGS;
const PROVIDER = process.env.TORQUE_PEW_PROVIDER || 'unknown';
const MODEL = process.env.TORQUE_PEW_MODEL || '';
const STDIN_FILE = process.env.TORQUE_PEW_STDIN_FILE || '';

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
  const durationMs = Date.now() - start;
  const parts = [
    `code=${typeof code === 'number' ? code : 'null'}`,
    `signal=${signal || 'none'}`,
    `duration_ms=${durationMs}`,
    `provider=${PROVIDER}`,
  ];
  if (MODEL) parts.push(`model=${MODEL}`);
  process.stderr.write(`\n[process-exit] ${parts.join(' ')}\n`);
}

child.on('error', (err) => {
  process.stderr.write(`[process-exit-wrapper] spawn error: ${err.message}\n`);
  emitAnnotation(127, null);
  process.exit(127);
});

child.on('close', (code, signal) => {
  emitAnnotation(code, signal);
  process.exit(typeof code === 'number' ? code : (signal ? 128 : 0));
});

['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* ignore */ }
  });
});
