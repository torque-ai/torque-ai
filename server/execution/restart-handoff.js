'use strict';

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../data-dir');

const HANDOFF_FILENAME = 'restart-handoff.json';

function getRestartHandoffPath() {
  return path.join(getDataDir(), HANDOFF_FILENAME);
}

function readRestartHandoff() {
  try {
    const raw = fs.readFileSync(getRestartHandoffPath(), 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.barrier_id) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeRestartHandoff(payload) {
  const handoff = {
    barrier_id: payload.barrier_id,
    reason: payload.reason || 'restart',
    requested_at: payload.requested_at || new Date().toISOString(),
    requested_by_pid: payload.requested_by_pid || process.pid,
  };
  fs.writeFileSync(getRestartHandoffPath(), JSON.stringify(handoff), 'utf8');
  return handoff;
}

function clearRestartHandoff() {
  try {
    fs.unlinkSync(getRestartHandoffPath());
    return true;
  } catch {
    return false;
  }
}

function stageRestartHandoff({ barrierId, reason }) {
  return writeRestartHandoff({
    barrier_id: barrierId,
    reason,
  });
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
    return { completed: false, reason: 'missing_barrier', barrier_id: barrierId };
  }

  if (!['queued', 'running'].includes(task.status)) {
    clearRestartHandoff();
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
  readRestartHandoff,
  writeRestartHandoff,
  clearRestartHandoff,
  stageRestartHandoff,
  completePendingRestartHandoff,
};
