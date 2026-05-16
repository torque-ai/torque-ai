// Worktree-owner helpers — Phase 3 slice 5 re-scope (3b).
//
// Determining which task "owns" a factory worktree, finding live/reusable/
// replacement owners, freshness + dirty-status checks, and reused-worktree
// dependency prep. This is the lifted worktree-owner cluster (21 functions:
// 15 referenced by loop-controller's PLAN/EXECUTE block + 6 cluster-internal
// fold-in helpers) from loop-controller.js. createWorktreeOwner(deps) injects
// 7 loop-controller-internal helpers + the 3 worktree-owner status Sets; leaf
// modules are required directly. loop-controller keeps a one-line wiring and
// destructures the 15 names its callers use.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { LOOP_STATES } = require('./loop-states');
const branchFreshness = require('./branch-freshness');
const factoryWorktrees = require('../db/factory/worktrees');
const { checkWorktreeGitHealth } = require('./worktree-health');
const { detectDefaultBranch } = require('./worktree-runner');
const { prepareWorktreeVerifyDependencies } = require('../utils/worktree-verify-deps');
const logger = require('../logger').child({ component: 'factory-worktree-owner' });

const WORKTREE_OWNER_FN_DEPS = [
  'getPlanGenerationTask',
  'getTaskMetadataObject',
  'getWorkItemDecisionContext',
  'isTaskPidAlive',
  'normalizeOptionalString',
  'safeLogDecision',
  'taskHasFactoryTag',
];
const WORKTREE_OWNER_SET_DEPS = [
  'LIVE_WORKTREE_OWNER_STATUSES',
  'REUSABLE_WORKTREE_OWNER_STATUSES',
  'REPLACEMENT_WORKTREE_OWNER_STATUSES',
];

