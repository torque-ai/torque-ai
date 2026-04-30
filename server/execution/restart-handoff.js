'use strict';

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../data-dir');

const HANDOFF_FILENAME = 'restart-handoff.json';
const INTENT_FILENAME = 'restart-intent.json';
const EXIT_DIAGNOSTICS_FILENAME = 'restart-exit.ndjson';

function getRestartHandoffPath() {
  return path.join(getDataDir(), HANDOFF_FILENAME);
}

function getRestartIntentPath() {
  return path.join(getDataDir(), INTENT_FILENAME);
}

function getRestartExitDiagnosticsPath() {
  return path.join(getDataDir(), EXIT_DIAGNOSTICS_FILENAME);
}

function readJsonFile(filePath) {
  try {
    // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- shutdown/startup handoff file — sync is correct ordering.
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- restart lifecycle state must be durable before shutdown.
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  return payload;
}

function readRestartHandoff() {
  const parsed = readJsonFile(getRestartHandoffPath());
  if (!parsed || !parsed.barrier_id) {
    return null;
  }
  return parsed;
}

function readRestartIntent() {
  const parsed = readJsonFile(getRestartIntentPath());
  if (!parsed || !parsed.barrier_id) {
    return null;
  }
  return parsed;
}

function normalizeRestartStatePayload(payload, previous = null) {
  const now = new Date().toISOString();
  return {
    barrier_id: payload.barrier_id,
    reason: payload.reason || 'restart',
    requested_at: payload.requested_at || previous?.requested_at || now,
    requested_by_pid: payload.requested_by_pid || process.pid,
    ...payload,
    updated_at: now,
  };
}

function writeRestartHandoff(payload) {
  const handoff = normalizeRestartStatePayload(payload);
  return writeJsonFile(getRestartHandoffPath(), handoff);
}

function writeRestartIntent(payload) {
  const intent = normalizeRestartStatePayload({
    phase: 'created',
    ...payload,
  });
  return writeJsonFile(getRestartIntentPath(), intent);
}

function updateRestartIntent(updates) {
  const previous = readRestartIntent();
  if (!previous) return null;
  const next = normalizeRestartStatePayload({
    ...previous,
    ...updates,
    barrier_id: previous.barrier_id,
    reason: updates.reason || previous.reason,
    requested_at: previous.requested_at,
    requested_by_pid: previous.requested_by_pid,
  }, previous);
  return writeJsonFile(getRestartIntentPath(), next);
}

function clearRestartHandoff() {
  try {
    // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- shutdown/startup handoff file — sync is correct ordering.
    fs.unlinkSync(getRestartHandoffPath());
    return true;
  } catch {
    return false;
  }
}

function clearRestartIntent() {
  try {
    // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- shutdown/startup state cleanup.
    fs.unlinkSync(getRestartIntentPath());
    return true;
  } catch {
    return false;
  }
}

function stageRestartHandoff({ barrierId, reason }) {
  const intent = readRestartIntent();
  if (intent && intent.barrier_id === barrierId) {
    updateRestartIntent({
      phase: 'handoff_staged',
      handoff_staged_at: new Date().toISOString(),
    });
  }
  return writeRestartHandoff({
    barrier_id: barrierId,
    reason,
  });
}

function formatStaleRestartBarrierError(barrierId, intent) {
  if (!intent || intent.barrier_id !== barrierId) {
    return '[startup-cleanup] Stale restart barrier — server restarted before drain completed';
  }
  const phase = intent.phase || 'unknown';
  const parts = [
    `[startup-cleanup] Stale restart barrier — server restarted while restart intent phase was '${phase}'`,
    `reason=${intent.reason || 'restart'}`,
    `requested_at=${intent.requested_at || 'unknown'}`,
    `updated_at=${intent.updated_at || 'unknown'}`,
    `requested_by_pid=${intent.requested_by_pid || 'unknown'}`,
  ];
  if (intent.running_count != null) parts.push(`running_count=${intent.running_count}`);
  if (intent.queued_held_count != null) parts.push(`queued_held_count=${intent.queued_held_count}`);
  return parts.join('; ');
}

function writeRestartExitDiagnostic(payload = {}) {
  const intent = readRestartIntent();
  const handoff = readRestartHandoff();
  if (!intent && !handoff && !payload.restart_pending) {
    return null;
  }

  const diagnostic = {
    timestamp: new Date().toISOString(),
    event: payload.event || 'exit',
    pid: process.pid,
    code: payload.code,
    signal: payload.signal,
    shutdown_state: payload.shutdown_state,
    restart_pending: Boolean(payload.restart_pending),
    intent,
    handoff,
  };
  fs.appendFileSync(getRestartExitDiagnosticsPath(), `${JSON.stringify(diagnostic)}\n`, 'utf8');
  return diagnostic;
}

function completePendingRestartHandoff({ taskCore, instanceId, logger }) {
  const handoff = readRestartHandoff();
  if (!handoff) {
    return { completed: false, reason: 'no_handoff' };
  }

  const barrierId = handoff.barrier_id;
  let task = null;
  try {
    task = taskCore && typeof taskCore.getTask === 'function'
      ? taskCore.getTask(barrierId)
      : null;
  } catch {
    task = null;
  }

  if (!task) {
    clearRestartHandoff();
    const intent = readRestartIntent();
    if (intent && intent.barrier_id === barrierId) {
      clearRestartIntent();
    }
    return { completed: false, reason: 'missing_barrier', barrier_id: barrierId };
  }

  if (!['queued', 'running'].includes(task.status)) {
    clearRestartHandoff();
    const intent = readRestartIntent();
    if (intent && intent.barrier_id === barrierId) {
      clearRestartIntent();
    }
    return {
      completed: false,
      reason: 'already_terminal',
      barrier_id: barrierId,
      barrier_status: task.status,
    };
  }

  const completedTask = taskCore.updateTaskStatus(barrierId, 'completed', {
    output: `Restart completed by instance ${instanceId || 'unknown'} (pid ${process.pid})`,
    completed_at: new Date().toISOString(),
  });

  try {
    const { dispatchTaskEvent } = require('../hooks/event-dispatch');
    dispatchTaskEvent('completed', completedTask || taskCore.getTask(barrierId));
  } catch { /* non-fatal */ }

  clearRestartHandoff();
  const intent = readRestartIntent();
  if (intent && intent.barrier_id === barrierId) {
    clearRestartIntent();
  }
  if (logger && typeof logger.info === 'function') {
    logger.info(`[Restart] Completed handoff for barrier ${String(barrierId).slice(0, 8)} on instance ${instanceId || 'unknown'}`);
  }
  return {
    completed: true,
    barrier_id: barrierId,
    barrier_status: 'completed',
  };
}

module.exports = {
  getRestartHandoffPath,
  getRestartIntentPath,
  getRestartExitDiagnosticsPath,
  readRestartHandoff,
  readRestartIntent,
  writeRestartHandoff,
  writeRestartIntent,
  updateRestartIntent,
  clearRestartHandoff,
  clearRestartIntent,
  stageRestartHandoff,
  formatStaleRestartBarrierError,
  writeRestartExitDiagnostic,
  completePendingRestartHandoff,
};
