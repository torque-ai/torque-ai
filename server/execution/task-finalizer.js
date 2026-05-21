'use strict';

/**
 * Canonical task finalization path.
 *
 * All close/error handlers should route terminalization through finalizeTask()
 * so validation, fallback checks, metadata recording, and completion/failure
 * event emission happen exactly once.
 */

const logger = require('../logger').child({ component: 'task-finalizer' });
const { AsyncLocalStorage } = require('async_hooks');
const modelCapabilities = require('../db/model-capabilities');
const perfTracker = require('../db/provider/performance');
const { recordStudyTaskCompleted } = require('../db/study-telemetry');
const { smartDiagnosisStage } = require('./smart-diagnosis-stage');
const { strategicReviewStage } = require('./strategic-review-stage');
const { createVerificationLedgerStage } = require('./verification-ledger-stage');
const { createAdversarialReviewStage } = require('./adversarial-review-stage');
const { runPhantomSuccessDetection, runCodexBannerOnlyDetection } = require('../validation/phantom-success-detector');
const { parseDiffusionSignal } = require('../diffusion/signal-parser');
const { parseComputeOutput, validateComputeSchema } = require('../diffusion/compute-output-parser');
const { expandApplyTaskDescription } = require('../diffusion/planner');
const { matchHeuristic: matchZeroDiffHeuristic } = require('../factory/completion-rationale');
const { safeJsonParse } = require('../utils/json');
const resumeContextUtils = require('../utils/resume-context');
const {
  createSharedFactoryStore,
  deriveLearningScope,
  deriveVerifyFailurePattern,
  DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE,
  DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
} = require('../db/shared-factory-store');
const { v4: uuidv4 } = require('uuid');

// ── Legacy module-level state, written only by init() (deprecated) ─────────
// Phase 3 of the universal-DI migration. Replaces the prior stub
// createTaskFinalizer factory with one that actually closes over getDeps().
let deps = {};
let handleVerificationLedger = null;
let handleAdversarialReview = null;
const scopedDeps = new AsyncLocalStorage();
const finalizationLocks = new Map();
let ownedSharedFactoryStore = null;

function getDeps() {
  return scopedDeps.getStore()?.deps || deps;
}

function getScopedVerificationLedger() {
  return scopedDeps.getStore()?.handleVerificationLedger || handleVerificationLedger;
}

function getScopedAdversarialReview() {
  return scopedDeps.getStore()?.handleAdversarialReview || handleAdversarialReview;
}

const DEFAULT_STAGE_TIMEOUT_MS = 120000;
const STAGE_TIMEOUT_MS = {
  build_test_style_commit: 300000,
  auto_verify_retry: 31 * 60 * 1000,
  factory_worktree_hygiene: 120000,
  verification_ledger: 120000,
  adversarial_review: 120000,
  smart_diagnosis: 60000,
  strategic_review: 60000,
  provider_failover: 120000,
};

function resetForTest() {
  if (ownedSharedFactoryStore && typeof ownedSharedFactoryStore.close === 'function') {
    try { ownedSharedFactoryStore.close(); } catch { /* non-fatal */ }
  }
  ownedSharedFactoryStore = null;
  deps = {};
  handleVerificationLedger = null;
  handleAdversarialReview = null;
  finalizationLocks.clear();
}

/**
 * @internal — test-only override path. Production resolves via
 * createTaskFinalizer(localDeps) inside the container factory.
 */
