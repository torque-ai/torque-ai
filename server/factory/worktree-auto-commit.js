'use strict';

const childProcess = require('child_process');
const fs = require('fs');
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

function runGitWithStdin(worktreePath, args, stdin) {
  // Pipe paths via stdin with --pathspec-from-file=- --pathspec-file-nul
  // to sidestep the TORQUE-runtime argv-corruption quirk where git eats
  // the first byte of the first path argument.
  return childProcess.execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf8',
    windowsHide: true,
    input: stdin,
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

    // Determine which tracked files are semantically changed (ignoring
    // CR-at-EOL drift) and which files are untracked. `git diff
    // --ignore-cr-at-eol --name-only` is broken for this use — it
    // lists drift-only files even though --quiet on the same diff
    // exits 0 (confirmed against the Codex-produced worktree). Fall
    // back to per-file exit-code probing via `git diff --quiet`.
    const changedTrackedOut = runGit(worktree.worktreePath, [
      'diff', '--name-only', 'HEAD',
    ]).trim();
    const changedTracked = changedTrackedOut
      ? changedTrackedOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];

    const semanticTracked = changedTracked.filter((p) => {
      try {
        childProcess.execFileSync('git', [
          'diff', '--quiet', '--ignore-cr-at-eol', 'HEAD', '--', p,
        ], { cwd: worktree.worktreePath, windowsHide: true });
        return false; // exit 0 → no semantic diff; this is pure drift.
      } catch (err) {
        // Any non-zero exit (most commonly 1 for "has diff") counts
        // as a real change we want to stage.
        return true;
      }
    });

    const untrackedOut = runGit(worktree.worktreePath, [
      'ls-files', '--others', '--exclude-standard',
    ]).trim();
    const untracked = untrackedOut
      ? untrackedOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];

    const pathsToStage = [...semanticTracked, ...untracked];

    if (pathsToStage.length === 0) {
      // Worktree only has pure line-ending drift (or is fully clean).
      const driftPaths = parsePorcelainPaths(statusOutput);
      safeLogDecision({
        ...decisionBase,
        action: 'auto_commit_skipped_clean',
        reasoning: 'Approved plan task completed. Worktree had dirty files, but all were pure line-ending drift; nothing to commit.',
        outcome: {
          task_id: task.id,
          plan_task_number: planTaskNumber,
          files_changed: [],
          skipped_drift_files: driftPaths,
        },
      });
      return;
    }

    // Stage paths via --pathspec-from-file=- to sidestep the TORQUE-
    // runtime argv-corruption quirk that eats the first byte of the
    // first path argument on multi-path git add.
    runGitWithStdin(
      worktree.worktreePath,
      ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
      pathsToStage.join('\0'),
    );

    const allStagedOutput = runGit(worktree.worktreePath, ['diff', '--cached', '--name-only']).trim();
    const allStaged = allStagedOutput
      ? allStagedOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];

    if (allStaged.length === 0) {
      const driftPaths = parsePorcelainPaths(statusOutput);
      safeLogDecision({
        ...decisionBase,
        action: 'auto_commit_skipped_clean',
        reasoning: 'Approved plan task completed. pathspec-from-file staging produced no changes; worktree was likely pure line-ending drift.',
        outcome: {
          task_id: task.id,
          plan_task_number: planTaskNumber,
          files_changed: [],
          skipped_drift_files: driftPaths,
        },
      });
      return;
    }

    // Sanitize PII in staged files BEFORE git commit. The pre-commit
    // hook calls PII-GUARD which curls TORQUE at 127.0.0.1:3457, but
    // TORQUE's event loop is blocked by this synchronous execFileSync
    // chain (auto-commit listener → git commit → hook → curl → TORQUE
    // can't respond). The hook falls back to the regex scanner, which
    // flags existing test-fixture IPs (10.x.x.x) in files the factory
    // legitimately touched. Running TORQUE's own PII scanner as a
    // direct module call bypasses the HTTP deadlock and auto-replaces
    // real PII with safe placeholders before staging.
    let piiFixCount = 0;
    try {
      const { scanAndReplace } = require('../utils/pii-guard');
      for (const stagedPath of allStaged) {
        const absPath = path.join(worktree.worktreePath, stagedPath);
        if (!fs.existsSync(absPath)) continue;
        const content = fs.readFileSync(absPath, 'utf8');
        const result = scanAndReplace(content, { workingDirectory: worktree.worktreePath });
        if (!result.clean && result.sanitized) {
          fs.writeFileSync(absPath, result.sanitized);
          runGitWithStdin(
            worktree.worktreePath,
            ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
            stagedPath,
          );
          piiFixCount += result.findings.length;
        }
      }
    } catch (piiErr) {
      logger.warn('PII pre-sanitize failed (non-fatal); git commit will attempt anyway', {
        err: piiErr.message,
        worktree_path: worktree.worktreePath,
      });
    }

    const commitMessage = buildCommitMessage(planTaskNumber, planTaskTitle);
    runGit(worktree.worktreePath, ['commit', '-m', commitMessage]);
    const commitSha = runGit(worktree.worktreePath, ['rev-parse', 'HEAD']).trim();

    const driftPaths = parsePorcelainPaths(statusOutput).filter((p) => !allStaged.includes(p));

    safeLogDecision({
      ...decisionBase,
      action: 'auto_committed_task',
      reasoning: 'Approved plan task completed with dirty worktree changes, so the factory auto-committed them.',
      outcome: {
        commit_sha: commitSha,
        files_changed: allStaged,
        skipped_drift_files: driftPaths,
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