function createWorktreeOwner(deps = {}) {
  for (const name of WORKTREE_OWNER_FN_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createWorktreeOwner: dep '${name}' is required`);
    }
  }
  for (const name of WORKTREE_OWNER_SET_DEPS) {
    if (!(deps[name] instanceof Set)) {
      throw new TypeError(`createWorktreeOwner: dep '${name}' (Set) is required`);
    }
  }
  const {
    getPlanGenerationTask,
    getTaskMetadataObject,
    getWorkItemDecisionContext,
    isTaskPidAlive,
    normalizeOptionalString,
    safeLogDecision,
    taskHasFactoryTag,
    LIVE_WORKTREE_OWNER_STATUSES,
    REUSABLE_WORKTREE_OWNER_STATUSES,
    REPLACEMENT_WORKTREE_OWNER_STATUSES,
  } = deps;

  function isLiveWorktreeOwner(task, status = task?.status) {
    const normalizedStatus = String(status || '').toLowerCase();
    if (!task || !LIVE_WORKTREE_OWNER_STATUSES.has(normalizedStatus)) {
      return false;
    }
    return isTaskPidAlive(task);
  }

  function isReusableWorktreeOwner(task, status = task?.status) {
    const normalizedStatus = String(status || '').toLowerCase();
    return Boolean(task && REUSABLE_WORKTREE_OWNER_STATUSES.has(normalizedStatus));
  }

  function getWorktreeDirtyStatus(worktreePath) {
    if (!worktreePath || !fs.existsSync(worktreePath)) {
      return { dirty: false, checked: false, reason: 'missing' };
    }
    try {
      const gitEnv = { ...process.env };
      delete gitEnv.GIT_DIR;
      delete gitEnv.GIT_WORK_TREE;
      delete gitEnv.GIT_INDEX_FILE;
      delete gitEnv.GIT_OBJECT_DIRECTORY;
      delete gitEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      const topLevel = childProcess.execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: worktreePath,
        encoding: 'utf8',
        windowsHide: true,
        env: gitEnv,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const normalizedTopLevel = path.resolve(String(topLevel || '').trim()).replace(/\\/g, '/').toLowerCase();
      const normalizedWorktreePath = path.resolve(worktreePath).replace(/\\/g, '/').toLowerCase();
      if (normalizedTopLevel !== normalizedWorktreePath) {
        return { dirty: false, checked: false, reason: 'not_worktree_root' };
      }
      const output = childProcess.execFileSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        encoding: 'utf8',
        windowsHide: true,
        env: gitEnv,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { dirty: String(output || '').trim().length > 0, checked: true };
    } catch (error) {
      return {
        dirty: false,
        checked: false,
        reason: error && error.message ? error.message : 'git_status_failed',
      };
    }
  }

  function isDirtyRebaseFailure(error) {
    return /\b(unstaged changes|uncommitted changes|local changes|working tree.*dirty)\b/i
      .test(String(error || ''));
  }

  function isConflictRebaseFailure(error) {
    return /\b(CONFLICT|could not apply|resolve all conflicts|merge conflict|rebase conflict)\b/i
      .test(String(error || ''));
  }

  function normalizeWorktreePathForCompare(worktreePath) {
    if (typeof worktreePath !== 'string' || worktreePath.trim() === '') {
      return null;
    }
    try {
      return path.resolve(worktreePath).replace(/\\/g, '/').toLowerCase();
    } catch (_err) {
      return String(worktreePath).trim().replace(/\\/g, '/').toLowerCase();
    }
  }

  function findReplacementWorktreeOwner({
    projectId,
    workItemId,
    batchId,
    worktreePath,
    excludeTaskId = null,
    statuses = REPLACEMENT_WORKTREE_OWNER_STATUSES,
  }) {
    const normalizedPath = normalizeWorktreePathForCompare(worktreePath);
    if (!normalizedPath || !workItemId) {
      return null;
    }

    try {
      const taskCore = require('../db/task-core');
      if (!taskCore || typeof taskCore.listTasks !== 'function') {
        return null;
      }

      const lookupTags = [`factory:work_item_id=${workItemId}`];
      if (batchId) lookupTags.push(`factory:batch_id=${batchId}`);

      const queryStatuses = Array.from(statuses || REPLACEMENT_WORKTREE_OWNER_STATUSES);
      const candidates = taskCore.listTasks({
        statuses: queryStatuses,
        tags: lookupTags,
        columns: ['id', 'status', 'pid', 'working_directory', 'tags', 'created_at', 'started_at'],
        limit: 1000,
        includeArchived: true,
      });

      for (const candidate of candidates) {
        if (!candidate || candidate.id === excludeTaskId) continue;
        if (!taskHasFactoryTag(candidate, `factory:work_item_id=${workItemId}`)) continue;
        if (batchId && !taskHasFactoryTag(candidate, `factory:batch_id=${batchId}`)) continue;
        if (normalizeWorktreePathForCompare(candidate.working_directory) !== normalizedPath) continue;
        if (isLiveWorktreeOwner(candidate) || isReusableWorktreeOwner(candidate)) {
          return candidate;
        }
        if (String(candidate.status || '').toLowerCase() === 'pending_approval') {
          return candidate;
        }
      }
    } catch (error) {
      logger.warn('factory worktree: replacement owner lookup failed before reclaim guard', {
        project_id: projectId,
        work_item_id: workItemId,
        batch_id: batchId || null,
        worktree_path: worktreePath,
        err: error && error.message,
      });
    }

    return null;
  }

  function findLiveReplacementWorktreeOwner(args) {
    const candidate = findReplacementWorktreeOwner({
      ...args,
      statuses: LIVE_WORKTREE_OWNER_STATUSES,
    });
    return isLiveWorktreeOwner(candidate) ? candidate : null;
  }

  function findReusableReplacementWorktreeOwner(args) {
    const candidate = findReplacementWorktreeOwner({
      ...args,
      statuses: REUSABLE_WORKTREE_OWNER_STATUSES,
    });
    return isReusableWorktreeOwner(candidate) ? candidate : null;
  }

  function getReusedFactoryWorktreeBaseRef(record, project, worktreePath) {
    return record?.base_branch
      || record?.baseBranch
      || detectDefaultBranch(worktreePath || project?.path || process.cwd())
      || 'main';
  }

  function getStaleBranchCommitThreshold(project) {
    try {
      const projectConfig = project?.config_json ? JSON.parse(project.config_json) : {};
      const thresholdValue = Number(projectConfig.stale_branch_commit_threshold);
      return Number.isFinite(thresholdValue) ? thresholdValue : 0;
    } catch {
      return 0;
    }
  }

  async function ensureReusedFactoryWorktreeFresh({
    project,
    workItem,
    worktreeRecord,
    worktreePath,
    batchId,
    reuseContext,
  }) {
    const branch = worktreeRecord?.branch || null;
    if (!worktreeRecord || !worktreePath || !branch) {
      return { ok: true, checked: false, reason: 'missing_worktree_metadata' };
    }

    const baseRef = getReusedFactoryWorktreeBaseRef(worktreeRecord, project, worktreePath);
    const threshold = getStaleBranchCommitThreshold(project);
    const gitHealth = await checkWorktreeGitHealth(worktreePath);
    if (!gitHealth.ok) {
      const fallbackSuffix = `preserved-invalid-${worktreeRecord.id}`;
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'factory_worktree_reuse_invalid_detected',
        reasoning: `Reused factory worktree ${branch} has unusable Git metadata; preserving it and creating a fresh suffixed worktree for ${reuseContext}.`,
        inputs: { ...getWorkItemDecisionContext(workItem) },
        outcome: {
          factory_worktree_id: worktreeRecord.id,
          worktree_id: worktreeRecord.vcWorktreeId,
          worktree_path: worktreePath,
          branch,
          baseRef,
          threshold,
          reuse_context: reuseContext,
          reason: gitHealth.reason,
          error: gitHealth.error,
          fallback_suffix: fallbackSuffix,
        },
        confidence: 1,
        batch_id: batchId,
      });
      return {
        ok: false,
        checked: true,
        invalidWorktree: true,
        preserveWorktree: true,
        fallbackSuffix,
        gitHealth,
        baseRef,
        threshold,
      };
    }

    const freshness = await branchFreshness.checkBranchFreshness({
      worktreePath,
      branch,
      baseRef,
      threshold,
    });

    if (!freshness.stale) {
      return { ok: true, checked: true, freshness, baseRef, threshold };
    }

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'factory_worktree_reuse_stale_detected',
      reasoning: `Reused factory worktree ${branch} is stale versus ${baseRef}; attempting automatic rebase before ${reuseContext}.`,
      inputs: { ...getWorkItemDecisionContext(workItem) },
      outcome: {
        factory_worktree_id: worktreeRecord.id,
        worktree_id: worktreeRecord.vcWorktreeId,
        worktree_path: worktreePath,
        branch,
        baseRef,
        threshold,
        commits_behind: freshness.commitsBehind,
        stale_files: freshness.staleFiles,
        reuse_context: reuseContext,
      },
      confidence: 1,
      batch_id: batchId,
    });

    const rebaseResult = await branchFreshness.attemptRebase(worktreePath, branch, baseRef);
    if (rebaseResult.ok) {
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'factory_worktree_reuse_auto_rebased',
        reasoning: `Automatically rebased reused factory worktree ${branch} onto ${baseRef} before ${reuseContext}.`,
        inputs: { ...getWorkItemDecisionContext(workItem) },
        outcome: {
          factory_worktree_id: worktreeRecord.id,
          worktree_id: worktreeRecord.vcWorktreeId,
          worktree_path: worktreePath,
          branch,
          baseRef,
          reuse_context: reuseContext,
        },
        confidence: 1,
        batch_id: batchId,
      });
      return { ok: true, checked: true, rebased: true, freshness, rebaseResult, baseRef, threshold };
    }

    const dirtyStatus = getWorktreeDirtyStatus(worktreePath);
    if (isDirtyRebaseFailure(rebaseResult.error) || isConflictRebaseFailure(rebaseResult.error) || dirtyStatus.dirty) {
      const fallbackSuffix = `preserved-dirty-${worktreeRecord.id}`;
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'factory_worktree_reuse_dirty_preserved',
        reasoning: `Reused factory worktree ${branch} could not rebase cleanly and now has uncommitted changes; preserving it and creating a suffixed fresh worktree for ${reuseContext}.`,
        inputs: { ...getWorkItemDecisionContext(workItem) },
        outcome: {
          factory_worktree_id: worktreeRecord.id,
          worktree_id: worktreeRecord.vcWorktreeId,
          worktree_path: worktreePath,
          branch,
          baseRef,
          threshold,
          commits_behind: freshness.commitsBehind,
          stale_files: freshness.staleFiles,
          reuse_context: reuseContext,
          fallback_suffix: fallbackSuffix,
          dirty_checked: dirtyStatus.checked,
          dirty_reason: dirtyStatus.reason || null,
        },
        confidence: 1,
        batch_id: batchId,
      });
      return {
        ok: false,
        checked: true,
        rebased: false,
        dirtyWorktree: true,
        dirtyStatus,
        fallbackSuffix,
        freshness,
        rebaseResult,
        baseRef,
        threshold,
      };
    }

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'factory_worktree_reuse_rebase_failed',
      reasoning: `Automatic rebase of reused factory worktree ${branch} onto ${baseRef} failed; skipping reuse so the factory can create a fresh worktree.`,
      inputs: { ...getWorkItemDecisionContext(workItem) },
      outcome: {
        factory_worktree_id: worktreeRecord.id,
        worktree_id: worktreeRecord.vcWorktreeId,
        worktree_path: worktreePath,
        branch,
        baseRef,
        threshold,
        commits_behind: freshness.commitsBehind,
        stale_files: freshness.staleFiles,
        error: rebaseResult.error,
        reuse_context: reuseContext,
      },
      confidence: 1,
      batch_id: batchId,
    });
    return { ok: false, checked: true, rebased: false, freshness, rebaseResult, baseRef, threshold };
  }

  async function maybeReuseCompletedWorktreeOwner({
    owner,
    ownerStatus,
    ownerSource,
    stale,
    staleWorktreePath,
    targetBranch,
    project,
    targetItem,
    executeLogBatchId,
  }) {
    if (!isReusableWorktreeOwner(owner, ownerStatus) || !staleWorktreePath || !fs.existsSync(staleWorktreePath)) {
      return null;
    }

    const freshness = await ensureReusedFactoryWorktreeFresh({
      project,
      workItem: targetItem,
      worktreeRecord: stale,
      worktreePath: staleWorktreePath,
      batchId: executeLogBatchId,
      reuseContext: 'completed_owner_reuse',
    });
    if (!freshness.ok) {
      if (freshness.dirtyWorktree || freshness.preserveWorktree) {
        const fallbackSuffix = freshness.fallbackSuffix || `preserved-dirty-${stale.id}`;
        factoryWorktrees.markPreserved(
          stale.id,
          freshness.invalidWorktree
            ? `invalid_git_metadata_before_completed_owner_reuse_fallback:${ownerSource || 'unknown_owner'}`
            : `dirty_before_completed_owner_reuse_fallback:${ownerSource || 'unknown_owner'}`,
        );
        return { preservedDirtyFallbackSuffix: fallbackSuffix };
      }
      return null;
    }

    adoptReplacementWorktreeOwner({
      owner,
      ownerSource,
      stale,
      project,
      targetItem,
      targetBranch,
      context: 'completed_reuse',
    });

    logger.info('factory worktree: reusing active worktree with completed owner before create', {
      project_id: project.id,
      work_item_id: targetItem.id,
      branch: targetBranch,
      factory_worktree_id: stale.id,
      owning_task_id: owner.id,
      owning_status: String(ownerStatus || owner.status || '').toLowerCase(),
      owner_source: ownerSource,
      worktree_path: staleWorktreePath,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: ownerSource === 'replacement_task_same_worktree'
        ? 'worktree_reused_completed_replacement_owner'
        : 'worktree_reused_completed_owner',
      reasoning: ownerSource === 'replacement_task_same_worktree'
        ? 'Reused the active factory worktree because a completed restart-cloned task used the same path; reclaiming here would discard completed task output.'
        : 'Reused the active factory worktree because its owning task completed; reclaiming here would discard completed task output.',
      inputs: { ...getWorkItemDecisionContext(targetItem) },
      outcome: {
        factory_worktree_id: stale.id,
        stale_batch_id: stale.batch_id,
        branch: targetBranch,
        owning_task_id: owner.id,
        owning_status: String(ownerStatus || owner.status || '').toLowerCase(),
        owner_source: ownerSource,
        worktree_path: staleWorktreePath,
      },
      confidence: 1,
      batch_id: executeLogBatchId,
    });

    prepareReusedFactoryWorktreeDependencies(staleWorktreePath, {
      project_id: project.id,
      work_item_id: targetItem.id,
      batch_id: executeLogBatchId,
      reuse_context: 'completed_owner',
      owner_source: ownerSource,
    });

    return {
      worktreeRecord: stale,
      executionWorkingDirectory: staleWorktreePath,
    };
  }

  function adoptReplacementWorktreeOwner({
    owner,
    ownerSource,
    stale,
    project,
    targetItem,
    targetBranch,
    context,
  }) {
    if (ownerSource !== 'replacement_task_same_worktree' || !stale?.id || !owner?.id) {
      return null;
    }
    if (stale.owningTaskId === owner.id || stale.owning_task_id === owner.id) {
      return stale;
    }

    try {
      const adopted = factoryWorktrees.setOwningTask(stale.id, owner.id);
      logger.info('factory worktree: adopted restart-cloned replacement owner', {
        project_id: project?.id || null,
        work_item_id: targetItem?.id || null,
        branch: targetBranch || stale.branch || null,
        factory_worktree_id: stale.id,
        previous_owning_task_id: stale.owningTaskId || stale.owning_task_id || null,
        owning_task_id: owner.id,
        context: context || null,
      });
      return adopted || stale;
    } catch (ownErr) {
      logger.warn('factory worktree: failed to adopt restart-cloned replacement owner', {
        project_id: project?.id || null,
        work_item_id: targetItem?.id || null,
        branch: targetBranch || stale.branch || null,
        factory_worktree_id: stale.id,
        previous_owning_task_id: stale.owningTaskId || stale.owning_task_id || null,
        owning_task_id: owner.id,
        context: context || null,
        err: ownErr && ownErr.message,
      });
      return stale;
    }
  }

  function resolveTaskReplacementChain(taskCore, taskId) {
    let currentTaskId = normalizeOptionalString(taskId);
    let currentTask = getPlanGenerationTask(taskCore, currentTaskId);
    const seen = new Set();

    while (currentTaskId && currentTask && !seen.has(currentTaskId)) {
      seen.add(currentTaskId);
      const replacementId = normalizeOptionalString(getTaskMetadataObject(currentTask).resubmitted_as);
      if (!replacementId || replacementId === currentTaskId) {
        break;
      }
      const replacementTask = getPlanGenerationTask(taskCore, replacementId);
      if (!replacementTask) {
        break;
      }
      currentTaskId = replacementId;
      currentTask = replacementTask;
    }

    return {
      taskId: currentTaskId,
      task: currentTask,
      replaced: currentTaskId !== taskId,
    };
  }

  function getActiveBatchWorktreeForPlanGate({ projectId, workItemId, batchId }) {
    if (!projectId || !workItemId || !batchId) {
      return null;
    }

    try {
      return factoryWorktrees.getActiveWorktreeByBatchAndWorkItem(batchId, workItemId);
    } catch (err) {
      logger.debug('Factory plan gate: active worktree lookup failed', {
        project_id: projectId,
        work_item_id: workItemId,
        batch_id: batchId,
        err: err && err.message,
      });
      return null;
    }
  }

  function getLiveActiveBatchWorktreeOwner({
    projectId,
    workItemId,
    batchId,
    activeWorktree = null,
  }) {
    if (!projectId || !workItemId || !batchId) {
      return null;
    }
    const owningTaskId = activeWorktree?.owningTaskId || activeWorktree?.owning_task_id || null;
    if (!activeWorktree || !owningTaskId) {
      return null;
    }

    let owner = null;
    try {
      const taskCore = require('../db/task-core');
      owner = typeof taskCore.getTask === 'function' ? taskCore.getTask(owningTaskId) : null;
    } catch (err) {
      logger.debug('Factory batch owner lookup: task-core unavailable', {
        project_id: projectId,
        work_item_id: workItemId,
        batch_id: batchId,
        owning_task_id: owningTaskId,
        err: err && err.message,
      });
      return null;
    }

    const ownerStatus = String(owner?.status || '').toLowerCase();
    if (!isLiveWorktreeOwner(owner, ownerStatus)) {
      return null;
    }

    return {
      worktree: activeWorktree,
      owner,
      ownerStatus,
    };
  }

  function getFactoryWorktreePath(record) {
    return record?.worktreePath || record?.worktree_path || null;
  }

  function getFactoryWorktreeWorkItemId(record) {
    const value = record?.workItemId ?? record?.work_item_id ?? null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  function factoryWorktreeBelongsToWorkItem(record, workItem) {
    const worktreeWorkItemId = getFactoryWorktreeWorkItemId(record);
    const currentWorkItemId = Number(workItem?.id);
    return Number.isInteger(worktreeWorkItemId)
      && Number.isInteger(currentWorkItemId)
      && worktreeWorkItemId === currentWorkItemId;
  }

  function prepareReusedFactoryWorktreeDependencies(worktreePath, context = {}) {
    if (!worktreePath) {
      return null;
    }
    try {
      return prepareWorktreeVerifyDependencies(worktreePath, logger);
    } catch (error) {
      logger.warn('factory worktree: dependency preparation failed for reused worktree', {
        worktree_path: worktreePath,
        context,
        err: error && error.message ? error.message : String(error),
      });
      return {
        prepared: false,
        reason: error && error.message ? error.message : String(error),
        packages: [],
      };
    }
  }

  return {
    isLiveWorktreeOwner,
    isReusableWorktreeOwner,
    getWorktreeDirtyStatus,
    findLiveReplacementWorktreeOwner,
    findReusableReplacementWorktreeOwner,
    ensureReusedFactoryWorktreeFresh,
    maybeReuseCompletedWorktreeOwner,
    adoptReplacementWorktreeOwner,
    resolveTaskReplacementChain,
    getActiveBatchWorktreeForPlanGate,
    getLiveActiveBatchWorktreeOwner,
    getFactoryWorktreePath,
    getFactoryWorktreeWorkItemId,
    factoryWorktreeBelongsToWorkItem,
    prepareReusedFactoryWorktreeDependencies,
  };
}

module.exports = { createWorktreeOwner };