function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
  if (getDeps().db && typeof getDeps().db.getDbInstance === 'function') {
    perfTracker.setDb(getDeps().db);
  }

  handleVerificationLedger = typeof getDeps().handleVerificationLedger === 'function' ? getDeps().handleVerificationLedger : handleVerificationLedger;
  handleAdversarialReview = typeof getDeps().handleAdversarialReview === 'function' ? getDeps().handleAdversarialReview : handleAdversarialReview;

  try {
    const { defaultContainer } = require('../container');
    if (typeof handleVerificationLedger !== 'function' && defaultContainer && typeof defaultContainer.has === 'function' && typeof defaultContainer.get === 'function') {
      const vl = defaultContainer.has('verificationLedger') ? defaultContainer.get('verificationLedger') : null;
      const pc = defaultContainer.has('projectConfigCore') ? defaultContainer.get('projectConfigCore') : null;
      if (vl && pc) {
        handleVerificationLedger = createVerificationLedgerStage({
          verificationLedger: vl,
          projectConfigCore: pc,
        });
      }
    }
  } catch (_) {
    // not available
  }

  try {
    const { defaultContainer } = require('../container');
    if (typeof handleAdversarialReview !== 'function' && defaultContainer && typeof defaultContainer.has === 'function' && typeof defaultContainer.get === 'function') {
      const ar = defaultContainer.has('adversarialReviews') ? defaultContainer.get('adversarialReviews') : null;
      const fra = defaultContainer.has('fileRiskAdapter') ? defaultContainer.get('fileRiskAdapter') : null;
      const tc = defaultContainer.has('taskCore') ? defaultContainer.get('taskCore') : null;
      const tm = defaultContainer.has('taskManager') ? defaultContainer.get('taskManager') : null;
      const pc = defaultContainer.has('projectConfigCore') ? defaultContainer.get('projectConfigCore') : null;
      if (ar && fra && tc && tm && pc) {
        handleAdversarialReview = createAdversarialReviewStage({
          adversarialReviews: ar,
          fileRiskAdapter: fra,
          taskCore: tc,
          taskManager: tm,
          verificationLedger: defaultContainer.has('verificationLedger') ? defaultContainer.get('verificationLedger') : null,
          projectConfigCore: pc,
        });
      }
    }
  } catch (_err) {
    // not available
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFinalizableStatus(status) {
  return status === 'running' || status === 'completion_pending';
}

function normalizeExitCode(exitCode) {
  if (exitCode === 0 || exitCode === '0') return 0;
  const parsed = Number.parseInt(exitCode, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function buildCombinedOutput(output, errorOutput) {
  if (output && errorOutput) return `${output}\n${errorOutput}`;
  return output || errorOutput || '';
}

function appendErrorOutput(current, message) {
  if (!message) return current || '';
  if (!current) return message;
  return `${current}\n${message}`;
}

function normalizeTaskTags(value) {
  if (Array.isArray(value)) return value.map(tag => String(tag).trim()).filter(Boolean);
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(tag => String(tag).trim()).filter(Boolean);
    }
  } catch {
    // Fall back to comma-separated legacy tags.
  }
  return value.split(',').map(tag => tag.trim()).filter(Boolean);
}

function getFactoryTagValue(tags, prefix) {
  const tag = tags.find(candidate => candidate.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === 'object' && rawMetadata !== null) return { ...rawMetadata };
  if (typeof rawMetadata !== 'string') return {};
  try {
    const parsed = JSON.parse(rawMetadata);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function mergeTaskMetadata(task, ctx) {
  return {
    ...parseMetadata(task?.metadata),
    ...parseMetadata(ctx?.task?.metadata),
  };
}

function parseFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFiniteNumber(candidates) {
  for (const candidate of candidates) {
    const numeric = parseFiniteNumber(candidate);
    if (numeric !== null) return numeric;
  }
  return null;
}

function normalizeQualityScore(value) {
  const numeric = parseFiniteNumber(value);
  if (numeric === null) return null;
  const normalized = numeric > 1 ? numeric / 100 : numeric;
  if (normalized <= 0) return 0;
  if (normalized >= 1) return 1;
  return normalized;
}

function parseTimestampMs(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getProviderScoringService() {
  if (getDeps().providerScoring && typeof getDeps().providerScoring.recordTaskCompletion === 'function') {
    return getDeps().providerScoring;
  }
  return require('../db/provider/scoring');
}

function getRawDbInstance() {
  if (getDeps().rawDb && typeof getDeps().rawDb.prepare === 'function') return getDeps().rawDb;
  if (getDeps().db && typeof getDeps().db.getDbInstance === 'function') return getDeps().db.getDbInstance();
  if (getDeps().db && typeof getDeps().db.prepare === 'function') return getDeps().db;

  try {
    const { getModule } = require('../container');
    const injectedDb = getModule('db');
    if (injectedDb && typeof injectedDb.getDbInstance === 'function') {
      return injectedDb.getDbInstance();
    }
    return injectedDb && typeof injectedDb.prepare === 'function' ? injectedDb : null;
  } catch (_err) {
    return null;
  }
}

function readDbConfig(key) {
  if (!getDeps().db || typeof getDeps().db.getConfig !== 'function') return null;
  try { return getDeps().db.getConfig(key); } catch { return null; }
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getStageTimeoutMs(name) {
  const stageOverride = parsePositiveInteger(readDbConfig(`finalizer_stage_${name}_timeout_ms`));
  if (stageOverride !== null) return stageOverride;
  const globalOverride = parsePositiveInteger(readDbConfig('finalizer_stage_timeout_ms'));
  if (globalOverride !== null) return globalOverride;
  return STAGE_TIMEOUT_MS[name] || DEFAULT_STAGE_TIMEOUT_MS;
}

function createStageTimeoutError(name, timeoutMs) {
  const err = new Error(`finalizer stage ${name} timed out after ${timeoutMs}ms`);
  err.code = 'FINALIZER_STAGE_TIMEOUT';
  err.stage = name;
  err.timeoutMs = timeoutMs;
  return err;
}

function runWithStageTimeout(name, timeoutMs, handlerPromise) {
  if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(handlerPromise);
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(createStageTimeoutError(name, timeoutMs)), timeoutMs);
    if (typeof timeoutId?.unref === 'function') timeoutId.unref();
  });
  return Promise.race([Promise.resolve(handlerPromise), timeoutPromise])
    .finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isTruthyMetadataFlag(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function taskExplicitlyReadOnlyForNoFileDetection(task, metadata) {
  const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
  if (
    isTruthyMetadataFlag(safeMetadata.read_only)
    || isTruthyMetadataFlag(safeMetadata.readOnly)
    || isTruthyMetadataFlag(safeMetadata.agentic_read_only)
  ) {
    return true;
  }

  const taskDescription = String(task?.task_description || '');
  return /\b(?:read-only|readonly)\b/i.test(taskDescription)
    || /\b(?:do not|don't)\s+(?:edit|create|delete|modify|write|move|format|change|update)\b[^.!\n\r]*\bfiles?\b/i.test(taskDescription)
    || /\bno\s+(?:file\s+)?(?:edits?|changes?|writes?|modifications?)\b/i.test(taskDescription);
}

function isFactoryBatchExecutionTask(task, metadata) {
  if (metadata?.factory_internal === true) return false;
  const tags = normalizeTaskTags(task?.tags);
  return tags.some(tag => tag.startsWith('factory:batch_id=factory-'))
    || tags.some(tag => tag.startsWith('factory:plan_task_number='));
}

function shouldFailCompletedFactoryNoChange(ctx) {
  if (!ctx || ctx.status !== 'completed' || ctx.code !== 0) return false;
  if (Array.isArray(ctx.filesModified) && ctx.filesModified.length > 0) return false;

  const task = ctx.task || {};
  const metadata = mergeTaskMetadata(task, ctx);
  if (!isFactoryBatchExecutionTask(task, metadata)) return false;
  if (taskExplicitlyReadOnlyForNoFileDetection(task, metadata)) return false;
  const zeroDiffSignal = matchZeroDiffHeuristic(buildCombinedOutput(ctx.output, ctx.errorOutput));
  if (zeroDiffSignal?.reason === 'already_in_place' && zeroDiffSignal.confidence >= 0.8) {
    return false;
  }

  return true;
}

function isMeaningfulGitStatusFile(entry) {
  if (!entry || entry.isDeleted) return false;
  if (!(entry.isModified || entry.isNew || entry.isRenamed || entry.indexStatus === 'A')) {
    return false;
  }
  const filePath = String(entry.filePath || '').replace(/\\/g, '/');
  return Boolean(filePath)
    && !filePath.endsWith('.db')
    && !filePath.startsWith('.git/')
    && filePath !== '.gitignore';
}

function readActualChangedFiles(task) {
  const workingDirectory = typeof task?.working_directory === 'string'
    ? task.working_directory.trim()
    : '';
  if (!workingDirectory) return [];

  if (typeof getDeps().getActualModifiedFilesForNoFileDetection === 'function') {
    try {
      const files = getDeps().getActualModifiedFilesForNoFileDetection(workingDirectory, task);
      return Array.isArray(files) ? files.filter(Boolean) : [];
    } catch (err) {
      logger.debug(`[finalizer] Actual modified-file probe failed for ${task.id}: ${err.message}`);
      return [];
    }
  }

  try {
    const { getModifiedFiles } = require('../utils/git');
    return getModifiedFiles(workingDirectory)
      .filter(isMeaningfulGitStatusFile)
      .map((entry) => String(entry.filePath || '').replace(/\\/g, '/'))
      .filter(Boolean);
  } catch (err) {
    logger.debug(`[finalizer] Git status modified-file probe failed for ${task?.id || 'unknown'}: ${err.message}`);
    return [];
  }
}

function normalizeFactoryGitPath(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/');
}

function collectMetadataFileList(metadata, keys) {
  const files = [];
  for (const key of keys) {
    const value = metadata?.[key];
    if (Array.isArray(value)) {
      files.push(...value);
    } else if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          files.push(...parsed);
          continue;
        }
      } catch {
        // Fall through to line/comma splitting below.
      }
      files.push(...value.split(/[\r\n,]+/));
    }
  }
  return files;
}

function collectFactoryTaskAllowedFiles(ctx) {
  const task = ctx?.task || {};
  const metadata = mergeTaskMetadata(task, ctx);
  const allowed = new Set();
  const add = (candidate) => {
    const normalized = normalizeFactoryGitPath(candidate);
    if (normalized) allowed.add(normalized);
  };

  for (const file of Array.isArray(ctx?.filesModified) ? ctx.filesModified : []) {
    add(file);
  }
  for (const file of collectMetadataFileList(metadata, [
    'target_files',
    'targetFiles',
    'files',
    'files_modified',
    'filesModified',
    'plan_target_files',
    'planTargetFiles',
  ])) {
    add(file);
  }

  try {
    const { extractFileReferencesExpanded } = require('../utils/file-resolution');
    for (const file of extractFileReferencesExpanded(task.task_description || '')) {
      add(file);
    }
  } catch (err) {
    logger.debug(`[finalizer] Factory target-file extraction failed for ${task.id || 'unknown'}: ${err.message}`);
  }

  return allowed;
}

function isAllowedFactoryDirtyFile(filePath, allowedFiles) {
  const file = normalizeFactoryGitPath(filePath);
  if (!file || allowedFiles.has(file)) return Boolean(file);
  for (const allowed of allowedFiles) {
    if (!allowed) continue;
    if (file === allowed) return true;
    if (!allowed.includes('/') && file.endsWith(`/${allowed}`)) return true;
  }
  return false;
}

function readTrackedDirtyFilesForFactoryHygiene(task) {
  const workingDirectory = typeof task?.working_directory === 'string'
    ? task.working_directory.trim()
    : '';
  if (!workingDirectory) return [];

  if (typeof getDeps().getActualModifiedFilesForFactoryHygiene === 'function') {
    try {
      const files = getDeps().getActualModifiedFilesForFactoryHygiene(workingDirectory, task);
      return Array.isArray(files) ? files.map(normalizeFactoryGitPath).filter(Boolean) : [];
    } catch (err) {
      logger.debug(`[finalizer] Factory hygiene modified-file probe failed for ${task.id}: ${err.message}`);
      return [];
    }
  }

  try {
    const { getModifiedFiles } = require('../utils/git');
    return getModifiedFiles(workingDirectory)
      .filter((entry) => {
        if (!entry || entry.isNew || entry.isRenamed) return false;
        return entry.isModified || entry.isDeleted;
      })
      .map((entry) => normalizeFactoryGitPath(entry.filePath))
      .filter(Boolean);
  } catch (err) {
    logger.debug(`[finalizer] Factory hygiene git status failed for ${task.id || 'unknown'}: ${err.message}`);
    return [];
  }
}

function restoreFactoryWorktreeFiles(workingDirectory, files) {
  const normalizedFiles = Array.from(new Set(
    (Array.isArray(files) ? files : [])
      .map(normalizeFactoryGitPath)
      .filter(Boolean)
  ));
  if (!workingDirectory || normalizedFiles.length === 0) return;

  if (typeof getDeps().restoreFactoryWorktreeFiles === 'function') {
    getDeps().restoreFactoryWorktreeFiles(workingDirectory, normalizedFiles);
    return;
  }

  const { safeGitExec, invalidateFingerprintCache } = require('../utils/git');
  const chunkSize = 40;
  for (let index = 0; index < normalizedFiles.length; index += chunkSize) {
    const chunk = normalizedFiles.slice(index, index + chunkSize);
    safeGitExec(['restore', '--staged', '--worktree', '--', ...chunk], {
      cwd: workingDirectory,
      timeout: 30000,
    });
  }
  if (typeof invalidateFingerprintCache === 'function') {
    invalidateFingerprintCache(workingDirectory);
  }
}

function logFactoryWorktreeHygieneDecision(ctx, restoredFiles, allowedFiles) {
  if (typeof getDeps().logFactoryDecision !== 'function') return;
  const tags = normalizeTaskTags(ctx.task?.tags);
  const batchId = getFactoryTagValue(tags, 'factory:batch_id=');
  const workItemId = getFactoryTagValue(tags, 'factory:work_item_id=');
  const projectId = normalizeText(ctx.task?.factory_project_id)
    || normalizeText(ctx.task?.project_id)
    || normalizeText(mergeTaskMetadata(ctx.task, ctx).factory_project_id)
    || (batchId ? batchId.match(/^factory-([0-9a-f-]{36})-/i)?.[1] : null)
    || null;
  try {
    getDeps().logFactoryDecision({
      project_id: projectId,
      stage: 'execute',
      actor: 'executor',
      action: 'restored_unscoped_worktree_changes',
      batch_id: batchId,
      task_id: ctx.taskId,
      work_item_id: workItemId,
      reasoning: 'Factory execution task had dirty tracked files outside the task-reported or target-file scope before verification.',
      outcome: {
        restored_files: restoredFiles,
        allowed_files: Array.from(allowedFiles),
      },
    });
  } catch (err) {
    logger.debug(`[finalizer] Failed to log factory worktree hygiene decision: ${err.message}`);
  }
}

function sanitizeFactoryPlanWorktreeDirtyFiles(ctx) {
  if (!ctx || ctx.status !== 'completed' || ctx.code !== 0) return;
  const task = ctx.task || {};
  const metadata = mergeTaskMetadata(task, ctx);
  if (!isFactoryBatchExecutionTask(task, metadata)) return;
  if (taskExplicitlyReadOnlyForNoFileDetection(task, metadata)) return;

  const allowedFiles = collectFactoryTaskAllowedFiles(ctx);
  if (allowedFiles.size === 0) return;

  const dirtyFiles = readTrackedDirtyFilesForFactoryHygiene(task);
  if (dirtyFiles.length === 0) return;

  const staleFiles = dirtyFiles.filter(file => !isAllowedFactoryDirtyFile(file, allowedFiles));
  if (staleFiles.length === 0) return;

  restoreFactoryWorktreeFiles(task.working_directory, staleFiles);
  const staleSet = new Set(staleFiles.map(normalizeFactoryGitPath));
  ctx.filesModified = (Array.isArray(ctx.filesModified) ? ctx.filesModified : [])
    .map(normalizeFactoryGitPath)
    .filter(file => file && !staleSet.has(file));
  ctx.factoryWorktreeHygiene = {
    restoredFiles: staleFiles,
    allowedFiles: Array.from(allowedFiles),
  };
  logger.info(`[finalizer] Task ${ctx.taskId}: restored ${staleFiles.length} unscoped factory worktree file(s) before verification`);
  logFactoryWorktreeHygieneDecision(ctx, staleFiles, allowedFiles);
}

function augmentFactoryFilesModifiedFromGitStatus(ctx) {
  if (!ctx || ctx.status !== 'completed' || ctx.code !== 0) return;
  const task = ctx.task || {};
  const metadata = mergeTaskMetadata(task, ctx);
  if (!isFactoryBatchExecutionTask(task, metadata)) return;

  const actualFiles = readActualChangedFiles(task);
  if (actualFiles.length === 0) return;

  const combined = new Set(Array.isArray(ctx.filesModified) ? ctx.filesModified : []);
  for (const file of actualFiles) combined.add(file);
  ctx.filesModified = Array.from(combined);
}

function logFactoryNoFileChangeDecision(ctx, tags) {
  if (typeof getDeps().logFactoryDecision !== 'function') return;
  const batchId = getFactoryTagValue(tags, 'factory:batch_id=');
  const workItemId = getFactoryTagValue(tags, 'factory:work_item_id=');
  const projectId = normalizeText(ctx.task?.factory_project_id)
    || normalizeText(ctx.task?.project_id)
    || normalizeText(mergeTaskMetadata(ctx.task, ctx).factory_project_id)
    || (batchId ? batchId.match(/^factory-([0-9a-f-]{36})-/i)?.[1] : null)
    || null;
  try {
    getDeps().logFactoryDecision({
      project_id: projectId,
      stage: 'execute',
      actor: 'executor',
      action: 'empty_execution_task_detected',
      batch_id: batchId,
      task_id: ctx.taskId,
      work_item_id: workItemId,
      reasoning: 'Factory execution task completed successfully but reported no modified files.',
    });
  } catch (err) {
    logger.debug(`[finalizer] Failed to log no-file-change factory decision: ${err.message}`);
  }
}

function handleNoFileChangeDetection(ctx) {
  if (!shouldFailCompletedFactoryNoChange(ctx)) return;

  const tags = normalizeTaskTags(ctx.task?.tags);
  const planTaskNumber = getFactoryTagValue(tags, 'factory:plan_task_number=');
  const planTaskText = planTaskNumber ? ` plan task ${planTaskNumber}` : '';
  ctx.status = 'failed';
  ctx.code = 1;
  ctx.noFileChangeFailure = true;
  ctx.errorOutput = appendErrorOutput(
    ctx.errorOutput,
    `[no-file-change] Factory execution${planTaskText} completed with exit code 0 but reported no modified files.`
  );
  logFactoryNoFileChangeDecision(ctx, tags);
}

function getSharedFactoryStore() {
  if (getDeps().sharedFactoryStore) return getDeps().sharedFactoryStore;

  try {
    const { defaultContainer } = require('../container');
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && typeof defaultContainer.get === 'function'
      && defaultContainer.has('sharedFactoryStore')
    ) {
      return defaultContainer.get('sharedFactoryStore');
    }
  } catch (_err) {
    // Container may be unavailable in direct-module tests.
  }

  if (ownedSharedFactoryStore) return ownedSharedFactoryStore;
  try {
    ownedSharedFactoryStore = createSharedFactoryStore({
      config: getDeps().db,
      dataDir: typeof getDeps().db?.getDataDir === 'function' ? getDeps().db.getDataDir() : undefined,
    });
    return ownedSharedFactoryStore;
  } catch (err) {
    logger.debug(`[finalizer] Shared factory store unavailable for claim release: ${err.message}`);
    return null;
  }
}

function resolveTaskProjectId(task) {
  const metadata = parseMetadata(task?.metadata);
  return normalizeText(getDeps().projectId || getDeps().project_id)
    || normalizeText(process.env.TORQUE_FACTORY_PROJECT_ID)
    || normalizeText(readDbConfig('factory_project_id'))
    || normalizeText(readDbConfig('project_id'))
    || normalizeText(metadata.factory_project_id)
    || normalizeText(metadata.project_id)
    || normalizeText(metadata.projectId)
    || normalizeText(task?.project)
    || null;
}

function releaseSharedCodexClaims(taskId, reason, task) {
  const store = getSharedFactoryStore();
  if (!store || typeof store.releaseResourceClaimsForTask !== 'function') return;

  const projectId = resolveTaskProjectId(task);
  const filters = { task_id: taskId, provider: 'codex' };
  try {
    const released = store.releaseResourceClaimsForTask(
      projectId ? { ...filters, project_id: projectId } : filters,
      reason,
    );
    if (projectId && (!Array.isArray(released) || released.length === 0)) {
      store.releaseResourceClaimsForTask(filters, reason);
    }
  } catch (err) {
    logger.info(`[finalizer] Shared Codex claim release failed for ${taskId}: ${err.message}`);
  }
}

function releaseSharedCodexClaimsForEarlyExit(taskId, task, ctx) {
  let currentTask = null;
  try { currentTask = getDeps().db?.getTask?.(taskId) || null; } catch { currentTask = null; }
  releaseSharedCodexClaims(taskId, 'queue_managed', currentTask || ctx?.task || task);
}

function computeProviderFailureConfidence(sampleCount) {
  const numeric = Number(sampleCount);
  const count = Number.isFinite(numeric) ? Math.max(1, Math.trunc(numeric)) : 1;
  return Math.min(0.95, 0.35 + (count * 0.12));
}

function computeVerifyFailureConfidence(sampleCount, categories = []) {
  const numeric = Number(sampleCount);
  const count = Number.isFinite(numeric) ? Math.max(1, Math.trunc(numeric)) : 1;
  const categoryBoost = Array.isArray(categories) && categories.length > 1 ? 0.05 : 0;
  return Math.min(0.98, 0.45 + (count * 0.12) + categoryBoost);
}

function hasVerifyFailureSignal(ctx) {
  if (ctx?.status !== 'failed') return false;

  const output = typeof ctx?.output === 'string' ? ctx.output : '';
  const errorOutput = typeof ctx?.errorOutput === 'string' ? ctx.errorOutput : '';
  const combinedOutput = `${output}\n${errorOutput}`;
  if (/\[auto-verify\]|\bauto[-_ ]?verify\b/i.test(combinedOutput)) return true;
  if (/\bverify\b.{0,80}\b(?:fail|failed|failure|error)\b/i.test(combinedOutput)) return true;
  if (/\b(?:dotnet|npm|pnpm|yarn|pytest|vitest|jest|go test|cargo test)\b.{0,120}\b(?:fail|failed|failure|error)\b/i.test(combinedOutput)) {
    return true;
  }

  const stages = ctx?.validationStages && typeof ctx.validationStages === 'object'
    ? ctx.validationStages
    : {};
  return Object.entries(stages).some(([stageName, stage]) => (
    /verify|validation|build_test|test|style/i.test(stageName)
    && stage
    && typeof stage === 'object'
    && stage.status_after === 'failed'
    && stage.status_before !== 'failed'
  ));
}

function recordSharedProviderLearning(ctx) {
  try {
    if (ctx?.status !== 'failed') return;
    const task = ctx?.task || {};
    const provider = normalizeText(task.provider || ctx?.proc?.provider);
    if (!provider) return;

    const metadata = mergeTaskMetadata(task, ctx);
    const scope = deriveLearningScope({
      task,
      metadata,
      files: ctx?.filesModified,
      workingDirectory: task.working_directory,
      description: task.task_description,
    });
    if (!scope || !scope.scope_key) return;

    const store = getSharedFactoryStore();
    if (!store || typeof store.upsertLearning !== 'function') return;

    const failureCategory = categorizeFailure(ctx);
    const key = {
      signal_type: DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE,
      scope_key: scope.scope_key,
      provider,
      failure_pattern: failureCategory,
    };
    const existing = typeof store.getLearning === 'function' ? store.getLearning(key) : null;
    const nextSampleCount = (Number(existing?.sample_count) || 0) + 1;

    store.upsertLearning({
      ...key,
      tech_stack: scope.tech_stack,
      sample_count: 1,
      confidence: computeProviderFailureConfidence(nextSampleCount),
      project_source: resolveTaskProjectId(task) || normalizeText(task.working_directory) || 'unknown',
      payload: {
        signal_type: DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE,
        scope_key: scope.scope_key,
        tech_stack: scope.tech_stack,
        signals: scope.signals || [],
        failure_category: failureCategory,
        task_id: ctx.taskId || task.id || null,
        task_description: task.task_description || null,
        working_directory: task.working_directory || null,
        files_modified: ctx?.filesModified || [],
        status: ctx.status,
      },
    });
  } catch (err) {
    logger.info(`[finalizer] Shared provider learning recording failed: ${err.message}`);
  }
}

function recordSharedVerifyFailureLearning(ctx) {
  try {
    if (!hasVerifyFailureSignal(ctx)) return;
    const task = ctx?.task || {};
    const provider = normalizeText(task.provider || ctx?.proc?.provider);
    if (!provider) return;

    const metadata = mergeTaskMetadata(task, ctx);
    const pattern = deriveVerifyFailurePattern({
      task,
      metadata,
      files: ctx?.filesModified,
      workingDirectory: task.working_directory,
      description: task.task_description,
      output: ctx?.output,
      errorOutput: ctx?.errorOutput,
      validationStages: ctx?.validationStages,
    });
    if (!pattern || !pattern.pattern_hash) return;

    const store = getSharedFactoryStore();
    if (!store || typeof store.upsertLearning !== 'function') return;

    const key = {
      signal_type: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
      scope_key: pattern.scope_key,
      provider,
      failure_pattern: pattern.pattern_hash,
    };
    const existing = typeof store.getLearning === 'function' ? store.getLearning(key) : null;
    const nextSampleCount = (Number(existing?.sample_count) || 0) + 1;
    const failureCategory = categorizeFailure(ctx);

    store.upsertLearning({
      ...key,
      tech_stack: pattern.tech_stack,
      sample_count: 1,
      confidence: computeVerifyFailureConfidence(nextSampleCount, pattern.categories),
      project_source: resolveTaskProjectId(task) || normalizeText(task.working_directory) || 'unknown',
      payload: {
        signal_type: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
        scope_key: pattern.scope_key,
        tech_stack: pattern.tech_stack,
        provider,
        pattern_hash: pattern.pattern_hash,
        normalized_pattern: pattern.normalized_pattern,
        failure_categories: pattern.categories,
        failure_category: pattern.failure_category,
        finalizer_failure_category: failureCategory,
        signals: pattern.signals || [],
        task_id: ctx.taskId || task.id || null,
        task_description: task.task_description || null,
        working_directory: task.working_directory || null,
        files_modified: ctx?.filesModified || [],
        status: ctx.status,
      },
    });
  } catch (err) {
    logger.info(`[finalizer] Shared verify failure learning recording failed: ${err.message}`);
  }
}

function getCheckpointStore() {
  if (getDeps().checkpointStore && typeof getDeps().checkpointStore.writeCheckpoint === 'function') {
    return getDeps().checkpointStore;
  }

  try {
    const { defaultContainer } = require('../container');
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && defaultContainer.has('checkpointStore')
      && typeof defaultContainer.get === 'function'
    ) {
      return defaultContainer.get('checkpointStore');
    }
  } catch (_err) {
    // Container may be unavailable or not booted in direct-module tests.
  }

  const rawDb = getRawDbInstance();
  if (!rawDb) {
    return null;
  }

  try {
    const { createCheckpointStore } = require('../workflow-state/checkpoint-store');
    return createCheckpointStore({ db: rawDb });
  } catch (_err) {
    return null;
  }
}

