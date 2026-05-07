'use strict';

// Single source of truth for the [process-exit] annotation contract used
// by the subprocess-detachment arc. The writer
// (server/utils/process-exit-wrapper.js) emits one line per subprocess
// exit; the reader (server/providers/execute-cli.js's close-handler
// emulation) parses the LAST such line from a stderr buffer.
//
// Pinning both sides to the helpers in this module ensures format drift
// cannot land asymmetrically — writer changes shape, reader stays on the
// old regex, exits silently misclassified.
//
// Format: `[process-exit] code=<int|null> signal=<name|none> duration_ms=<int> provider=<slug>[ model=<name>]`

const PROCESS_EXIT_PREFIX = '[process-exit]';
const PROCESS_EXIT_LINE_REGEX = /^\[process-exit\] (.+)$/;

function formatProcessExitLine({ code, signal, durationMs, provider, model }) {
  const parts = [
    `code=${typeof code === 'number' ? code : 'null'}`,
    `signal=${signal || 'none'}`,
    `duration_ms=${typeof durationMs === 'number' ? durationMs : 0}`,
    `provider=${provider || 'unknown'}`,
  ];
  if (model) parts.push(`model=${model}`);
  return `${PROCESS_EXIT_PREFIX} ${parts.join(' ')}`;
}

function parseProcessExitLine(line) {
  if (typeof line !== 'string') return null;
  const m = PROCESS_EXIT_LINE_REGEX.exec(line);
  if (!m) return null;
  const fields = {};
  for (const part of m[1].split(' ')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const codeRaw = fields.code;
  const code = (codeRaw === 'null' || codeRaw === undefined) ? null : Number(codeRaw);
  const signal = fields.signal === 'none' ? null : (fields.signal || null);
  const dur = fields.duration_ms !== undefined ? Number(fields.duration_ms) : null;
  return {
    code,
    signal,
    duration_ms: dur,
    provider: fields.provider || null,
    model: fields.model || null,
  };
}

function findLastProcessExitAnnotation(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseProcessExitLine(lines[i]);
    if (parsed) return parsed;
  }
  return null;
}

// [torque-spawn] startup marker — PID-reuse defense.
// Closes subprocess-detachment.md open question #8. The wrapper emits
// this line on init; re-adoption verifies the embedded taskId matches
// the row's id before adopting. Without it, a recycled PID owned by
// ANOTHER torque-spawned subprocess could be silently re-adopted as
// the wrong task — log-mtime defense alone doesn't help when both
// PIDs' logs are fresh.
//
// Format: [torque-spawn] taskId=<id> wrapper-pid=<int> started_at_epoch=<int>

const TORQUE_SPAWN_PREFIX = '[torque-spawn]';
const TORQUE_SPAWN_LINE_REGEX = /^\[torque-spawn\] (.+)$/;

function formatTorqueSpawnLine({ taskId, wrapperPid, startedAtEpoch }) {
  const parts = [
    `taskId=${taskId || 'unknown'}`,
    `wrapper-pid=${typeof wrapperPid === 'number' ? wrapperPid : 0}`,
    `started_at_epoch=${typeof startedAtEpoch === 'number' ? startedAtEpoch : 0}`,
  ];
  return `${TORQUE_SPAWN_PREFIX} ${parts.join(' ')}`;
}

function parseTorqueSpawnLine(line) {
  if (typeof line !== 'string') return null;
  const m = TORQUE_SPAWN_LINE_REGEX.exec(line);
  if (!m) return null;
  const fields = {};
  for (const part of m[1].split(' ')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (key === 'wrapper-pid') fields.wrapperPid = val;
    else fields[key] = val;
  }
  const wrapperPid = fields.wrapperPid !== undefined ? Number(fields.wrapperPid) : null;
  const startedAtEpoch = fields.started_at_epoch !== undefined
    ? Number(fields.started_at_epoch)
    : null;
  return {
    taskId: fields.taskId || null,
    wrapperPid: Number.isFinite(wrapperPid) ? wrapperPid : null,
    startedAtEpoch: Number.isFinite(startedAtEpoch) ? startedAtEpoch : null,
  };
}

// Scan a multi-line buffer for the FIRST [torque-spawn] line. Wrapper
// writes exactly one on startup; front-scan is correct + faster on long
// logs. Returns null when absent — callers decide whether to treat that
// as "pre-marker-rollout subprocess" (allow) or "definitely not ours"
// (reject).
function findFirstTorqueSpawnAnnotation(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseTorqueSpawnLine(lines[i]);
    if (parsed) return parsed;
  }
  return null;
}

module.exports = {
  PROCESS_EXIT_PREFIX,
  PROCESS_EXIT_LINE_REGEX,
  formatProcessExitLine,
  parseProcessExitLine,
  findLastProcessExitAnnotation,
  TORQUE_SPAWN_PREFIX,
  TORQUE_SPAWN_LINE_REGEX,
  formatTorqueSpawnLine,
  parseTorqueSpawnLine,
  findFirstTorqueSpawnAnnotation,
};
