'use strict';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const SUCCESS_STATUSES = new Set(['completed', 'skipped']);

function normalizeDeps(deps) {
  return Array.isArray(deps)
    ? deps.map((dep) => ({
      task_id: dep.task_id || dep.dep_task_id || dep.id || null,
      status: String(dep.status || '').trim().toLowerCase(),
    }))
    : [];
}

function evaluateMergeJoin(policy = 'wait_all', deps = []) {
  const normalized = normalizeDeps(deps);
  const total = normalized.length;
  const terminal = normalized.filter((dep) => TERMINAL_STATUSES.has(dep.status));
  const successful = normalized.filter((dep) => SUCCESS_STATUSES.has(dep.status));
  const failed = normalized.filter((dep) => dep.status === 'failed' || dep.status === 'cancelled');

  if (total === 0) {
    return { policy, unblock: true, reason: 'no_dependencies', total, terminal: 0, successful: 0, failed: 0 };
  }

  if (policy === 'first_success') {
    if (successful.length > 0) {
      return { policy, unblock: true, reason: 'first_success', total, terminal: terminal.length, successful: successful.length, failed: failed.length };
    }
    return { policy, unblock: false, reason: terminal.length === total ? 'no_successful_dependency' : 'waiting_for_success', total, terminal: terminal.length, successful: 0, failed: failed.length };
  }

  if (policy === 'wait_all') {
    return {
      policy,
      unblock: terminal.length === total,
      reason: terminal.length === total ? 'all_terminal' : 'waiting_for_all',
      total,
      terminal: terminal.length,
      successful: successful.length,
      failed: failed.length,
    };
  }

  return {
    policy,
    unblock: false,
    reason: 'unsupported_policy',
    total,
    terminal: terminal.length,
    successful: successful.length,
    failed: failed.length,
  };
}

function activeFanoutCount(tasks = []) {
  return tasks.filter((task) => ['queued', 'pending', 'running', 'pending_provider_switch'].includes(task.status)).length;
}

module.exports = {
  TERMINAL_STATUSES,
  evaluateMergeJoin,
  activeFanoutCount,
};
