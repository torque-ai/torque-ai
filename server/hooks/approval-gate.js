'use strict';

const path = require('path');

const taskCore = require('../db/task-core');
const fileTracking = require('../db/file/tracking');
const validationRules = require('../db/validation-rules');
const logger = require('../logger').child({ component: 'approval-gate' });
const { TASK_TIMEOUTS } = require('../constants');
const { safeGitExec, gitRefExists } = require('../utils/git');

const MAX_ALLOWED_SIZE_DECREASE_PERCENT = -50;

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRelativePath(filePath, workingDirectory) {
  const normalizedPath = normalizeNonEmptyString(filePath);
  const normalizedWorkdir = normalizeNonEmptyString(workingDirectory);

  if (!normalizedPath) return null;
  if (!normalizedWorkdir) return normalizedPath;
  if (!path.isAbsolute(normalizedPath)) return normalizedPath;

  const relativePath = path.relative(normalizedWorkdir, normalizedPath);
  if (!relativePath || relativePath.startsWith('..')) {
    return null;
  }

  return relativePath;
}

function readGitDiffFiles(workingDirectory) {
  const normalizedWorkdir = normalizeNonEmptyString(workingDirectory);
  if (!normalizedWorkdir) return [];

  const commands = [
    ['diff', '--name-only'],
    ['diff', '--name-only', '--cached'],
    // 'HEAD~1 HEAD' fails in single-commit repos (no parent). The try/catch below
    // silently skips failed commands, so this is safe — the first two commands
    // will have already returned if there are working-tree or staged changes.
    ['diff', '--name-only', 'HEAD~1', 'HEAD'],
  ];

  for (const gitArgs of commands) {
    if (gitArgs[2] === 'HEAD~1' && !gitRefExists(normalizedWorkdir, 'HEAD~1', {
      timeout: TASK_TIMEOUTS.GIT_DIFF,
    })) {
      continue;
    }

    try {
      const output = safeGitExec(gitArgs, {
        cwd: normalizedWorkdir,
        encoding: 'utf8',
        timeout: TASK_TIMEOUTS.GIT_DIFF,
      }).trim();

      if (!output) continue;
      return output.split('\n').map((entry) => entry.trim()).filter(Boolean);
    } catch {
      // Ignore git lookup failures. Approval checks should remain non-fatal.
    }
  }

  return [];
}

function collectCandidateFiles(task) {
  const filePaths = new Set();
  const fileChanges = typeof fileTracking.getTaskFileChanges === 'function'
    ? fileTracking.getTaskFileChanges(task.id)
    : [];

  for (const change of fileChanges) {
    const relativePath = normalizeRelativePath(change.relative_path || change.file_path, task.working_directory);
    if (relativePath) {
      filePaths.add(relativePath);
    }
  }

  if (filePaths.size === 0) {
    for (const relativePath of readGitDiffFiles(task.working_directory)) {
      filePaths.add(relativePath);
    }
  }

  return [...filePaths];
}

function getBaselineComparison(task, relativePath) {
  const comparison = fileTracking.compareFileToBaseline(relativePath, task.working_directory);
  if (comparison && comparison.hasBaseline) {
    return comparison;
  }

  const absolutePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(task.working_directory, relativePath);
  return fileTracking.compareFileToBaseline(absolutePath, task.working_directory);
}

function collectFileShrinkReasons(task) {
  if (!normalizeNonEmptyString(task.working_directory)) {
    return [];
  }

  const reasons = [];
  for (const relativePath of collectCandidateFiles(task)) {
    const comparison = getBaselineComparison(task, relativePath);
    if (!comparison || !comparison.hasBaseline || comparison.error) {
      continue;
    }

    if (comparison.sizeChangePercent < MAX_ALLOWED_SIZE_DECREASE_PERCENT) {
      reasons.push(
        `${relativePath} shrank by ${Math.abs(comparison.sizeChangePercent).toFixed(1)}%`
      );
    }
  }

  return reasons;
}

function collectValidationReasons(taskId) {
  if (typeof validationRules.getValidationResults !== 'function') {
    return [];
  }

  const results = validationRules.getValidationResults(taskId)
    .filter((result) => result.status === 'fail');

  const reasons = new Set();
  for (const result of results) {
    const locationSuffix = normalizeNonEmptyString(result.file_path)
      ? ` (${result.file_path})`
      : '';
    reasons.add(`Validation failure: ${result.rule_name || 'unknown rule'}${locationSuffix}`);
  }

  return [...reasons];
}

function checkApprovalGate(taskId) {
  const normalizedTaskId = normalizeNonEmptyString(taskId);
  if (!normalizedTaskId) {
    return {
      approved: false,
      reasons: ['taskId is required'],
    };
  }

  const task = taskCore.getTask(normalizedTaskId);
  if (!task) {
    return {
      approved: false,
      reasons: [`Task not found: ${normalizedTaskId}`],
    };
  }

  const reasons = [];
  const outputText = normalizeNonEmptyString(task.output);

  if (!outputText) {
    reasons.push('Task output is empty');
  }

  reasons.push(...collectValidationReasons(normalizedTaskId));
  reasons.push(...collectFileShrinkReasons(task));

  const uniqueReasons = [...new Set(reasons)];

  logger.info(`[ApprovalGate] ${normalizedTaskId} => ${uniqueReasons.length === 0 ? 'approved' : 'rejected'}`);

  return {
    approved: uniqueReasons.length === 0,
    reasons: uniqueReasons,
  };
}

function createApprovalGate() {
  return { checkApprovalGate };
}

module.exports = {
  checkApprovalGate,
  createApprovalGate,
};
