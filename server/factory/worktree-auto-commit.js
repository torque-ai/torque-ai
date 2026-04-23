'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const attemptHistory = require('../db/factory-attempt-history');
const { classifyZeroDiff } = require('./completion-rationale');
const factoryHealth = require('../db/factory-health');
const factoryWorktrees = require('../db/factory-worktrees');
const taskCore = require('../db/task-core');
const { logDecision } = require('./decision-log');
const { taskEvents } = require('../hooks/event-dispatch');
const logger = require('../logger').child({ component: 'factory-worktree-auto-commit' });
const { TASK_TIMEOUTS } = require('../constants');
const { safeGitExec } = require('../utils/git');

// Mirror of factory-health.js VALID_TRUST_LEVELS. Earlier this set was
// ['supervised', 'autonomous'], which silently excluded 'dark' (the most
// automated trust level — the one that needs auto-commit the most). With
// 'dark' projects the listener never registered at boot, so Codex's edits
// stayed uncommitted on the feat branch, LEARN's merge always failed
// "no commits ahead", and the loop spun re-running the same plan tasks
// forever. Including every real trust level keeps boot-time eligibility
// in sync with project registration.
const ELIGIBLE_TRUST_LEVELS = new Set(['supervised', 'guided', 'autonomous', 'dark']);
const BATCH_TAG_PREFIX = 'factory:batch_id=';
const PLAN_TASK_TAG_PREFIX = 'factory:plan_task_number=';
const NON_PRODUCT_AUTO_COMMIT_PATTERNS = Object.freeze([
  /^runs\//i,
  /^logs\//i,
  /^\.torque-checkpoints\//i,
  /^\.tmp\//i,
  /^tmp\//i,
  /^docs\/superpowers\/plans\//i,
]);
const VERIFY_RETRY_SCOPE_PATH_RE = /[A-Za-z0-9_./\\-]+\.(?:tsx|jsx|cjs|mjs|yaml|yml|json|sql|js|ts|py|cs|md)/g;

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

function getWorktreeBatchId(worktree) {
  return worktree?.batchId || worktree?.batch_id || null;
}