function normalizeWorkflowCheckpointVersion(versionCandidate) {
  const explicitVersion = Number(versionCandidate);
  if (Number.isInteger(explicitVersion) && explicitVersion > 0) {
    return explicitVersion;
  }

  return 1;
}

function readWorkflowCheckpointSnapshot(workflowId, fallbackState, versionCandidate) {
  const fallbackVersion = normalizeWorkflowCheckpointVersion(versionCandidate);

  const rawDb = getRawDbInstance();
  if (!rawDb || !workflowId) {
    return {
      state: fallbackState,
      version: fallbackVersion,
    };
  }

  try {
    const row = rawDb.prepare('SELECT state_json, version FROM workflow_state WHERE workflow_id = ?').get(workflowId);
    if (row) {
      return {
        state: safeJsonParse(row.state_json, fallbackState),
        version: normalizeWorkflowCheckpointVersion(row.version),
      };
    }
  } catch (_err) {
    // workflow_state is not present on every branch yet; fall back below.
  }

  return {
    state: fallbackState,
    version: fallbackVersion,
  };
}

function getDurationMsForScoring(task) {
  const startedAt = parseTimestampMs(task?.started_at);
  if (!startedAt) return 0;

  const completedAt = parseTimestampMs(task?.completed_at) || Date.now();
  return Math.max(0, completedAt - startedAt);
}

