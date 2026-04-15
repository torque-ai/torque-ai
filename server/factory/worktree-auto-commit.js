'use strict';

const childProcess = require('child_process');
const path = require('path');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryWorktrees = require('../db/factory-worktrees');
const taskCore = require('../db/task-core');
const { logDecision } = require('./decision-log');
const { taskEvents } = require('../hooks/event-dispatch');
const logger = require('../logger').child({ component: 'factory-worktree-auto-commit' });

const ELIGIBLE_TRUST_LEVELS = new Set(['supervised', 'autonomous']);
const BATCH_TAG_PREFIX = 'factory:batch_id=';
const PLAN_TASK_TAG_PREFIX = 'factory:plan_task_number=';

let completedTaskListener = null;

function normalizePathForCompare(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return null;
  }
  return path.resolve(targetPath).replace(/\\/g, '/').toLowerCase();
}

function getTaskId(event) {
  if (typeof event === 'string' && event.trim()) {
    return event.trim();
  }
  if (event && typeof event === 'object') {
    const candidate = event.id || event.taskId || event.task_id;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function getTagValue(tags, prefix) {
  if (!Array.isArray(tags)) {
    return null;
  }
  const match = tags.find((tag) => typeof tag === 'string' && tag.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function parsePlanTaskNumber(rawValue) {
  const numeric = Number(rawValue);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseFactoryBatchId(batchId) {
  if (typeof batchId !== 'string' || batchId.trim() === '') {
    return null;
  }
  const match = /^factory-(.+)-(\d+)$/.exec(batchId.trim());
  if (!match) {
    return null;
  }
  return {
    project_id: match[1],
    work_item_id: Number(match[2]),
  };
}

function resolveWorktree(task, batchId) {
  let worktree = batchId ? factoryWorktrees.getActiveWorktreeByBatch(batchId) : null;
  if (!worktree && task?.working_directory) {
    const expectedPath = normalizePathForCompare(task.working_directory);
    if (expectedPath) {
      worktree = factoryWorktrees.listActiveWorktrees().find((candidate) => (
        normalizePathForCompare(candidate?.worktreePath) === expectedPath
      )) || null;
    }
  }

  const parsedBatch = parseFactoryBatchId(batchId);
  if (!worktree && parsedBatch?.project_id) {
    worktree = factoryWorktrees.getActiveWorktree(parsedBatch.project_id);
  }

  return worktree || null;
}

function extractPlanTaskTitle(task, planTaskNumber) {
  const metadataTitle = typeof task?.metadata?.plan_task_title === 'string'
    ? task.metadata.plan_task_title.trim()
    : '';
  if (metadataTitle) {
    return metadataTitle;
  }

  const description = typeof task?.task_description === 'string'
    ? task.task_description
    : '';
  if (!description) {
    return null;
  }

  const patterns = [];
  if (Number.isInteger(planTaskNumber) && planTaskNumber > 0) {
    patterns.push(new RegExp(`^Task\\s+${planTaskNumber}:\\s+(.+)$`, 'mi'));
  }
  patterns.push(/^Task\s+\d+:\s+(.+)$/mi);

  for (const pattern of patterns) {
    const match = pattern.exec(description);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function sanitizeCommitTitle(title) {
  if (typeof title !== 'string') {
    return 'approved plan task';
  }
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'approved plan task';
  }
  return normalized.slice(0, 160);
}

function buildCommitMessage(planTaskNumber, planTaskTitle) {
  return `feat(factory): plan task ${planTaskNumber} — ${sanitizeCommitTitle(planTaskTitle)}`;
}

function runGit(worktreePath, args) {
  return childProcess.execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function parsePorcelainPaths(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      if (!rawPath) {
        return null;
      }
      const normalized = rawPath.includes(' -> ')
        ? rawPath.split(' -> ').pop()
        : rawPath;
      return normalized ? normalized.replace(/^"+|"+$/g, '') : null;
    })
    .filter(Boolean);
}

function parsePorcelainEntries(output) {
  // Like parsePorcelainPaths, but preserves the XY status bytes so we can
  // distinguish "?? untracked" (Codex created a new file) from " M dirty"
  // (could be real edit OR line-ending drift from a remote test run).
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      if (line.length < 3) return null;
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      if (!rawPath) return null;
      const normalized = rawPath.includes(' -> ')
        ? rawPath.split(' -> ').pop()
        : rawPath;
      if (!normalized) return null;
      return { status, path: normalized.replace(/^"+|"+$/g, '') };
    })
    .filter(Boolean);
}

function classifyEntries(entries) {
  // Split porcelain entries into two bins:
  //   - untracked / deleted / renamed / already-staged → add directly
  //   - modified-tracked (" M", " T", "MM", etc.) → add --renormalize
  // --renormalize is the magic that drops CRLF/LF-drift-only files from
  // the commit: if the only diff is line endings, renormalize stages
  // nothing for that path. Real edits still get staged.
  const untracked = [];
  const renormalizeCandidates = [];
  for (const entry of entries) {
    if (entry.status === '??') {
      untracked.push(entry.path);
      continue;
    }
    renormalizeCandidates.push(entry.path);
  }
  return { untracked, renormalizeCandidates };
}

function formatGitError(error) {
  const parts = [];
  if (error?.message) {
    parts.push(error.message);
  }
  const stderr = typeof error?.stderr === 'string'
    ? error.stderr
    : error?.stderr
      ? String(error.stderr)
      : '';
  const trimmedStderr = stderr.trim();
  if (trimmedStderr) {
    parts.push(trimmedStderr);
  }
  return parts.join(' | ') || 'unknown git error';
}

function safeLogDecision(entry) {
  if (!entry?.project_id || !entry?.action) {
    return null;
  }

  try {
    const db = database.getDbInstance();
    if (db) {
      factoryDecisions.setDb(db);
    }

    return logDecision({
      ...entry,
      stage: 'execute',
      actor: 'executor',
    });
  } catch (error) {
    logger.warn(
      {
        err: error.message,
        project_id: entry.project_id,
        action: entry.action,
        batch_id: entry.batch_id || null,
      },
      'Failed to log factory worktree auto-commit decision'
    );
    return null;
  }
}

function commitCompletedPlanTask(task) {
  if (!task || task.status !== 'completed') {
    return;
  }

  const batchId = getTagValue(task.tags, BATCH_TAG_PREFIX);
  const planTaskNumber = parsePlanTaskNumber(getTagValue(task.tags, PLAN_TASK_TAG_PREFIX));
  if (!batchId || !planTaskNumber) {
    return;
  }

  const worktree = resolveWorktree(task, batchId);
  if (!worktree?.worktreePath || !worktree?.project_id) {
    return;
  }

  const planTaskTitle = extractPlanTaskTitle(task, planTaskNumber);
  const decisionBase = {
    project_id: worktree.project_id,
    batch_id: worktree.batchId || batchId,
    inputs: {
      task_id: task.id,
      plan_task_number: planTaskNumber,
      plan_task_title: planTaskTitle,
      worktree_path: worktree.worktreePath,
    },
    confidence: 1,
  };

  try {
    const statusOutput = runGit(worktree.worktreePath, ['status', '--porcelain']).trim();
    if (!statusOutput) {
      safeLogDecision({
        ...decisionBase,
        action: 'auto_commit_skipped_clean',
        reasoning: 'Approved plan task completed, but the factory worktree was already clean.',
        outcome: {
          task_id: task.id,
          plan_task_number: planTaskNumber,
          files_changed: [],
        },
      });
      return;
    }

    const entries = parsePorcelainEntries(statusOutput);
    const { untracked, renormalizeCandidates } = classifyEntries(entries);

    // --renormalize is a no-op for files whose only drift is CR-at-EOL
    // or similar line-ending normalization. For genuinely edited files
    // it stages the normalized content. So running it against every
    // tracked-modified path drops drift from the commit automatically,
    // without needing a per-file diff probe.
    // We pass paths after the renormalize/add flags without a `--`
    // separator. The remote Linux test runner exhibited a git argv
    // parsing quirk that corrupted the first path byte when `-- <path>`
    // was used (pathspec 'xisting.txt' from 'existing.txt'). Factory
    // file names from plans never start with '-' so the separator is
    // unnecessary here.
    if (renormalizeCandidates.length > 0) {
      runGit(worktree.worktreePath, ['add', '--renormalize', ...renormalizeCandidates]);
    }
    if (untracked.length > 0) {
      runGit(worktree.worktreePath, ['add', ...untracked]);
    }

    const stagedOutput = runGit(worktree.worktreePath, ['diff', '--cached', '--name-only']).trim();
    const stagedFiles = stagedOutput
      ? stagedOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];

    if (stagedFiles.length === 0) {
      // Everything in the worktree was pure line-ending drift and/or
      // was already clean post-renormalize. Record the skip so the
      // audit trail shows which files the drift check dropped.
      const driftSkipped = renormalizeCandidates.filter((p) => !untracked.includes(p));
      safeLogDecision({
        ...decisionBase,
        action: 'auto_commit_skipped_clean',
        reasoning: 'Approved plan task completed. Worktree had dirty files, but all were pure line-ending drift; nothing to commit.',
        outcome: {
          task_id: task.id,
          plan_task_number: planTaskNumber,
          files_changed: [],
          skipped_drift_files: driftSkipped,
        },
      });
      return;
    }

    const commitMessage = buildCommitMessage(planTaskNumber, planTaskTitle);
    runGit(worktree.worktreePath, ['commit', '-m', commitMessage]);
    const commitSha = runGit(worktree.worktreePath, ['rev-parse', 'HEAD']).trim();

    const skippedDrift = renormalizeCandidates.filter((p) => !stagedFiles.includes(p));

    safeLogDecision({
      ...decisionBase,
      action: 'auto_committed_task',
      reasoning: 'Approved plan task completed with dirty worktree changes, so the factory auto-committed them.',
      outcome: {
        commit_sha: commitSha,
        files_changed: stagedFiles,
        skipped_drift_files: skippedDrift,
        task_id: task.id,
        plan_task_number: planTaskNumber,
      },
    });
  } catch (error) {
    safeLogDecision({
      ...decisionBase,
      action: 'auto_commit_failed',
      reasoning: 'Approved plan task completed, but the factory auto-commit failed and left the worktree untouched.',
      outcome: {
        error: formatGitError(error),
        task_id: task.id,
        plan_task_number: planTaskNumber,
      },
    });
  }
}

function hasEligibleFactoryProjects(project = null) {
  if (project && ELIGIBLE_TRUST_LEVELS.has(project.trust_level)) {
    return true;
  }

  try {
    return factoryHealth.listProjects().some((candidate) => ELIGIBLE_TRUST_LEVELS.has(candidate?.trust_level));
  } catch {
    return false;
  }
}

function initFactoryWorktreeAutoCommit({ project = null } = {}) {
  if (completedTaskListener) {
    return true;
  }
  if (!hasEligibleFactoryProjects(project)) {
    return false;
  }

  completedTaskListener = (event) => {
    const taskId = getTaskId(event);
    if (!taskId) {
      return;
    }

    let task = null;
    try {
      task = taskCore.getTask(taskId);
    } catch (error) {
      logger.debug({ err: error.message, task_id: taskId }, 'Unable to resolve completed task for factory worktree auto-commit');
      return;
    }

    commitCompletedPlanTask(task);
  };

  taskEvents.on('task:completed', completedTaskListener);
  logger.info('Factory worktree auto-commit listener registered');
  return true;
}

function resetFactoryWorktreeAutoCommitForTests() {
  if (!completedTaskListener) {
    return;
  }
  taskEvents.removeListener('task:completed', completedTaskListener);
  completedTaskListener = null;
}

module.exports = {
  initFactoryWorktreeAutoCommit,
  commitCompletedPlanTask,
  resetFactoryWorktreeAutoCommitForTests,
};