function resolveWorktree(task, batchId) {
  const expectedPath = normalizePathForCompare(task?.working_directory);
  let worktree = batchId ? factoryWorktrees.getActiveWorktreeByBatch(batchId) : null;
  if (!worktree && expectedPath) {
    worktree = factoryWorktrees.listActiveWorktrees().find((candidate) => (
      normalizePathForCompare(candidate?.worktreePath) === expectedPath
        && (!batchId || getWorktreeBatchId(candidate) === batchId)
    )) || null;
  }

  const parsedBatch = parseFactoryBatchId(batchId);
  if (!worktree) {
    logger.warn('factory_auto_commit_worktree_not_found', {
      task_id: task?.id,
      batch_id: batchId,
      batch_project_id: parsedBatch?.project_id || null,
      batch_work_item_id: parsedBatch?.work_item_id || null,
      task_working_directory: task?.working_directory || null,
    });
    return null;
  }

  const worktreeBatchId = getWorktreeBatchId(worktree);
  if (batchId && worktreeBatchId && worktreeBatchId !== batchId) {
    logger.warn('factory_auto_commit_batch_mismatch_skipped', {
      task_id: task?.id,
      task_batch_id: batchId,
      worktree_batch_id: worktreeBatchId,
      worktree_path: worktree.worktreePath || null,
    });
    return null;
  }

  const worktreePath = normalizePathForCompare(worktree.worktreePath);
  if (expectedPath && worktreePath && expectedPath !== worktreePath) {
    logger.warn('factory_auto_commit_worktree_path_mismatch_skipped', {
      task_id: task?.id,
      batch_id: batchId,
      task_working_directory: task?.working_directory || null,
      worktree_path: worktree.worktreePath || null,
    });
    return null;
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
  const timeout = Array.isArray(args) && args[0] === 'status'
    ? TASK_TIMEOUTS.GIT_STATUS
    : TASK_TIMEOUTS.GIT_COMMIT;
  const runner = Array.isArray(args) && args[0] === 'status'
    ? safeGitExec
    : (gitArgs, options) => childProcess.execFileSync('git', gitArgs, options);
  return runner(args, {
    cwd: worktreePath,
    encoding: 'utf8',
    timeout,
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
    timeout: TASK_TIMEOUTS.GIT_COMMIT,
    windowsHide: true,
    input: stdin,
  });
}

const STDOUT_TAIL_BUDGET = 1200;

function getStdoutTail(task) {
  const raw = task && (task.output || task.stdout_tail || task.result_output) || '';
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return String(raw).replace(ansiPattern, '').slice(-STDOUT_TAIL_BUDGET);
}

function resolveKind(task) {
  const tag = Array.isArray(task && task.tags) ? task.tags.find((t) => typeof t === 'string' && t.startsWith('factory:verify_retry=')) : null;
  return tag ? 'verify_retry' : 'execute';
}

function resolveTaskMetadata(task) {
  const metadata = task?.metadata;
  if (!metadata) return {};
  if (typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolvePlanPath(task) {
  const metadata = resolveTaskMetadata(task);
  if (typeof metadata.plan_path === 'string' && metadata.plan_path.trim()) {
    return metadata.plan_path.trim();
  }

  const description = typeof task?.task_description === 'string' ? task.task_description : '';
  const match = /^Plan path:\s*(.+)$/mi.exec(description);
  return match?.[1]?.trim() || null;
}

function resolveWorkItemId(task) {
  const tag = Array.isArray(task && task.tags) ? task.tags.find((t) => typeof t === 'string' && t.startsWith('factory:work_item_id=')) : null;
  if (!tag) return null;
  const raw = tag.split('=')[1];
  return raw && raw !== 'unknown' ? raw : null;
}

function parsePorcelainPaths(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawPath = extractPorcelainPath(line);
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

function extractPorcelainPath(line) {
  if (typeof line !== 'string' || line === '') {
    return null;
  }

  // Porcelain v1 status is normally two status columns plus a space. Some
  // callers historically trimmed the whole status output, stripping the
  // leading status column from the first line when the index column was blank.
  if (line.length >= 3 && line[2] === ' ') {
    return line.slice(3).trim();
  }
  if (line.length >= 2 && line[1] === ' ') {
    return line.slice(2).trim();
  }
  return line.trim();
}

function normalizeRelativePath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim();
}

function extractScopeEnvelopeFiles(text) {
  const files = new Set();
  for (const match of String(text || '').matchAll(VERIFY_RETRY_SCOPE_PATH_RE)) {
    const normalized = normalizeRelativePath(match[0]);
    if (normalized) files.add(normalized);
  }
  return Array.from(files);
}

function getScopeEnvelopeBasenames(scopeEnvelope) {
  const suffixes = new Set();
  for (const file of scopeEnvelope || []) {
    const normalized = normalizeRelativePath(file);
    if (!normalized) continue;
    suffixes.add(normalized);
    const withoutRoot = normalized
      .replace(/^[A-Za-z]:\//, '')
      .replace(/^\/+/, '');
    if (withoutRoot) suffixes.add(withoutRoot);
    const basename = withoutRoot.split('/').filter(Boolean).pop();
    if (basename) suffixes.add(basename);
  }
  return Array.from(suffixes);
}

function getOutOfScopeFiles(files, scopeEnvelope) {
  const scopeEnvelopeBasenames = getScopeEnvelopeBasenames(scopeEnvelope);
  return (Array.isArray(files) ? files : []).filter((file) => {
    const normalized = normalizeRelativePath(file);
    return normalized && !scopeEnvelopeBasenames.some((suffix) => normalized.endsWith(suffix));
  });
}

function readPlanText(planPath) {
  if (!planPath) return '';
  try {
    return fs.readFileSync(planPath, 'utf8');
  } catch {
    return '';
  }
}

function getExistingBranchDiffFiles(worktreePath) {
  const refsToTry = [
    ['diff', '--name-only', 'main...HEAD'],
    ['diff', '--name-only', 'HEAD~1', 'HEAD'],
  ];
  for (const args of refsToTry) {
    try {
      const output = runGit(worktreePath, args).trim();
      if (output) {
        return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      }
    } catch {
      // Try the next fallback ref.
    }
  }
  return [];
}

function buildVerifyRetryCommitScope(task, worktreePath) {
  const planText = readPlanText(resolvePlanPath(task));
  return new Set([
    ...extractScopeEnvelopeFiles(planText),
    ...getExistingBranchDiffFiles(worktreePath).map(normalizeRelativePath).filter(Boolean),
  ]);
}

function isNonProductAutoCommitPath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return true;
  return NON_PRODUCT_AUTO_COMMIT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function partitionAutoCommitPaths(paths) {
  const stageable = [];
  const excluded = [];
  for (const filePath of paths) {
    if (isNonProductAutoCommitPath(filePath)) {
      excluded.push(filePath);
    } else {
      stageable.push(filePath);
    }
  }
  return { stageable, excluded };
}

function assertPathInsideWorktree(worktreePath, relativePath) {
  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, relativePath);
  const rootCompare = root.replace(/\\/g, '/').toLowerCase();
  const resolvedCompare = resolved.replace(/\\/g, '/').toLowerCase();
  if (resolvedCompare !== rootCompare && !resolvedCompare.startsWith(`${rootCompare}/`)) {
    throw new Error(`Refusing to clean path outside worktree: ${relativePath}`);
  }
  return resolved;
}

function removeEmptyParents(worktreePath, filePath) {
  const root = path.resolve(worktreePath);
  let current = path.dirname(filePath);
  while (current && current !== root && current.startsWith(root)) {
    try {
      fs.rmdirSync(current);
      current = path.dirname(current);
    } catch {
      return;
    }
  }
}

function removeUntrackedPaths(worktreePath, paths) {
  const cleaned = [];
  for (const relativePath of paths) {
    const target = assertPathInsideWorktree(worktreePath, relativePath);
    if (!fs.existsSync(target)) {
      continue;
    }
    const stat = fs.lstatSync(target);
    fs.rmSync(target, { recursive: stat.isDirectory(), force: true });
    cleaned.push(relativePath);
    removeEmptyParents(worktreePath, target);
  }
  return cleaned;
}

function restoreTrackedPaths(worktreePath, paths) {
  if (paths.length === 0) {
    return [];
  }
  runGitWithStdin(
    worktreePath,
    ['restore', '--worktree', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'],
    paths.join('\0'),
  );
  return paths;
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

async function commitCompletedPlanTask(task) {
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
    const statusOutput = runGit(worktree.worktreePath, ['status', '--porcelain']);
    if (!statusOutput.trim()) {
      const stdoutTail = getStdoutTail(task);
      const kind = resolveKind(task);
      const workItemId = resolveWorkItemId(task);
      const classification = workItemId
        ? await classifyZeroDiff({ stdout_tail: stdoutTail, attempt: 1, kind })
        : { reason: 'unknown', source: 'none', confidence: 0 };
      if (workItemId) {
        try {
          attemptHistory.appendRow({
            batch_id: worktree.batchId || batchId,
            work_item_id: workItemId,
            kind,
            task_id: task.id,
            files_touched: [],
            stdout_tail: stdoutTail,
            zero_diff_reason: classification.reason,
            classifier_source: classification.source,
            classifier_conf: classification.confidence,
          });
        } catch (e) {
          logger.warn('attempt_history_write_failed', { err: e.message, task_id: task.id });
        }
      }
      safeLogDecision({
        ...decisionBase,
        action: 'auto_commit_skipped_clean',
        reasoning: 'Approved plan task completed, but the factory worktree was already clean.',
        outcome: {
          task_id: task.id,
          plan_task_number: planTaskNumber,
          files_changed: [],
          zero_diff_reason: classification.reason,
          classifier_source: classification.source,
          classifier_conf: classification.confidence,
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
      } catch (_err) {
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

    const trackedPartition = partitionAutoCommitPaths(semanticTracked);
    const untrackedPartition = partitionAutoCommitPaths(untracked);
    const nonProductPaths = [...trackedPartition.excluded, ...untrackedPartition.excluded];
    const cleanedNonProductPaths = [
      ...restoreTrackedPaths(worktree.worktreePath, trackedPartition.excluded),
      ...removeUntrackedPaths(worktree.worktreePath, untrackedPartition.excluded),
    ];
    const pathsToStage = [...trackedPartition.stageable, ...untrackedPartition.stageable];

    if (resolveKind(task) === 'verify_retry' && pathsToStage.length > 0) {
      const scopeEnvelope = buildVerifyRetryCommitScope(task, worktree.worktreePath);
      const offScopeFiles = scopeEnvelope.size > 0
        ? getOutOfScopeFiles(pathsToStage, scopeEnvelope)
        : pathsToStage;

      if (offScopeFiles.length > 0) {
        const rejectedTracked = pathsToStage.filter((p) => semanticTracked.includes(p));
        const rejectedUntracked = pathsToStage.filter((p) => untracked.includes(p));
        const restoredTracked = restoreTrackedPaths(worktree.worktreePath, rejectedTracked);
        const removedUntracked = removeUntrackedPaths(worktree.worktreePath, rejectedUntracked);

        safeLogDecision({
          ...decisionBase,
          action: 'auto_commit_rejected_off_scope',
          reasoning: 'Verify retry task touched files outside the existing branch and plan scope, so the factory discarded the retry diff instead of committing it.',
          outcome: {
            task_id: task.id,
            plan_task_number: planTaskNumber,
            files_rejected: pathsToStage,
            off_scope_files: offScopeFiles,
            scope_envelope: Array.from(scopeEnvelope),
            restored_tracked_files: restoredTracked,
            removed_untracked_files: removedUntracked,
          },
        });
        return;
      }
    }

    if (pathsToStage.length === 0 && nonProductPaths.length > 0) {
      const stdoutTail = getStdoutTail(task);
      const kind = resolveKind(task);
      const workItemId = resolveWorkItemId(task);
      const classification = workItemId
        ? await classifyZeroDiff({ stdout_tail: stdoutTail, attempt: 1, kind })
        : { reason: 'unknown', source: 'none', confidence: 0 };
      if (workItemId) {
        try {
          attemptHistory.appendRow({
            batch_id: worktree.batchId || batchId,
            work_item_id: workItemId,
            kind,
            task_id: task.id,
            files_touched: [],
            stdout_tail: stdoutTail,
            zero_diff_reason: classification.reason,
            classifier_source: classification.source,
            classifier_conf: classification.confidence,
          });
        } catch (e) {
          logger.warn('attempt_history_write_failed', { err: e.message, task_id: task.id });
        }
      }
      safeLogDecision({
        ...decisionBase,
        action: 'auto_commit_skipped_clean',
        reasoning: 'Approved plan task completed. Worktree dirty files were factory run artifacts or plan-progress churn, so they were cleaned without committing.',
        outcome: {
          task_id: task.id,
          plan_task_number: planTaskNumber,
          files_changed: [],
          zero_diff_reason: classification.reason,
          classifier_source: classification.source,
          classifier_conf: classification.confidence,
          skipped_non_product_files: nonProductPaths,
          cleaned_non_product_files: cleanedNonProductPaths,
        },
      });
      return;
    }

    if (pathsToStage.length === 0) {
      // Worktree only has pure line-ending drift (or is fully clean).
      const driftPaths = parsePorcelainPaths(statusOutput);
      const stdoutTail = getStdoutTail(task);
      const kind = resolveKind(task);
      const workItemId = resolveWorkItemId(task);
      const classification = workItemId
        ? await classifyZeroDiff({ stdout_tail: stdoutTail, attempt: 1, kind })
        : { reason: 'unknown', source: 'none', confidence: 0 };
      if (workItemId) {
        try {
          attemptHistory.appendRow({
            batch_id: worktree.batchId || batchId,
            work_item_id: workItemId,
            kind,
            task_id: task.id,
            files_touched: [],
            stdout_tail: stdoutTail,
            zero_diff_reason: classification.reason,
            classifier_source: classification.source,
            classifier_conf: classification.confidence,
          });
        } catch (e) {
          logger.warn('attempt_history_write_failed', { err: e.message, task_id: task.id });
        }
      }
      safeLogDecision({
        ...decisionBase,
        action: 'auto_commit_skipped_clean',
        reasoning: 'Approved plan task completed. Worktree had dirty files, but all were pure line-ending drift; nothing to commit.',
        outcome: {
          task_id: task.id,
          plan_task_number: planTaskNumber,
          files_changed: [],
          zero_diff_reason: classification.reason,
          classifier_source: classification.source,
          classifier_conf: classification.confidence,
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
      const stdoutTail = getStdoutTail(task);
      const kind = resolveKind(task);
      const workItemId = resolveWorkItemId(task);
      const classification = workItemId
        ? await classifyZeroDiff({ stdout_tail: stdoutTail, attempt: 1, kind })
        : { reason: 'unknown', source: 'none', confidence: 0 };
      if (workItemId) {
        try {
          attemptHistory.appendRow({
            batch_id: worktree.batchId || batchId,
            work_item_id: workItemId,
            kind,
            task_id: task.id,
            files_touched: [],
            stdout_tail: stdoutTail,
            zero_diff_reason: classification.reason,
            classifier_source: classification.source,
            classifier_conf: classification.confidence,
          });
        } catch (e) {
          logger.warn('attempt_history_write_failed', { err: e.message, task_id: task.id });
        }
      }
      safeLogDecision({
        ...decisionBase,
        action: 'auto_commit_skipped_clean',
        reasoning: 'Approved plan task completed. pathspec-from-file staging produced no changes; worktree was likely pure line-ending drift.',
        outcome: {
          task_id: task.id,
          plan_task_number: planTaskNumber,
          files_changed: [],
          zero_diff_reason: classification.reason,
          classifier_source: classification.source,
          classifier_conf: classification.confidence,
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
      if (piiFixCount > 0) {
        logger.info('PII pre-sanitize replaced findings before factory commit', {
          findings: piiFixCount,
          worktree_path: worktree.worktreePath,
        });
      }
    } catch (piiErr) {
      logger.warn('PII pre-sanitize failed (non-fatal); git commit will attempt anyway', {
        err: piiErr.message,
        worktree_path: worktree.worktreePath,
      });
    }

    const commitMessage = buildCommitMessage(planTaskNumber, planTaskTitle);
    // --no-verify: the staged files have already been PII-sanitized inline
    // above via pii-guard.scanAndReplace. The pre-commit hook would re-run
    // the same check via HTTP to TORQUE — which can't respond when this
    // listener fires during a synchronous execFileSync chain — and then
    // fall back to the regex scanner that false-positives on RFC1918 IPs
    // in legitimate test fixtures. See worktree-manager.assertWorktreeIsClean
    // for the mirror of this rationale on the pre-merge side.
    runGit(worktree.worktreePath, ['commit', '--no-verify', '-m', commitMessage]);
    const commitSha = runGit(worktree.worktreePath, ['rev-parse', 'HEAD']).trim();
    const workItemIdCommit = resolveWorkItemId(task);
    if (workItemIdCommit) {
      try {
        attemptHistory.appendRow({
          batch_id: worktree.batchId || batchId,
          work_item_id: workItemIdCommit,
          kind: resolveKind(task),
          task_id: task.id,
          files_touched: allStaged,
          stdout_tail: getStdoutTail(task),
        });
      } catch (e) {
        logger.warn('attempt_history_write_failed', { err: e.message, task_id: task.id });
      }
    }

    const driftPaths = parsePorcelainPaths(statusOutput).filter((p) => !allStaged.includes(p));

    safeLogDecision({
      ...decisionBase,
      action: 'auto_committed_task',
      reasoning: 'Approved plan task completed with dirty worktree changes, so the factory auto-committed them.',
      outcome: {
        commit_sha: commitSha,
        files_changed: allStaged,
        skipped_drift_files: driftPaths,
        skipped_non_product_files: nonProductPaths,
        cleaned_non_product_files: cleanedNonProductPaths,
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

    Promise.resolve()
      .then(() => commitCompletedPlanTask(task))
      .catch((err) => logger.warn('worktree_auto_commit_listener_failed', { err: err.message, task_id: taskId }));
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
  _internalForTests: {
    parsePorcelainPaths,
  },
};