function buildFailedTaskResumeContext(task, taskOutput, errorOutput, durationMs) {
  try {
    return resumeContextUtils.buildResumeContext(
      taskOutput || task?.output || '',
      errorOutput || task?.error_output || '',
      {
        task_description: task?.task_description,
        durationMs,
        provider: task?.provider,
      }
    );
  } catch (err) {
    logger.info(`[finalizer] Resume context build failed: ${err.message}`);
    return null;
  }
}

function getCostUsdForScoring(task, metadata) {
  const cost = firstFiniteNumber([
    task?.cost_usd,
    task?.estimated_cost_usd,
    task?.estimated_cost,
    task?.cost_estimate,
    metadata?.cost_usd,
    metadata?.estimated_cost_usd,
    metadata?.estimated_cost,
    metadata?.cost_estimate,
    metadata?.provider_usage?.cost_estimate,
    metadata?.token_usage?.estimated_cost_usd,
    metadata?.token_usage?.cost_usd,
    metadata?.agentic_token_usage?.estimated_cost_usd,
    metadata?.agentic_token_usage?.cost_usd,
  ]);

  return cost !== null && cost > 0 ? cost : 0;
}

function getQualityScoreForScoring(task, success, metadata) {
  const explicitQuality = firstFiniteNumber([
    task?.quality_score,
    task?.qualityScore,
    metadata?.provider_scoring?.quality_score,
    metadata?.provider_scoring?.qualityScore,
    metadata?.quality_score,
    metadata?.qualityScore,
    metadata?.finalization?.quality_score,
    metadata?.finalization?.qualityScore,
    metadata?.finalization?.verify_command_result?.quality_score,
    metadata?.finalization?.verify_command_result?.qualityScore,
    metadata?.verify_command_result?.quality_score,
    metadata?.verify_command_result?.qualityScore,
    metadata?.verification?.quality_score,
    metadata?.verification?.qualityScore,
    metadata?.strategic_review?.quality_score,
    metadata?.strategic_review?.qualityScore,
  ]);
  const normalizedExplicit = normalizeQualityScore(explicitQuality);
  if (normalizedExplicit !== null) return normalizedExplicit;

  try {
    if (getDeps().db && typeof getDeps().db.getQualityScore === 'function' && task?.id) {
      const row = getDeps().db.getQualityScore(task.id);
      const persisted = normalizeQualityScore(row?.overall_score);
      if (persisted !== null) return persisted;
    }
  } catch (err) {
    logger.info(`[finalizer] Provider quality score lookup failed: ${err.message}`);
  }

  return success ? 0.7 : 0.0;
}

function recordProviderScoring(ctx) {
  try {
    const task = ctx?.task || {};
    const provider = String(task.provider || ctx?.proc?.provider || '').trim();
    if (!provider) return;

    const scoring = getProviderScoringService();
    const rawDb = getRawDbInstance();
    if (rawDb && typeof scoring.init === 'function') {
      scoring.init(rawDb);
    }

    const metadata = parseMetadata(task.metadata);
    const success = ctx.status === 'completed';
    scoring.recordTaskCompletion({
      provider,
      success,
      durationMs: getDurationMsForScoring(task),
      costUsd: getCostUsdForScoring(task, metadata),
      qualityScore: getQualityScoreForScoring(task, success, metadata),
    });
  } catch (err) {
    logger.info(`[finalizer] Provider scoring recording failed: ${err.message}`);
  }
}

async function indexRunArtifacts(taskId, workflowId = null) {
  try {
    const { defaultContainer } = require('../container');
    if (!defaultContainer || typeof defaultContainer.has !== 'function' || !defaultContainer.has('runDirManager')) {
      return;
    }
    const manager = defaultContainer.get('runDirManager');
    if (!manager || typeof manager.indexFiles !== 'function') {
      return;
    }
    await manager.indexFiles(taskId, { workflowId });
  } catch (err) {
    logger.info(`[finalizer] Run artifact indexing failed for ${taskId}: ${err.message}`);
  }
}

function snapshotCtx(ctx) {
  return {
    status: ctx.status,
    code: ctx.code,
    earlyExit: ctx.earlyExit === true,
    output: ctx.output || '',
    errorOutput: ctx.errorOutput || '',
  };
}

function describeStageOutcome(before, after) {
  if (after.earlyExit && !before.earlyExit) return 'early_exit';
  if (before.status !== after.status) return `status:${after.status}`;
  if (before.code !== after.code) return 'exit_code_adjusted';
  if (before.output !== after.output || before.errorOutput !== after.errorOutput) return 'output_mutated';
  return 'no_change';
}

function buildValidationMetadata(task, ctx, rawExitCode) {
  const metadata = mergeTaskMetadata(task, ctx);
  const priorFinalization = (metadata.finalization && typeof metadata.finalization === 'object')
    ? metadata.finalization
    : {};
  if (ctx.status === 'failed' || ctx.status === 'cancelled') {
    try {
      const { classifyFailure } = require('../validation/failure-classifier');
      const classified = classifyFailure({
        output: ctx.output,
        error_output: ctx.errorOutput,
        validation: ctx.validationStages,
      });
      metadata.failure_class = classified.class;
      metadata.failure_class_pattern = classified.matched_pattern;
      metadata.failure_class_confidence = classified.confidence;
    } catch { /* classification is advisory */ }
  }
  return {
    ...metadata,
    finalization: {
      ...priorFinalization,
      finalized_at: new Date().toISOString(),
      raw_exit_code: rawExitCode,
      final_exit_code: ctx.code,
      final_status: ctx.status,
      validation_stage_outcomes: ctx.validationStages,
    },
  };
}

