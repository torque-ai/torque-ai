'use strict';

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`Missing LEARN stage dependency: ${name}`);
  }
}

function createLearnStage({
  CLOSED_WORK_ITEM_STATUSES,
  LOOP_STATES,
  PENDING_APPROVAL_FAILURE_TASK_STATUSES,
  PENDING_APPROVAL_SUCCESS_TASK_STATUSES,
  createShippedDetector,
  detectDefaultBranch,
  factoryDecisions,
  factoryHealth,
  factoryIntake,
  factoryWorktrees,
  fs,
  getDecisionRowWorkItemId,
  getLatestExecutionDecisionForWorkItem,
  getLatestStartedExecutionDecision,
  getProjectOrThrow,
  getRememberedSelectedWorkItemId,
  getWorktreeRunner,
  listTasksForFactoryBatch,
  logger,
  normalizeWorkItemId,
  rememberSelectedWorkItem,
  routeWorkItemToNeedsReplan,
  safeLogDecision,
} = {}) {
  assertFunction(factoryDecisions?.listDecisions, 'factoryDecisions.listDecisions');
  assertFunction(factoryHealth?.updateProject, 'factoryHealth.updateProject');
  assertFunction(factoryIntake?.getWorkItemForProject, 'factoryIntake.getWorkItemForProject');
  assertFunction(factoryWorktrees?.getActiveWorktree, 'factoryWorktrees.getActiveWorktree');
  assertFunction(createShippedDetector, 'createShippedDetector');
  assertFunction(detectDefaultBranch, 'detectDefaultBranch');
  assertFunction(fs?.existsSync, 'fs.existsSync');
  assertFunction(getDecisionRowWorkItemId, 'getDecisionRowWorkItemId');
  assertFunction(getLatestExecutionDecisionForWorkItem, 'getLatestExecutionDecisionForWorkItem');
  assertFunction(getLatestStartedExecutionDecision, 'getLatestStartedExecutionDecision');
  assertFunction(getProjectOrThrow, 'getProjectOrThrow');
  assertFunction(getRememberedSelectedWorkItemId, 'getRememberedSelectedWorkItemId');
  assertFunction(getWorktreeRunner, 'getWorktreeRunner');
  assertFunction(listTasksForFactoryBatch, 'listTasksForFactoryBatch');
  assertFunction(normalizeWorkItemId, 'normalizeWorkItemId');
  assertFunction(rememberSelectedWorkItem, 'rememberSelectedWorkItem');
  assertFunction(routeWorkItemToNeedsReplan, 'routeWorkItemToNeedsReplan');
  assertFunction(safeLogDecision, 'safeLogDecision');

  // Fix 2: detect the "no commits ahead of <base>" merge-time failure that
  // signals an empty execution. Pure helpers are exported for testability.
  function isEmptyBranchMergeError(message) {
    return typeof message === 'string' && /no commits ahead/i.test(message);
  }

  function countPriorEmptyMergeFailuresForWorkItem(decisions, workItemId) {
    if (!Array.isArray(decisions) || workItemId == null) return 0;
    return decisions.filter((d) => {
      if (!d || d.action !== 'worktree_merge_failed') return false;
      const outcome = d.outcome || {};
      if (outcome.work_item_id !== workItemId) return false;
      return isEmptyBranchMergeError(outcome.error || '');
    }).length;
  }

  function shouldQuarantineForEmptyMerges({ currentErrorMessage, priorDecisions, workItemId, threshold = 1 }) {
    if (!isEmptyBranchMergeError(currentErrorMessage)) return false;
    return countPriorEmptyMergeFailuresForWorkItem(priorDecisions, workItemId) >= threshold;
  }

  function isMergeTargetOperatorBlockedError(err) {
    return Boolean(err && (
      err.code === 'IN_PROGRESS_GIT_OPERATION'
      || err.code === 'MAIN_REPO_SEMANTIC_DRIFT'
    ));
  }

  function resolvePendingApprovalBatchId(project, workItem, executionDecision, startedExecutionDecision) {
    return startedExecutionDecision?.outcome?.batch_id
      || executionDecision?.batch_id
      || workItem?.batch_id
      || project?.loop_batch_id
      || startedExecutionDecision?.batch_id
      || null;
  }

  function evaluatePendingApprovalExecution(project, workItem, executionDecision, startedExecutionDecision) {
    const decisionAction = executionDecision?.action || null;
    const decisionBatchId = resolvePendingApprovalBatchId(
      project,
      workItem,
      executionDecision,
      startedExecutionDecision
    );

    if (!decisionBatchId) {
      return {
        should_ship: false,
        reason: 'pending_approval_not_submitted',
        decision_action: decisionAction,
        decision_batch_id: null,
      };
    }

    const batchTasks = listTasksForFactoryBatch(decisionBatchId);
    if (batchTasks.length === 0) {
      return {
        should_ship: false,
        reason: 'pending_approval_not_submitted',
        decision_action: decisionAction,
        decision_batch_id: decisionBatchId,
      };
    }

    const failedTask = batchTasks.find((task) => PENDING_APPROVAL_FAILURE_TASK_STATUSES.has(task.status));
    if (failedTask) {
      return {
        should_ship: false,
        reason: `pending_approval_task_${failedTask.status}`,
        decision_action: decisionAction,
        decision_batch_id: decisionBatchId,
      };
    }

    const unfinishedTask = batchTasks.find((task) => !PENDING_APPROVAL_SUCCESS_TASK_STATUSES.has(task.status));
    if (unfinishedTask) {
      return {
        should_ship: false,
        reason: 'pending_approval_in_progress',
        decision_action: decisionAction,
        decision_batch_id: decisionBatchId,
      };
    }

    return {
      should_ship: true,
      reason: 'execute_completed_successfully',
      decision_action: decisionAction,
      decision_batch_id: decisionBatchId,
    };
  }

  function evaluateWorkItemShipping(project, workItem, options = {}) {
    const projectId = typeof project === 'string' ? project : project?.id;
    const normalizedWorkItemId = normalizeWorkItemId(workItem?.id ?? workItem);
    const executionDecision = getLatestExecutionDecisionForWorkItem(projectId, normalizedWorkItemId);
    if (!executionDecision) {
      return {
        should_ship: false,
        reason: 'no_execute_result',
        decision_action: null,
        decision_batch_id: null,
      };
    }

    const outcome = executionDecision.outcome || {};
    const decisionAction = executionDecision.action || null;

    if (decisionAction === 'execution_failed') {
      return {
        should_ship: false,
        reason: outcome.failed_task ? `task_${outcome.failed_task}_failed` : 'execution_failed',
        decision_action: decisionAction,
        decision_batch_id: executionDecision.batch_id || null,
      };
    }

    if (decisionAction !== 'completed_execution') {
      return {
        should_ship: false,
        reason: `unfinished_${decisionAction || 'execution'}`,
        decision_action: decisionAction,
        decision_batch_id: executionDecision.batch_id || null,
      };
    }

    if (outcome.failed_task) {
      return {
        should_ship: false,
        reason: `task_${outcome.failed_task}_failed`,
        decision_action: decisionAction,
        decision_batch_id: executionDecision.batch_id || null,
      };
    }

    if (outcome.dry_run === true) {
      if ((outcome.execution_mode || null) === 'pending_approval') {
        return evaluatePendingApprovalExecution(
          typeof project === 'string' ? null : project,
          typeof workItem === 'object' ? workItem : { id: normalizedWorkItemId },
          executionDecision,
          options.startedExecutionDecision || null
        );
      }

      return {
        should_ship: false,
        reason: `${outcome.execution_mode || 'dry_run'}_execution_not_final`,
        decision_action: decisionAction,
        decision_batch_id: executionDecision.batch_id || null,
      };
    }

    if (outcome.execution_mode && outcome.execution_mode !== 'live') {
      return {
        should_ship: false,
        reason: `${outcome.execution_mode}_execution_not_final`,
        decision_action: decisionAction,
        decision_batch_id: executionDecision.batch_id || null,
      };
    }

    return {
      should_ship: true,
      reason: 'execute_completed_successfully',
      decision_action: decisionAction,
      decision_batch_id: executionDecision.batch_id || null,
    };
  }

  async function maybeShipWorkItemAfterLearn(project_id, batch_id, instance) {
    try {
      const project = getProjectOrThrow(project_id);
      const rememberedWorkItemId = getRememberedSelectedWorkItemId(instance.id);
      const startedExecutionDecision = getLatestStartedExecutionDecision(project_id);
      const workItemId = rememberedWorkItemId || normalizeWorkItemId(instance?.work_item_id) || getDecisionRowWorkItemId(startedExecutionDecision);
      const resolutionSource = rememberedWorkItemId ? 'tracked_selection' : 'started_execution';
      const decisionBatchId = batch_id
        || startedExecutionDecision?.outcome?.batch_id
        || instance?.batch_id
        || project.loop_batch_id
        || startedExecutionDecision?.batch_id
        || null;

      if (!workItemId) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'no_selected_work_item',
          reasoning: 'LEARN stage could not resolve a selected work item to close.',
          inputs: {
            batch_id: batch_id || null,
            resolution_source: rememberedWorkItemId ? 'tracked_selection' : 'started_execution',
          },
          outcome: {
            reason: 'no_selected_work_item',
            work_item_id: null,
            batch_id: batch_id || null,
          },
          confidence: 1,
          batch_id: decisionBatchId,
        });
        return {
          status: 'skipped',
          reason: 'no_selected_work_item',
          work_item_id: null,
        };
      }

      const workItem = factoryIntake.getWorkItemForProject(project_id, workItemId, {
        includeClosed: true,
      });

      if (!workItem) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'no_selected_work_item',
          reasoning: 'LEARN stage found a selected work item id, but the record is no longer available.',
          inputs: {
            batch_id: batch_id || null,
            resolution_source: resolutionSource,
          },
          outcome: {
            reason: 'work_item_missing',
            work_item_id: workItemId,
            batch_id: batch_id || null,
          },
          confidence: 1,
          batch_id: decisionBatchId,
        });
        return {
          status: 'skipped',
          reason: 'work_item_missing',
          work_item_id: workItemId,
        };
      }

      rememberSelectedWorkItem(instance.id, workItem);

      if (CLOSED_WORK_ITEM_STATUSES.has(workItem.status)) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'already_closed',
          reasoning: 'LEARN stage skipped shipping because the selected work item is already closed.',
          inputs: {
            batch_id: batch_id || null,
            resolution_source: resolutionSource,
            work_item_status: workItem.status,
          },
          outcome: {
            work_item_id: workItem.id,
            work_item_status: workItem.status,
            reason: 'already_closed',
          },
          confidence: 1,
          batch_id: decisionBatchId,
        });
        return {
          status: 'skipped',
          reason: 'already_closed',
          work_item_id: workItem.id,
        };
      }

      const shippingDecision = evaluateWorkItemShipping(project, workItem, {
        startedExecutionDecision,
      });
      if (!shippingDecision.should_ship) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'skipped_shipping',
          reasoning: 'LEARN stage left the selected work item open because EXECUTE did not finish successfully.',
          inputs: {
            batch_id: batch_id || null,
            resolution_source: resolutionSource,
            work_item_status: workItem.status,
          },
          outcome: {
            work_item_id: workItem.id,
            work_item_status: workItem.status,
            reason: shippingDecision.reason,
            execution_action: shippingDecision.decision_action,
          },
          confidence: 1,
          batch_id: shippingDecision.decision_batch_id || decisionBatchId,
        });
        return {
          status: 'skipped',
          reason: shippingDecision.reason,
          work_item_id: workItem.id,
        };
      }

      // Merge the factory worktree into main before marking the work item
      // shipped. If merge fails, leave the item open with a skipped_shipping
      // decision so the operator can resolve the conflict.
      let worktreeRecord = (batch_id || instance?.batch_id)
        ? factoryWorktrees.getActiveWorktreeByBatch(batch_id || instance?.batch_id)
        : factoryWorktrees.getActiveWorktree(project_id);

      // If the DB thinks the worktree is active but the directory is gone
      // (restart janitor, manual rm, or corrupted state), abandon it and
      // fall through to the no-worktree recovery path below — otherwise
      // the merge call will crash and the loop will retry forever.
      if (worktreeRecord && worktreeRecord.worktreePath
          && !fs.existsSync(worktreeRecord.worktreePath)) {
        try {
          factoryWorktrees.markAbandoned(
            worktreeRecord.id,
            'worktreePath_missing_on_disk_at_learn',
          );
        } catch (_e) { void _e; }
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'worktree_path_missing_abandoned',
          reasoning: 'Active factory worktree DB row points to a path that no longer exists on disk. Marking abandoned and falling through to no-worktree recovery.',
          outcome: {
            work_item_id: workItem.id,
            worktree_id: worktreeRecord.id,
            worktree_path: worktreeRecord.worktreePath,
            branch: worktreeRecord.branch,
          },
          confidence: 1,
          batch_id: shippingDecision.decision_batch_id || decisionBatchId,
        });
        worktreeRecord = null;
      }

      const worktreeRunnerAvailable = getWorktreeRunner();
      const worktreeRunner = worktreeRecord ? worktreeRunnerAvailable : null;

      // Fail loud when the runner is available but no active worktree is
      // found. Either the worktree was abandoned manually, cleaned up by a
      // restart janitor, or the EXECUTE batch never created one — none of
      // which are states where we should silently mark the item shipped.
      // Exception: if a prior loop already merged a worktree for this item,
      // it's genuinely done and marking shipped is correct.
      if (worktreeRunnerAvailable && !worktreeRecord) {
        const priorWorktree = factoryWorktrees.getLatestWorktreeForWorkItem(
          project_id,
          workItem.id,
        );
        if (!priorWorktree || priorWorktree.status !== 'merged') {
          // Reject the work item instead of just skipping — otherwise
          // PRIORITIZE will re-select it on the next cycle and we spin
          // forever. This was the exact failure mode that kept work
          // item 115 in 'executing' state for 11+ hours on 2026-04-18
          // after its worktree directory was cleaned up by a restart
          // janitor.
          const rejectReason = priorWorktree
            ? `no_worktree_for_batch_prior_status=${priorWorktree.status}`
            : 'no_worktree_for_batch_after_execute';
          try {
            factoryIntake.updateWorkItem(workItem.id, {
              status: 'rejected',
              reject_reason: rejectReason,
            });
          } catch (_e) { void _e; }
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.LEARN,
            action: 'auto_rejected_no_worktree',
            reasoning: 'LEARN found no active worktree to merge and no prior merged worktree for this work item. Rejecting so PRIORITIZE does not re-select it.',
            inputs: {
              batch_id: batch_id || instance?.batch_id || null,
              resolution_source: resolutionSource,
              work_item_status: workItem.status,
            },
            outcome: {
              work_item_id: workItem.id,
              reason: rejectReason,
              prior_worktree_id: priorWorktree ? priorWorktree.id : null,
              prior_worktree_status: priorWorktree ? priorWorktree.status : null,
            },
            confidence: 1,
            batch_id: shippingDecision.decision_batch_id || decisionBatchId,
          });
          return {
            status: 'rejected',
            reason: rejectReason,
            work_item_id: workItem.id,
          };
        }
        // priorWorktree is merged → the code already landed in a prior
        // loop, this LEARN is just catching up the work item status.
      }

      if (worktreeRecord && worktreeRunner) {
        try {
          // Use the worktree's base_branch if stored on the factory_worktrees
          // row; otherwise re-detect from the repo (bitsy uses master, the
          // hardcoded 'main' default produces `git rev-list main..feat/...`
          // → unknown revision → worktree_merge_failed). detectDefaultBranch
          // consults origin/HEAD and falls back to whichever of master/main
          // actually exists locally.
        const mergeTarget = worktreeRecord.base_branch
            || worktreeRecord.baseBranch
            || detectDefaultBranch(project.path)
            || 'main';
          const mergeResult = await worktreeRunner.mergeToMain({
            id: worktreeRecord.vcWorktreeId,
            branch: worktreeRecord.branch,
            target: mergeTarget,
            strategy: 'merge',
          });
          factoryWorktrees.markMerged(worktreeRecord.id);
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.LEARN,
            action: 'worktree_merged',
            reasoning: `Merged factory worktree ${worktreeRecord.branch} into main.`,
            outcome: {
              branch: worktreeRecord.branch,
              target_branch: 'main',
              strategy: mergeResult && mergeResult.strategy,
              cleaned: mergeResult && mergeResult.cleaned,
              worktree_id: worktreeRecord.vcWorktreeId,
              factory_worktree_id: worktreeRecord.id,
            },
            confidence: 1,
            batch_id: shippingDecision.decision_batch_id || decisionBatchId,
          });
          if (mergeResult && mergeResult.cleanup_failed) {
            logger.warn('worktree cleanup failed after successful merge; marking work item shipped', {
              project_id,
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              err: mergeResult.cleanup_error,
            });
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.LEARN,
              action: 'worktree_merged_cleanup_failed',
              reasoning: `Merged factory worktree ${worktreeRecord.branch} into main, but cleanup failed afterward.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                worktree_id: worktreeRecord.vcWorktreeId,
                factory_worktree_id: worktreeRecord.id,
                target_branch: 'main',
                strategy: mergeResult.strategy,
                cleaned: false,
                cleanup_failed: true,
                cleanup_error: mergeResult.cleanup_error || null,
              },
              confidence: 1,
              batch_id: shippingDecision.decision_batch_id || decisionBatchId,
            });
          }
        } catch (err) {
          // Empty-branch case: EXECUTE produced zero commits. Either the work
          // was already shipped in a prior session (→ mark shipped) or the
          // provider gave up (→ reject, not skip — skip causes PRIORITIZE to
          // re-select the same item and loop forever).
          const isEmptyBranch = /no commits ahead/i.test(err.message || '');
          if (isEmptyBranch) {
            const resolveEmptyBranch = () => {
              let detection = null;
              try {
                const planPath = workItem?.origin?.plan_path || null;
                const planContent = planPath && fs.existsSync(planPath)
                  ? fs.readFileSync(planPath, 'utf8')
                  : '';
              const detector = createShippedDetector({ repoRoot: project.path });
                detection = detector.detectShipped({ content: planContent, title: workItem.title });
              } catch (detErr) {
                logger.debug('empty-branch shipped-detector error', { err: detErr.message });
              }

              const sharedOutcome = {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                worktree_id: worktreeRecord.vcWorktreeId,
                factory_worktree_id: worktreeRecord.id,
                error: err.message,
                detection: detection ? {
                  shipped: detection.shipped,
                  confidence: detection.confidence,
                  signals: detection.signals,
                } : null,
              };

              if (detection && detection.shipped) {
                factoryIntake.updateWorkItem(workItem.id, { status: 'shipped' });
                rememberSelectedWorkItem(
                  instance.id,
                  factoryIntake.getWorkItemForProject(project_id, workItem.id, { includeClosed: true })
                );
                factoryIntake.releaseClaimForInstance(instance.id);
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.LEARN,
                  action: 'auto_shipped_empty_branch',
                  reasoning: `Merge failed (no commits ahead) but shipped-detector found matching evidence on main (${detection.confidence} confidence). Marking shipped instead of leaving the loop stuck.`,
                  inputs: {
                    batch_id: batch_id || null,
                    resolution_source: resolutionSource,
                  },
                  outcome: { ...sharedOutcome, work_item_id: workItem.id },
                  confidence: 1,
                  batch_id: shippingDecision.decision_batch_id || decisionBatchId,
                });
                return {
                  status: 'passed',
                  reason: 'auto_shipped_empty_branch',
                  work_item_id: workItem.id,
                };
              }

              // Phase X4: route to needs_replan instead of terminal rejection.
              // Empty-branch-after-execute means the worker ran but produced
              // no diff. The next architect attempt should produce a sharper
              // plan — possibly with a smaller scope or different file
              // targets — rather than abandoning the work item. PRIORITIZE
              // re-picks after the X1 cooldown.
              const routed = routeWorkItemToNeedsReplan(workItem, {
                reason: 'empty_branch_after_execute',
                details: { batch_id: batch_id || null, resolution_source: resolutionSource },
              });
              factoryIntake.releaseClaimForInstance(instance.id);
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.LEARN,
                action: 'empty_branch_routed_to_needs_replan',
                reasoning: 'Merge failed (no commits ahead) and shipped-detector did not find matching evidence on main. Per the plan-evolution model, routing to needs_replan instead of terminal rejection (Phase X4) — the next architect attempt can produce a different plan shape.',
                inputs: {
                  batch_id: batch_id || null,
                  resolution_source: resolutionSource,
                },
                outcome: { ...sharedOutcome, work_item_id: routed.id, next_status: 'needs_replan' },
                confidence: 1,
                batch_id: shippingDecision.decision_batch_id || decisionBatchId,
              });
              return {
                status: 'needs_replan',
                reason: 'empty_branch_after_execute — routed to needs_replan',
                work_item_id: routed.id,
              };
            };

            try {
              return resolveEmptyBranch();
            } catch (resolveErr) {
              logger.warn('empty-branch resolution failed; falling back to skipped', {
                project_id,
                err: resolveErr.message,
              });
              // fall through to the original leave-open path below
            }
          }

          // If the target repo is operator-blocked, retrying every ~60s is
          // pointless and can re-enter the same verified work item into PLAN.
          // Pause the project so the operator gets a single clear signal instead
          // of a retry storm. Mid-merge/rebase was observed against bitsy on
          // 2026-04-20; dirty/untracked merge targets reproduced against example-project
          // on 2026-04-29 after a successful Ollama canary verify.
          if (isMergeTargetOperatorBlockedError(err)) {
            const isGitOperation = err.code === 'IN_PROGRESS_GIT_OPERATION';
            const reason = isGitOperation ? 'merge_target_in_conflict_state' : 'merge_target_dirty';
            const action = reason;
            const operatorPath = err.path || worktreeRecord.worktreePath;
            try {
              factoryHealth.updateProject(project_id, { status: 'paused' });
            } catch (_pauseErr) {
              void _pauseErr;
            }
            logger.warn('worktree merge blocked by target repo state; pausing project', {
              project_id,
              branch: worktreeRecord.branch,
              code: err.code,
              err: err.message,
            });
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.LEARN,
              action,
              reasoning: isGitOperation
                ? `Merge target ${operatorPath} is mid-${err.op || 'merge'}; pausing project. `
                  + `Operator must resolve the conflict or run \`git ${err.op || 'merge'} --abort\` before resuming.`
                : `Merge target ${operatorPath} has uncommitted or untracked files; pausing project. `
                  + 'Operator must inspect the target repo and decide whether to commit, remove, or ignore the files before resuming.',
              outcome: {
                work_item_id: workItem.id,
                branch: worktreeRecord.branch,
                op: err.op || null,
                path: operatorPath,
                error: err.message,
                files: Array.isArray(err.files) ? err.files : [],
                dirty_files: Array.isArray(err.dirty_files) ? err.dirty_files : [],
                untracked_files: Array.isArray(err.untracked_files) ? err.untracked_files : [],
                next_state: LOOP_STATES.PAUSED,
                paused_at_stage: LOOP_STATES.LEARN,
              },
              confidence: 1,
              batch_id: shippingDecision.decision_batch_id || decisionBatchId,
            });
            return {
              status: 'paused',
              reason,
              pause_at_stage: LOOP_STATES.LEARN,
              work_item_id: workItem.id,
              error: err.message,
              op: err.op || null,
              files: Array.isArray(err.files) ? err.files : [],
              dirty_files: Array.isArray(err.dirty_files) ? err.dirty_files : [],
              untracked_files: Array.isArray(err.untracked_files) ? err.untracked_files : [],
            };
          }

          logger.warn('worktree merge failed; leaving work item open', {
            project_id,
            branch: worktreeRecord.branch,
            err: err.message,
          });
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.LEARN,
            action: 'worktree_merge_failed',
            reasoning: `Merge failed: ${err.message}. Work item stays open for operator resolution.`,
            outcome: {
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              worktree_id: worktreeRecord.vcWorktreeId,
              factory_worktree_id: worktreeRecord.id,
              work_item_id: workItem.id,
              error: err.message,
            },
            confidence: 1,
            batch_id: shippingDecision.decision_batch_id || decisionBatchId,
          });

          // Fix 2: if this is the second consecutive empty-branch merge failure
          // for the same work item, auto-quarantine it. Otherwise the LEARN
          // stage bounces straight back to SENSE which re-picks the same item
          // and EXECUTE produces another empty branch, looping forever.
          try {
            const priorDecisions = factoryDecisions.listDecisions(project_id, {
              stage: LOOP_STATES.LEARN,
              limit: 200,
            });
            if (shouldQuarantineForEmptyMerges({
              currentErrorMessage: err.message,
              priorDecisions,
              workItemId: workItem.id,
            })) {
              factoryIntake.updateWorkItem(workItem.id, {
                status: 'rejected',
                reject_reason: 'consecutive_empty_executions',
              });
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.LEARN,
                action: 'auto_quarantined_empty_merges',
                reasoning: `Work item ${workItem.id} produced empty branches across consecutive EXECUTE cycles; auto-rejecting so the loop can advance.`,
                outcome: {
                  work_item_id: workItem.id,
                  branch: worktreeRecord.branch,
                },
                confidence: 1,
                batch_id: shippingDecision.decision_batch_id || decisionBatchId,
              });
              return {
                status: 'skipped',
                reason: 'auto_quarantined_empty_merges',
                work_item_id: workItem.id,
                error: err.message,
              };
            }
          } catch (_quarantineErr) {
            void _quarantineErr;
          }

          return {
            status: 'skipped',
            reason: 'worktree_merge_failed',
            work_item_id: workItem.id,
            error: err.message,
          };
        }
      }

      const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
        status: 'shipped',
      });
      rememberSelectedWorkItem(instance.id, updatedWorkItem);
      factoryIntake.releaseClaimForInstance(instance.id);

      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'shipped_work_item',
        reasoning: 'LEARN stage marked the selected work item as shipped after successful execution.',
        inputs: {
          batch_id: batch_id || null,
          resolution_source: resolutionSource,
          previous_status: workItem.status,
        },
        outcome: {
          work_item_id: updatedWorkItem.id,
          previous_status: workItem.status,
          new_status: updatedWorkItem.status,
          reason: shippingDecision.reason,
        },
        confidence: 1,
        batch_id: shippingDecision.decision_batch_id || decisionBatchId,
      });

      return {
        status: 'shipped',
        reason: shippingDecision.reason,
        work_item_id: updatedWorkItem.id,
      };
    } catch (error) {
      logger.warn(`LEARN stage shipping check failed: ${error.message}`, { project_id, batch_id });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'skipped_shipping',
        reasoning: 'LEARN stage shipping check failed unexpectedly.',
        inputs: {
          batch_id: batch_id || null,
        },
        outcome: {
          reason: 'shipping_check_failed',
          error: error.message,
        },
        confidence: 1,
        batch_id: batch_id || null,
      });
      return {
        status: 'skipped',
        reason: 'shipping_check_failed',
        error: error.message,
        work_item_id: null,
      };
    }
  }

  let executeLearnStageForTests = null;

  function setExecuteLearnStageForTests(fn) {
    executeLearnStageForTests = typeof fn === 'function' ? fn : null;
  }

  async function runExecuteLearnStage(project_id, batch_id, instance = null) {
    if (executeLearnStageForTests) {
      return executeLearnStageForTests(project_id, batch_id, instance);
    }
    return executeLearnStage(project_id, batch_id, instance);
  }

  async function executeLearnStage(project_id, batch_id, instance) {
    try {
      const feedback = require('../feedback');
      const analysis = feedback.analyzeBatch(project_id, batch_id);
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'learned',
        reasoning: 'LEARN stage analyzed post-batch feedback.',
        inputs: {
          batch_id,
          signals: {
            health_dimensions: Object.keys(analysis?.health_delta || {}).length,
            task_count: analysis?.execution_metrics?.task_count ?? null,
            guardrail_events: analysis?.guardrail_activity?.total ?? 0,
          },
        },
        outcome: {
          feedback_id: analysis?.feedback_id ?? null,
          summary: analysis?.summary || null,
        },
        confidence: 1,
        batch_id,
      });
      const shippingResult = await maybeShipWorkItemAfterLearn(project_id, batch_id, instance);
      if (analysis && typeof analysis === 'object') {
        analysis.shipping_result = shippingResult || null;
      }
      logger.info('LEARN stage: batch analysis complete', {
        project_id,
        batch_id,
        shipping_status: shippingResult?.status || null,
        shipping_reason: shippingResult?.reason || null,
        work_item_id: shippingResult?.work_item_id || null,
      });
      return analysis;
    } catch (err) {
      logger.warn(`LEARN stage analysis failed: ${err.message}`, { project_id });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'learn_failed',
        reasoning: err.message,
        inputs: {
          batch_id,
          signals: null,
        },
        outcome: {
          status: 'error',
          error: err.message,
        },
        confidence: 1,
        batch_id,
      });
      return { status: 'error', error: err.message };
    }
  }

  return {
    countPriorEmptyMergeFailuresForWorkItem,
    evaluatePendingApprovalExecution,
    evaluateWorkItemShipping,
    executeLearnStage,
    isEmptyBranchMergeError,
    isMergeTargetOperatorBlockedError,
    maybeShipWorkItemAfterLearn,
    runExecuteLearnStage,
    setExecuteLearnStageForTests,
    shouldQuarantineForEmptyMerges,
  };
}

module.exports = {
  createLearnStage,
};
