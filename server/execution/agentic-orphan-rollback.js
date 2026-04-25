'use strict';

const {
  hydrateSnapshot,
  revertChangesSinceSnapshot,
} = require('../providers/agentic-git-safety');

function parseMetadata(task) {
  if (!task?.metadata) return {};
  if (typeof task.metadata === 'string') {
    try {
      return JSON.parse(task.metadata);
    } catch {
      return {};
    }
  }
  return (task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata))
    ? task.metadata
    : {};
}

function rollbackAgenticTaskChanges(task, options = {}) {
  const logger = options.logger || null;
  const metadata = parseMetadata(task);
  const snapshot = hydrateSnapshot(metadata.agentic_git_snapshot);
  const workingDir = task?.working_directory || metadata.agentic_git_snapshot?.working_directory;

  if (!workingDir || !snapshot?.isGitRepo) {
    return { attempted: false, reverted: [], kept: [], report: '' };
  }

  try {
    const result = revertChangesSinceSnapshot(workingDir, snapshot);
    if (result.report) {
      logger?.info?.(`[agentic-orphan-rollback] ${task.id}: ${result.report}`);
    }
    return { attempted: true, ...result };
  } catch (err) {
    const report = `Agentic orphan rollback failed: ${err.message}`;
    logger?.warn?.(`[agentic-orphan-rollback] ${task?.id || 'unknown'}: ${err.message}`);
    return { attempted: true, reverted: [], kept: [], report };
  }
}

function appendRollbackReport(message, rollbackResult) {
  if (!rollbackResult?.report) return message;
  return message ? `${message}\n${rollbackResult.report}` : rollbackResult.report;
}

module.exports = {
  appendRollbackReport,
  rollbackAgenticTaskChanges,
};