function recordTaskExperience(ctx, sanitizedOutput) {
  if (ctx.status !== 'completed') return;
  try {
    const task = ctx.task || {};
    const { recordExperience } = require('../experience/store');
    recordExperience({
      project: task.project || null,
      task_description: task.task_description || '',
      output_summary: String(sanitizedOutput || '').replace(/\s+/g, ' ').slice(0, 1000),
      files_modified: ctx.filesModified || [],
      provider: task.provider || null,
      success_score: 1,
    }, getRawDbInstance());
  } catch (err) {
    logger.info(`[finalizer] Experience recording failed: ${err.message}`);
  }
}

function maybeCacheTaskResult(taskId, metadata) {
  if (!metadata || metadata.cacheable !== true) return;
  try {
    const cacheVersion = metadata.cache_version || 'default';
    const ttlHours = metadata.cache_ttl_seconds
      ? Math.max(1, Number(metadata.cache_ttl_seconds) / 3600)
      : 24;
    const dbFacade = getDeps().db;
    if (dbFacade && typeof dbFacade.cacheTaskResult === 'function') {
      dbFacade.cacheTaskResult(taskId, ttlHours, { cache_version: cacheVersion });
    }
  } catch (err) {
    logger.info(`[finalizer] Task result caching failed for ${taskId}: ${err.message}`);
  }
}

function categorizeFailure(ctx) {
  const output = typeof ctx?.output === 'string' ? ctx.output.trim() : ctx?.output;
  const errorOutput = typeof ctx?.errorOutput === 'string' ? ctx.errorOutput.trim() : '';
  const validationText = ctx?.validationStages ? JSON.stringify(ctx.validationStages) : '';
  const haystack = `${errorOutput}\n${validationText}`;

  if (/ERROR:\s*\{"detail":/i.test(haystack) || /\bmodel\b.*\bnot (supported|found)\b/i.test(haystack) || /\binvalid\s+api\s*key\b/i.test(haystack) || /\bauthentication\s+failed\b/i.test(haystack) || /\binsufficient[_ ]quota\b/i.test(haystack)) {
    return 'api_error';
  }
  if (/parse error|no edits found/i.test(haystack) || (/HASHLINE_EDIT/i.test(haystack) && /failed/i.test(haystack))) {
    return 'parse_error';
  }
  if (/SyntaxError|syntax gate|brace imbalance/i.test(haystack)) {
    return 'syntax_error';
  }
  if (/TS\d{4}/i.test(haystack) || /\bTypeError\b/i.test(haystack)) {
    return 'type_error';
  }
  if ((/FAIL/i.test(haystack) && /\btest\b/i.test(haystack)) || /AssertionError|vitest/i.test(haystack)) {
    return 'test_failure';
  }
  if (/timeout|timed out|SIGTERM/i.test(haystack)) {
    return 'timeout';
  }
  if (!output && !errorOutput) {
    return 'empty_output';
  }
  if (/\[auto-verify\]/i.test(haystack)) {
    return 'verify_failure';
  }
  if ((/format/i.test(haystack) && /mismatch/i.test(haystack)) || (/SEARCH\/REPLACE/i.test(haystack) && /fail/i.test(haystack))) {
    return 'format_mismatch';
  }
  return 'unknown';
}

async function runStage(ctx, name, handler, shouldRun = true) {
  if (typeof ctx.finalizationHeartbeat === 'function') {
    try { ctx.finalizationHeartbeat(`stage:${name}:start`); } catch { /* non-critical */ }
  }
  if (!shouldRun) {
    ctx.validationStages[name] = {
      outcome: 'skipped',
      status_before: ctx.status,
      status_after: ctx.status,
      code_before: ctx.code,
      code_after: ctx.code,
      early_exit: ctx.earlyExit === true,
    };
    if (typeof ctx.finalizationHeartbeat === 'function') {
      try { ctx.finalizationHeartbeat(`stage:${name}:skipped`); } catch { /* non-critical */ }
    }
    return;
  }

  const before = snapshotCtx(ctx);
  const startedAt = Date.now();
  const timeoutMs = getStageTimeoutMs(name);

  try {
    await runWithStageTimeout(name, timeoutMs, handler(ctx));
  } catch (err) {
    ctx.pipelineError = true;
    ctx.status = 'failed';
    ctx.code = normalizeExitCode(ctx.code);
    if (ctx.code === 0) ctx.code = 1;
    const isTimeout = err?.code === 'FINALIZER_STAGE_TIMEOUT';
    const errorLabel = isTimeout ? 'TIMEOUT' : 'ERROR';
    ctx.errorOutput = appendErrorOutput(ctx.errorOutput, `[FINALIZER ${name} ${errorLabel}] ${err.message}`);
    ctx.validationStages[name] = {
      outcome: isTimeout ? 'timeout' : 'error',
      status_before: before.status,
      status_after: ctx.status,
      code_before: before.code,
      code_after: ctx.code,
      early_exit: ctx.earlyExit === true,
      duration_ms: Date.now() - startedAt,
      timeout_ms: isTimeout ? timeoutMs : undefined,
      error: err.message,
    };
    logger.info(`[TaskFinalizer] Stage ${name} ${isTimeout ? 'timed out' : 'failed'} for ${ctx.taskId}: ${err.message}`);
    if (typeof ctx.finalizationHeartbeat === 'function') {
      try { ctx.finalizationHeartbeat(`stage:${name}:${isTimeout ? 'timeout' : 'error'}`); } catch { /* non-critical */ }
    }
    return;
  }

  if (ctx.status === 'failed' && ctx.code === 0) {
    ctx.code = 1;
  }

  const after = snapshotCtx(ctx);
  ctx.validationStages[name] = {
    outcome: describeStageOutcome(before, after),
    status_before: before.status,
    status_after: after.status,
    code_before: before.code,
    code_after: after.code,
    early_exit: after.earlyExit,
    duration_ms: Date.now() - startedAt,
  };
  if (typeof ctx.finalizationHeartbeat === 'function') {
    try { ctx.finalizationHeartbeat(`stage:${name}:done`); } catch { /* non-critical */ }
  }
}

async function waitForTaskLock(taskId) {
  const startedAt = Date.now();
  while (finalizationLocks.get(taskId)) {
    await sleep(10);
    if (Date.now() - startedAt > 10000) {
      break;
    }
  }
}

async function acquireTaskLock(taskId, options = {}) {
  const maxWaitMs = options.maxWaitMs || 300000; // 5 minutes default
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error(`acquireTaskLock timed out after ${maxWaitMs}ms for task ${taskId}`);
    }
    await waitForTaskLock(taskId);
    if (!finalizationLocks.get(taskId)) {
      finalizationLocks.set(taskId, true);
      return;
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

function triggerStrategicHooks(ctx) {
  try {
    const strategicHooks = require('./strategic-hooks');
    if (ctx.status === 'failed') {
      setImmediate(() => strategicHooks.onTaskFailed(ctx).catch(() => {}));
    } else if (ctx.status === 'completed') {
      setImmediate(() => strategicHooks.onTaskCompleted(ctx).catch(() => {}));
    }
  } catch (err) {
    logger.info(`[TaskFinalizer] Strategic hook dispatch failed for ${ctx?.taskId || 'unknown'}: ${err.message}`);
  }
}

function recordProviderPerformance(ctx) {
  try {
    const provider = ctx?.task?.provider;
    if (!provider) return;
    const durationSeconds = ctx.task.started_at
      ? Math.round((Date.now() - new Date(ctx.task.started_at).getTime()) / 1000)
      : null;
    perfTracker.recordTaskOutcome({
      provider,
      taskType: perfTracker.inferTaskType(ctx.task.task_description || ''),
      durationSeconds,
      success: ctx.status === 'completed',
      resubmitted: false,
      autoCheckPassed: ctx.status === 'completed',
    });
  } catch (err) {
    logger.info(`[finalizer] Provider performance recording failed: ${err.message}`);
  }
}

function clearCodexExhaustionAfterSuccess(ctx) {
  if (ctx?.status !== 'completed') return;
  const provider = String(ctx?.task?.provider || '').trim().toLowerCase();
  if (provider !== 'codex' && provider !== 'codex-spark') return;
  const db = getDeps().db;
  if (!db) return;

  try {
    if (typeof db.setCodexExhausted === 'function') {
      db.setCodexExhausted(false);
    } else if (typeof db.setConfig === 'function') {
      db.setConfig('codex_exhausted', '0');
    }
    if (typeof db.setConfig === 'function') {
      db.setConfig('codex_exhaustion_retry_at', '');
    }
    logger.info(`[Codex Exhaustion] Successful ${provider} task ${ctx.taskId} cleared Codex exhaustion state`);
  } catch (err) {
    logger.info(`[Codex Exhaustion] Failed to clear exhaustion state after ${provider} success: ${err.message}`);
  }
}

function handleDiffusionSignalDetection(ctx) {
  try {
    const signal = parseDiffusionSignal(ctx.output || '');
    if (signal) {
      const task = getDeps().db.getTask(ctx.taskId);
      const existingMeta = task && task.metadata
        ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata)
        : {};
      existingMeta.diffusion_request = signal;
      if (typeof getDeps().db.updateTask === 'function') {
        getDeps().db.updateTask(ctx.taskId, { metadata: JSON.stringify(existingMeta) });
      }
      logger.info(`[Diffusion] Task ${ctx.taskId} emitted diffusion request: ${signal.summary}`);
    }
  } catch (err) {
    logger.debug(`[Diffusion] Phase 2.5 non-critical error: ${err.message}`);
  }
}

function handleComputeApplyCreation(ctx) {
  try {
    const task = getDeps().db.getTask(ctx.taskId);
    const meta = task?.metadata
      ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata)
      : {};

    if (meta.diffusion_role !== 'compute' || ctx.status !== 'completed') return;

    const parsed = parseComputeOutput(ctx.output || '');
    if (!parsed) {
      logger.info(`[Diffusion] Compute task ${ctx.taskId} produced unparseable output — marking failed`);
      if (typeof getDeps().db.updateTaskStatus === 'function') {
        getDeps().db.updateTaskStatus(ctx.taskId, 'failed');
      }
      ctx.status = 'failed';
      return;
    }

    const validation = validateComputeSchema(parsed);
    if (!validation.valid) {
      logger.info(`[Diffusion] Compute task ${ctx.taskId} schema invalid: ${validation.errors.join('; ')}`);
      if (typeof getDeps().db.updateTaskStatus === 'function') {
        getDeps().db.updateTaskStatus(ctx.taskId, 'failed');
      }
      ctx.status = 'failed';
      return;
    }

    // Create the apply task dynamically — round-robin across available providers
    const applyProviderList = Array.isArray(meta.apply_providers) && meta.apply_providers.length > 0
      ? meta.apply_providers
      : [meta.apply_provider || 'ollama'];
    const applyIndex = parseInt(ctx.taskId.replace(/[^0-9a-f]/g, '').slice(-4), 16) % applyProviderList.length;
    const applyProvider = applyProviderList[applyIndex];
    const workingDir = task.working_directory;
    const applyDesc = expandApplyTaskDescription(parsed, workingDir);
    const applyId = uuidv4();

    getDeps().db.createTask({
      id: applyId,
      status: 'queued',
      task_description: applyDesc,
      working_directory: workingDir,
      workflow_id: task.workflow_id,
      provider: applyProvider,
      metadata: JSON.stringify({
        diffusion: true,
        diffusion_role: 'apply',
        compute_task_id: ctx.taskId,
        compute_output: parsed,
        auto_verify_on_completion: true,
        verify_command: meta.verify_command || null,
        user_provider_override: true,
        requested_provider: applyProvider,
      }),
    });

    logger.info(`[Diffusion] Created apply task ${applyId} from compute ${ctx.taskId} (${parsed.file_edits.length} file edits)`);

    // Update workflow counts so await_workflow tracks the new apply task
    if (task.workflow_id) {
      try {
        const workflowEngine = require('../db/workflow-engine');
        workflowEngine.updateWorkflowCounts(task.workflow_id);
        const wf = workflowEngine.getWorkflow(task.workflow_id);
        if (wf && wf.status === 'completed') {
          workflowEngine.updateWorkflow(task.workflow_id, { status: 'running' });
          logger.info(`[Diffusion] Reopened workflow ${task.workflow_id} — apply tasks still pending`);
        }
      } catch (wfErr) {
        logger.info(`[Diffusion] Workflow count update error: ${wfErr.message}`);
      }
    }

    // Start the apply task
    try {
      const taskManager = require('../task-manager');
      const startPromise = taskManager.startTask(applyId);
      if (startPromise && typeof startPromise.catch === 'function') {
        startPromise.catch(err => logger.info(`[Diffusion] Async failure starting apply task ${applyId}: ${err.message}`));
      }
    } catch (err) {
      logger.info(`[Diffusion] Failed to auto-start apply task ${applyId}: ${err.message}`);
    }
  } catch (err) {
    logger.debug(`[Diffusion] Compute→apply hook non-critical error: ${err.message}`);
  }
}

async function finalizeTask(taskId, options = {}) {
  if (!getDeps().db || typeof getDeps().db.getTask !== 'function') {
    throw new Error('task-finalizer not initialized with db dependency');
  }

  await acquireTaskLock(taskId);

  let ctx = null;
  try {
    const task = getDeps().db.getTask(taskId);
    if (!task) {
      return { finalized: false, queueManaged: false, task: null, reason: 'not_found' };
    }
    if (!isFinalizableStatus(task.status)) {
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        releaseSharedCodexClaims(taskId, task.status, task);
      }
      return {
        finalized: false,
        queueManaged: false,
        task,
        reason: `status:${task.status}`,
      };
    }

    const rawExitCode = normalizeExitCode(options.exitCode);
    const procState = options.procState || options.proc || {};
    const output = options.output !== undefined
      ? options.output
      : (procState.output !== undefined ? procState.output : (task.output || ''));
    const errorOutput = options.errorOutput !== undefined
      ? options.errorOutput
      : (procState.errorOutput !== undefined ? procState.errorOutput : (task.error_output || ''));
    const combinedOutput = buildCombinedOutput(output, errorOutput);
    const filesModified = Array.isArray(options.filesModified)
      ? [...new Set(options.filesModified)]
      : (typeof getDeps().extractModifiedFiles === 'function'
        ? getDeps().extractModifiedFiles(combinedOutput)
        : []);

    ctx = {
      taskId,
      code: rawExitCode,
      rawExitCode,  // immutable — original process exit code before pipeline stages modify ctx.code
      status: rawExitCode === 0 ? 'completed' : 'failed',
      task,
      proc: {
        ...procState,
        output,
        errorOutput,
        provider: procState.provider || task.provider || null,
        baselineCommit: procState.baselineCommit || null,
        rawExitCode,  // also on proc for close-phases access
      },
      filesModified,
      output,
      errorOutput,
      earlyExit: false,
      validationStages: {},
      pipelineError: false,
      finalizationHeartbeat: typeof options.finalizationHeartbeat === 'function'
        ? options.finalizationHeartbeat
        : null,
    };
    if (ctx.finalizationHeartbeat) {
      try { ctx.finalizationHeartbeat('finalizer:context_ready'); } catch { /* non-critical */ }
    }

    await runStage(ctx, 'retry_logic', getDeps().handleRetryLogic, ctx.code !== 0);
    if (ctx.earlyExit) {
      releaseSharedCodexClaimsForEarlyExit(taskId, task, ctx);
      return {
        finalized: false,
        queueManaged: true,
        task: getDeps().db.getTask(taskId) || task,
        status: getDeps().db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    await runStage(ctx, 'safeguard_checks', getDeps().handleSafeguardChecks, typeof getDeps().handleSafeguardChecks === 'function');
    if (ctx.earlyExit) {
      releaseSharedCodexClaimsForEarlyExit(taskId, task, ctx);
      return {
        finalized: false,
        queueManaged: true,
        task: getDeps().db.getTask(taskId) || task,
        status: getDeps().db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    // Phase 2.5: Diffusion signal detection — check output for __DIFFUSION_REQUEST__ blocks
    await runStage(ctx, 'diffusion_signal_detection', handleDiffusionSignalDetection, ctx.code === 0);

    await runStage(ctx, 'compute_apply_creation', handleComputeApplyCreation, ctx.code === 0);

    await runStage(ctx, 'fuzzy_repair', getDeps().handleFuzzyRepair, typeof getDeps().handleFuzzyRepair === 'function');
    await runStage(ctx, 'factory_worktree_hygiene', sanitizeFactoryPlanWorktreeDirtyFiles, ctx.status === 'completed');
    augmentFactoryFilesModifiedFromGitStatus(ctx);
    await runStage(ctx, 'no_file_change_detection', getDeps().handleNoFileChangeDetection, typeof getDeps().handleNoFileChangeDetection === 'function');
    await runStage(
      ctx,
      'retry_logic_after_no_file_change',
      getDeps().handleRetryLogic,
      Boolean(ctx.noFileChangeFailure) && ctx.status === 'failed' && ctx.code !== 0
    );
    if (ctx.earlyExit) {
      releaseSharedCodexClaimsForEarlyExit(taskId, task, ctx);
      return {
        finalized: false,
        queueManaged: true,
        task: getDeps().db.getTask(taskId) || task,
        status: getDeps().db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }
    await runStage(ctx, 'phantom_success_detection', (stageCtx) => runPhantomSuccessDetection(stageCtx, {
      getRawDb: getRawDbInstance,
      logDecision: getDeps().logFactoryDecision,
    }), ctx.status === 'completed');
    await runStage(
      ctx,
      'retry_logic_after_phantom',
      getDeps().handleRetryLogic,
      Boolean(ctx.phantomSuccess) && ctx.status === 'failed' && ctx.code !== 0
    );
    if (ctx.earlyExit) {
      releaseSharedCodexClaimsForEarlyExit(taskId, task, ctx);
      return {
        finalized: false,
        queueManaged: true,
        task: getDeps().db.getTask(taskId) || task,
        status: getDeps().db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }
    // Banner-only detection runs on terminal non-success states. Codex
    // killed mid-startup leaves error_output as just the CLI banner —
    // useless for diagnosis. Rewrite to a clearer message while preserving
    // the original banner for forensics.
    await runStage(ctx, 'codex_banner_only_detection',
      (stageCtx) => runCodexBannerOnlyDetection(stageCtx),
      ctx.status === 'failed' || ctx.status === 'cancelled');
    if (ctx.earlyExit) {
      releaseSharedCodexClaimsForEarlyExit(taskId, task, ctx);
      return {
        finalized: false,
        queueManaged: true,
        task: getDeps().db.getTask(taskId) || task,
        status: getDeps().db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    await runStage(ctx, 'sandbox_revert_detection', getDeps().handleSandboxRevertDetection, typeof getDeps().handleSandboxRevertDetection === 'function');
    await runStage(ctx, 'auto_validation', getDeps().handleAutoValidation, typeof getDeps().handleAutoValidation === 'function');
    await runStage(ctx, 'build_test_style_commit', getDeps().handleBuildTestStyleCommit, typeof getDeps().handleBuildTestStyleCommit === 'function');
    await runStage(ctx, 'auto_verify_retry', getDeps().handleAutoVerifyRetry, typeof getDeps().handleAutoVerifyRetry === 'function');
    await runStage(
      ctx,
      'verification_ledger',
      getScopedVerificationLedger(),
      typeof getScopedVerificationLedger() === 'function'
    );
    if (ctx.earlyExit) {
      releaseSharedCodexClaimsForEarlyExit(taskId, task, ctx);
      return {
        finalized: false,
        queueManaged: true,
        task: getDeps().db.getTask(taskId) || task,
        status: getDeps().db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    await runStage(
      ctx,
      'adversarial_review',
      getScopedAdversarialReview(),
      typeof getScopedAdversarialReview() === 'function' && ctx.status === 'completed'
    );

    // Experiment 5: Smart failure diagnosis — analyzes error patterns and
    // sets recovery hints (suggested_provider, needs_escalation) for downstream stages
    await runStage(ctx, 'smart_diagnosis', smartDiagnosisStage, ctx.status === 'failed');

    // Experiment 4: Strategic review — deterministic quality gate for tasks
    // flagged needs_review: true. Rejects tasks with critical validation failures.
    await runStage(ctx, 'strategic_review', strategicReviewStage, ctx.status === 'completed');

    ctx.proc.output = ctx.output;
    ctx.proc.errorOutput = ctx.errorOutput;

    await runStage(
      ctx,
      'provider_failover',
      getDeps().handleProviderFailover,
      typeof getDeps().handleProviderFailover === 'function' && !ctx.pipelineError
    );
    if (ctx.earlyExit) {
      releaseSharedCodexClaimsForEarlyExit(taskId, task, ctx);
      return {
        finalized: false,
        queueManaged: true,
        task: getDeps().db.getTask(taskId) || task,
        status: getDeps().db.getTask(taskId)?.status || ctx.status,
        validationStages: ctx.validationStages,
        reason: 'early_exit',
      };
    }

    recordProviderPerformance(ctx);
    clearCodexExhaustionAfterSuccess(ctx);

    ctx.code = ctx.status === 'completed'
      ? 0
      : (ctx.code === 0 ? 1 : normalizeExitCode(ctx.code));

    try {
      const taskType = modelCapabilities.classifyTaskType(ctx.task.task_description || '');
      const language = modelCapabilities.detectTaskLanguage(ctx.task.task_description || '', ctx.filesModified || []);
      const success = ctx.status === 'completed';
      const duration = ctx.task.started_at
        ? Math.round((Date.now() - new Date(ctx.task.started_at).getTime()) / 1000)
        : null;
      const failureCategory = success ? null : categorizeFailure(ctx);
      modelCapabilities.recordTaskOutcome(
        ctx.task.model || ctx.task.provider || 'unknown',
        taskType,
        language,
        success,
        duration,
        failureCategory
      );
    } catch (outcomeErr) {
      logger.info(`[finalizer] Outcome recording failed: ${outcomeErr.message}`);
    }

    const metadata = buildValidationMetadata(task, ctx, rawExitCode);
    const sanitizedOutput = typeof getDeps().sanitizeTaskOutput === 'function'
      ? getDeps().sanitizeTaskOutput(ctx.output)
      : ctx.output;
    const resumeDurationMs = getDurationMsForScoring(task);
    const resumeContext = ctx.status === 'failed'
      ? buildFailedTaskResumeContext(task, sanitizedOutput, ctx.errorOutput, resumeDurationMs)
      : null;
    const statusFields = {
      exit_code: ctx.code,
      output: sanitizedOutput,
      error_output: ctx.errorOutput,
      files_modified: ctx.filesModified,
      progress_percent: ctx.status === 'completed' ? 100 : 0,
      metadata,
    };
    if (resumeContext) {
      statusFields.resume_context = resumeContext;
    }
    const updateTaskStatus = getDeps().safeUpdateTaskStatus || getDeps().db.updateTaskStatus;
    updateTaskStatus(taskId, ctx.status, statusFields);

    ctx.task = getDeps().db.getTask(taskId) || task;
    recordTaskExperience(ctx, sanitizedOutput);
    maybeCacheTaskResult(taskId, metadata);
    const workflowState = options.state !== undefined ? options.state : procState.state;
    const workflowStateVersion = options.stateVersion !== undefined
      ? options.stateVersion
      : (procState.stateVersion !== undefined ? procState.stateVersion : workflowState?.version);
    if (ctx.status === 'completed' && ctx.task?.workflow_id) {
      try {
        const checkpointStore = getCheckpointStore();
        const workflowSnapshot = readWorkflowCheckpointSnapshot(
          ctx.task.workflow_id,
          workflowState,
          workflowStateVersion,
        );
        if (
          checkpointStore
          && typeof checkpointStore.writeCheckpoint === 'function'
          && workflowSnapshot.state !== undefined
        ) {
          checkpointStore.writeCheckpoint({
            workflowId: ctx.task.workflow_id,
            stepId: ctx.task.workflow_node_id || ctx.task.node_id || task.workflow_node_id || task.node_id || null,
            taskId,
            state: workflowSnapshot.state,
            version: workflowSnapshot.version,
          });
        }
      } catch (checkpointErr) {
        logger.info(`[finalizer] Workflow checkpoint capture failed: ${checkpointErr.message}`);
      }
    }
    try {
      const { snapshotTaskState } = require('../checkpoints/snapshot');
      // Fire-and-forget — checkpoint must not block finalization
      Promise.resolve().then(() => snapshotTaskState({
        project_root: ctx.task.working_directory,
        task_id: taskId,
        task_label: (ctx.task.task_description || '').slice(0, 80),
      })).catch(err => logger.info(`[checkpoints] snapshot failed: ${err.message}`));
    } catch { /* module unavailable */ }

    await indexRunArtifacts(taskId, ctx.task?.workflow_id || task?.workflow_id || null);
    try {
      recordStudyTaskCompleted(ctx.task);
    } catch (studyTelemetryErr) {
      logger.info(`[finalizer] Study telemetry recording failed: ${studyTelemetryErr.message}`);
    }

    recordProviderScoring(ctx);
    recordSharedProviderLearning(ctx);
    recordSharedVerifyFailureLearning(ctx);

    try {
      const budgetWatcher = require('../db/budget-watcher');
      const inst = getRawDbInstance();
      if (inst && task.provider) {
        budgetWatcher.init(inst);
        const check = budgetWatcher.checkBudgetThresholds(task.provider);
        if (check && check.thresholdBreached === 'downgrade') {
          try { require('../logger').info('[budget] ' + task.provider + ' at ' + check.spendPercent + '% — activating Cost Saver template'); } catch {}
          try {
            const routing = require('../db/provider/routing-core');
            if (typeof routing.activateRoutingTemplate === 'function') {
              routing.activateRoutingTemplate('Cost Saver');
            }
          } catch { /* routing template activation is best-effort */ }
        }
      }
    } catch (_e) { /* non-critical */ }

    if (typeof getDeps().handlePostCompletion === 'function') {
      try {
        await Promise.resolve(getDeps().handlePostCompletion(ctx));
      } catch (postErr) {
        logger.error(`[finalizer] Post-completion failed for ${taskId}: ${postErr.message}`);
        // Don't re-throw — the task IS completed, only the cleanup/notification step failed
      }
    }

    // Strategic brain hooks (fire-and-forget, never blocks finalization)
    triggerStrategicHooks(ctx);
    releaseSharedCodexClaims(taskId, ctx.status, ctx.task || task);

    return {
      finalized: true,
      queueManaged: false,
      task: getDeps().db.getTask(taskId) || ctx.task,
      status: ctx.status,
      validationStages: ctx.validationStages,
    };
  } catch (err) {
    logger.info(`[TaskFinalizer] finalizeTask fatal error for ${taskId}: ${err.message}`);

    const currentTask = getDeps().db.getTask(taskId);
    if (!currentTask || !isFinalizableStatus(currentTask.status)) {
      if (currentTask && ['completed', 'failed', 'cancelled'].includes(currentTask.status)) {
        releaseSharedCodexClaims(taskId, currentTask.status, currentTask);
      }
      return {
        finalized: false,
        queueManaged: false,
        task: currentTask,
        reason: `fatal:${err.message}`,
      };
    }

    const rawExitCode = normalizeExitCode(options.exitCode);
    const fallbackCtx = ctx || {
      taskId,
      code: rawExitCode === 0 ? 1 : rawExitCode,
      status: 'failed',
      output: options.output || '',
      errorOutput: options.errorOutput || '',
      validationStages: {},
      task: currentTask,
      proc: {
        output: options.output || '',
        errorOutput: options.errorOutput || '',
        provider: currentTask.provider || null,
        baselineCommit: null,
      },
    };

    fallbackCtx.status = 'failed';
    fallbackCtx.code = fallbackCtx.code === 0 ? 1 : normalizeExitCode(fallbackCtx.code);
    fallbackCtx.errorOutput = appendErrorOutput(
      fallbackCtx.errorOutput,
      `Internal finalizer error: ${err.message}`
    );
    fallbackCtx.validationStages.fatal = {
      outcome: 'error',
      error: err.message,
      status_after: 'failed',
      code_after: fallbackCtx.code,
      early_exit: false,
    };

    const fallbackOutput = typeof getDeps().sanitizeTaskOutput === 'function'
      ? getDeps().sanitizeTaskOutput(fallbackCtx.output)
      : fallbackCtx.output;
    const fallbackResumeContext = buildFailedTaskResumeContext(
      currentTask,
      fallbackOutput,
      fallbackCtx.errorOutput,
      getDurationMsForScoring(currentTask)
    );
    const fallbackFields = {
      exit_code: fallbackCtx.code,
      output: fallbackOutput,
      error_output: fallbackCtx.errorOutput,
      files_modified: fallbackCtx.filesModified || [],
      progress_percent: 0,
      metadata: buildValidationMetadata(currentTask, fallbackCtx, rawExitCode),
    };
    if (fallbackResumeContext) {
      fallbackFields.resume_context = fallbackResumeContext;
    }
    const updateTaskStatus = getDeps().safeUpdateTaskStatus || getDeps().db.updateTaskStatus;
    updateTaskStatus(taskId, 'failed', fallbackFields);

    fallbackCtx.task = getDeps().db.getTask(taskId) || currentTask;
    await indexRunArtifacts(taskId, fallbackCtx.task?.workflow_id || currentTask?.workflow_id || null);
    recordProviderScoring(fallbackCtx);
    recordSharedProviderLearning(fallbackCtx);
    recordSharedVerifyFailureLearning(fallbackCtx);

    if (typeof getDeps().handlePostCompletion === 'function') {
      try {
        await Promise.resolve(getDeps().handlePostCompletion(fallbackCtx));
      } catch (postErr) {
        logger.info(`[TaskFinalizer] Post-completion failed after fatal finalization error for ${taskId}: ${postErr.message}`);
      }
    }

    // Strategic brain hooks (fire-and-forget, never blocks finalization)
    triggerStrategicHooks(fallbackCtx);
    releaseSharedCodexClaims(taskId, 'finalizer_fatal', fallbackCtx.task || currentTask);

    return {
      finalized: true,
      queueManaged: false,
      task: getDeps().db.getTask(taskId) || fallbackCtx.task,
      status: 'failed',
      validationStages: fallbackCtx.validationStages,
      reason: `fatal:${err.message}`,
    };
  } finally {
    finalizationLocks.delete(taskId);
  }
}

// ── New factory shape (preferred) ─────────────────────────────────────────
// Replaces the prior placeholder with one that actually closes over getDeps().
// finalizationLocks is a process-wide singleton (intentional — prevents
// concurrent finalize() calls for the same taskId across the entire process)
// and stays at module scope. handleVerificationLedger / handleAdversarialReview
// state-swap so per-instance overrides work in tests.
//
// Stage-handler resolution: most close-handler-pipeline stages live in
// their own modules (validation/close-phases, validation/auto-verify-retry,
// execution/retry-framework, validation/safeguard-gates, etc.). Resolve
// them via require() inside this factory so register() only needs to
// declare true container services. Test fixtures with explicit method
// overrides via localDeps still win.
function createTaskFinalizer(localDeps = {}) {
  const resolved = { ...localDeps };

  // Stage handlers resolved from their canonical modules.
  if (!resolved.handleRetryLogic) {
    try {
      const retryFramework = require('./retry-framework');
      if (resolved.retryFramework && typeof resolved.retryFramework.handleRetryLogic === 'function') {
        resolved.handleRetryLogic = resolved.retryFramework.handleRetryLogic.bind(resolved.retryFramework);
      } else if (typeof retryFramework.createRetryFramework === 'function') {
        resolved.handleRetryLogic = retryFramework.createRetryFramework(resolved).handleRetryLogic;
      } else {
        resolved.handleRetryLogic = retryFramework.handleRetryLogic;
      }
    }
    catch { /* fall through */ }
  }
  if (!resolved.handleSafeguardChecks) {
    try { resolved.handleSafeguardChecks = require('../validation/safeguard-gates').handleSafeguardChecks; }
    catch { /* fall through */ }
  }
  if (!resolved.handleAutoValidation || !resolved.handleBuildTestStyleCommit || !resolved.handleProviderFailover) {
    try {
      const closePhases = require('../validation/close-phases');
      if (!resolved.handleAutoValidation) resolved.handleAutoValidation = closePhases.handleAutoValidation;
      if (!resolved.handleBuildTestStyleCommit) resolved.handleBuildTestStyleCommit = closePhases.handleBuildTestStyleCommit;
      if (!resolved.handleProviderFailover) resolved.handleProviderFailover = closePhases.handleProviderFailover;
    } catch { /* fall through */ }
  }
  if (!resolved.handleAutoVerifyRetry) {
    try { resolved.handleAutoVerifyRetry = require('../validation/auto-verify-retry').handleAutoVerifyRetry; }
    catch { /* fall through */ }
  }
  if (!resolved.handlePostCompletion) {
    if (resolved.completionPipeline && typeof resolved.completionPipeline.handlePostCompletion === 'function') {
      resolved.handlePostCompletion = resolved.completionPipeline.handlePostCompletion.bind(resolved.completionPipeline);
    } else {
      try { resolved.handlePostCompletion = require('./completion-pipeline').handlePostCompletion; }
      catch { /* fall through */ }
    }
  }
  if (!resolved.handleSandboxRevertDetection) {
    try { resolved.handleSandboxRevertDetection = require('./sandbox-revert-detection').detectSandboxReverts; }
    catch { /* fall through */ }
  }
  // Legacy phases that are now no-ops; the close-handler pipeline still
  // calls them positionally so they need to exist as functions.
  if (typeof resolved.handleFuzzyRepair !== 'function') {
    resolved.handleFuzzyRepair = () => { /* no-op (legacy phase removed) */ };
  }
  if (typeof resolved.handleNoFileChangeDetection !== 'function') {
    resolved.handleNoFileChangeDetection = handleNoFileChangeDetection;
  }

  // Utility functions resolved from their source modules.
  if (!resolved.sanitizeTaskOutput) {
    try { resolved.sanitizeTaskOutput = require('./task-utils').sanitizeTaskOutput; }
    catch { /* fall through */ }
  }
  if (!resolved.extractModifiedFiles) {
    try { resolved.extractModifiedFiles = require('../utils/file-resolution').extractModifiedFiles; }
    catch { /* fall through */ }
  }

  // safeUpdateTaskStatus binds from taskManager (still owned there until
  // the taskStatusUpdater capability extraction lands).
  if (!resolved.safeUpdateTaskStatus) {
    const tm = localDeps.taskManager;
    if (tm && typeof tm.safeUpdateTaskStatus === 'function') {
      resolved.safeUpdateTaskStatus = tm.safeUpdateTaskStatus.bind(tm);
    }
  }

  async function withLocalDeps(fn) {
    const prevDeps = deps;
    const prevVL = handleVerificationLedger;
    const prevAR = handleAdversarialReview;
    const activeDeps = { ...deps, ...resolved };
    const activeVL = typeof resolved.handleVerificationLedger === 'function'
      ? resolved.handleVerificationLedger
      : handleVerificationLedger;
    const activeAR = typeof resolved.handleAdversarialReview === 'function'
      ? resolved.handleAdversarialReview
      : handleAdversarialReview;

    deps = activeDeps;
    if (typeof resolved.handleVerificationLedger === 'function') {
      handleVerificationLedger = activeVL;
    }
    if (typeof resolved.handleAdversarialReview === 'function') {
      handleAdversarialReview = activeAR;
    }
    const store = {
      deps: activeDeps,
      handleVerificationLedger: activeVL,
      handleAdversarialReview: activeAR,
    };
    try { return await scopedDeps.run(store, fn); }
    finally {
      if (deps === activeDeps) {
        deps = prevDeps;
      }
      if (handleVerificationLedger === activeVL) {
        handleVerificationLedger = prevVL;
      }
      if (handleAdversarialReview === activeAR) {
        handleAdversarialReview = prevAR;
      }
    }
  }
  return {
    finalizeTask: (...args) => withLocalDeps(() => finalizeTask(...args)),
    _testing: {
      get finalizationLocks() { return finalizationLocks; },
      categorizeFailure,
      sanitizeFactoryPlanWorktreeDirtyFiles,
      collectFactoryTaskAllowedFiles,
      resetForTest,
    },
  };
}

function register(container) {
  // Stage handlers resolve via require() inside the factory; safeUpdateTaskStatus
  // binds from taskManager. completionPipeline must come from the container so
  // its module-scoped deps include db; the raw export is only a legacy fallback.
  // handleVerificationLedger / handleAdversarialReview also resolve from
  // optional container services (verificationLedger, adversarialReviews) when
  // those plugins register them — see the lazy-init logic in this file's init().
  container.register(
    'taskFinalizer',
    ['db', 'taskManager', 'completionPipeline'],
    (resolved) => createTaskFinalizer(resolved)
  );
}

module.exports = {
  // New shape (preferred)
  createTaskFinalizer,
  register,
  // Legacy shape (kept until task-manager.js migrates)
  init,
  finalizeTask,
  _testing: {
    get finalizationLocks() { return finalizationLocks; },
    categorizeFailure,
    sanitizeFactoryPlanWorktreeDirtyFiles,
    collectFactoryTaskAllowedFiles,
    resetForTest,
  },
};
