// VERIFY stage runner — Phase 2c Step B (post-tick policy lifted in).
//
// Before Step B the dispatcher's `case LOOP_STATES.VERIFY` ran the
// policy inline: the already-verified short-circuit (skip the executor
// when the batch already has a verified-batch decision and this is not
// an approved rerun), then pause-at-stage / terminal-outcome /
// move-to-LEARN routing. Step B moves all of that here so the runner
// returns a complete decision.
//
// The runner performs the same instance side effects the legacy case
// did (updateInstanceAndSync on pause, tryMoveInstanceToStage on the
// LEARN advance). It also returns three bridge fields the dispatcher
// consumes directly:
//   - instance:       the (possibly mutated/replaced) instance row.
//   - legacy:         the legacy verify return (or the synthesized
//                     `skipped` object); the dispatcher keeps exposing
//                     it as its `stageResult` local.
//   - advanceResult:  finalizeTerminalVerifyOutcome's runAdvanceLoop
//                     return object for the terminal branch; null when
//                     the loop pauses or continues to LEARN.
// The bridge fields exist because the dispatcher still owns the
// runAdvanceLoop return contract.
//
// `stageResult` stays the lean VerifyStageResult shape so the
// `stage_complete` decision applyOutcome writes is not bloated; the
// full legacy object rides the `legacy` bridge.

const { LOOP_STATES } = require('../loop-states');

// Leaf modules consumed by the Phase 3 createVerifyStage executor body.
// loop-controller-internal helpers are injected via createVerifyStage(deps);
// these stateless modules are required directly (no require cycle).
const factoryHealth = require('../../db/factory/health');
const factoryIntake = require('../../db/factory/intake');
const factoryWorktrees = require('../../db/factory/worktrees');
const branchFreshness = require('../branch-freshness');
const baselineRequeue = require('../baseline-requeue');
const guardrailRunner = require('../guardrail-runner');
const eventBus = require('../../event-bus');
const logger = require('../../logger').child({ component: 'factory-verify-stage' });
const { emitAutoShipped, AUTO_SHIPPED_REASONS } = require('../auto-ship');
const { detectDefaultBranch } = require('../worktree-runner');
const { getEffectiveProjectProvider } = require('../shared/project-config');
const { countPriorVerifyRetryTasksForBatch, detectVerifyStack } = require('../verify-helpers');

const REQUIRED_DEPS = [
  'executeVerifyStage',
  'getLatestStageDecision',
  'hasVerifiedBatchDecision',
  'isTerminalVerifyOutcome',
  'finalizeTerminalVerifyOutcome',
  'tryMoveInstanceToStage',
  'updateInstanceAndSync',
  'nowIso',
];

const RERUN_APPROVED_ACTIONS = ['gate_approved', 'retry_verify_requested'];

// Phase 3: loop-controller-internal function deps injected into
// createVerifyStage. The three constants (MAX_AUTO_VERIFY_RETRIES,
// MAX_SUBMISSION_FAILURES, FATAL_SUBMISSION_REASONS) are validated
// separately by type.
const VERIFY_FN_DEPS = [
  'getWorktreeRunner',
  'listTasksForFactoryBatch',
  'safeLogDecision',
  'resolveFactoryVerifyCommand',
  'isProjectStatusPaused',
  'resolveVerifyEmptyBranch',
  'attemptSilentRerun',
  'submitVerifyFixTask',
  'enforceVerifyRetryScopeEnvelope',
  'getProjectOrThrow',
];

/**
 * @param {{
 *   executeVerifyStage: (projectId, batchId, instance) => Promise<any>,
 *   getLatestStageDecision: (projectId, stage) => object|null,
 *   hasVerifiedBatchDecision: (projectId, batchId) => boolean,
 *   isTerminalVerifyOutcome: (legacy) => boolean,
 *   finalizeTerminalVerifyOutcome: (args) => object,
 *   tryMoveInstanceToStage: (instance, stage, fields) => { instance: object, blocked: boolean },
 *   updateInstanceAndSync: (instanceId, fields) => object,
 *   nowIso: () => string,
 * }} deps
 * @returns {(ctx: import('./types').StageContext) => Promise<import('./types').StageOutcome>}
 */
function createVerifyStageRunner(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createVerifyStageRunner: dep '${name}' is required`);
    }
  }
  const {
    executeVerifyStage,
    getLatestStageDecision,
    hasVerifiedBatchDecision,
    isTerminalVerifyOutcome,
    finalizeTerminalVerifyOutcome,
    tryMoveInstanceToStage,
    updateInstanceAndSync,
    nowIso,
  } = deps;

  return async function runVerifyStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runVerifyStage: ctx with project.id is required');
    }
    if (!ctx.instance || ctx.instance.id == null) {
      throw new TypeError('runVerifyStage: ctx with instance.id is required');
    }
    const { project, previousState = null } = ctx;
    let instance = ctx.instance;
    const batchId = ctx.batchId ?? instance.batch_id ?? null;

    // Already-verified short-circuit: skip the executor when this batch
    // already produced a verified-batch decision and the current tick is
    // not an operator-approved rerun.
    const latestVerifyDecision = getLatestStageDecision(project.id, LOOP_STATES.VERIFY);
    const rerunApprovedVerify = RERUN_APPROVED_ACTIONS.includes(latestVerifyDecision?.action);
    const currentBatchAlreadyVerified = Boolean(
      instance.batch_id
      && !rerunApprovedVerify
      && hasVerifiedBatchDecision(project.id, instance.batch_id),
    );

    const legacy = currentBatchAlreadyVerified
      ? { status: 'skipped', reason: 'batch_already_verified', batch_id: instance.batch_id }
      : await executeVerifyStage(project.id, batchId, instance);

    const stageResult = {
      status: legacy?.status ?? null,
      exit_code: legacy?.exit_code ?? null,
      output_tail: legacy?.output_tail ?? null,
      fix_task_id: legacy?.fix_task_id ?? null,
    };

    // 1. Verify asked to pause — hold the instance at the named stage.
    //    Non-terminal: the dispatcher breaks to the post-switch path.
    if (legacy && legacy.pause_at_stage) {
      instance = updateInstanceAndSync(instance.id, {
        paused_at_stage: legacy.pause_at_stage,
        last_action_at: nowIso(),
      });
      return {
        disposition: 'pause',
        pausedAtStage: legacy.pause_at_stage,
        reason: legacy.reason || null,
        stageResult,
        legacy,
        instance,
        advanceResult: null,
      };
    }

    // 2. Terminal verify outcome — finalizeTerminalVerifyOutcome builds
    //    the runAdvanceLoop return object (it decides the new_state).
    if (isTerminalVerifyOutcome(legacy)) {
      const advanceResult = finalizeTerminalVerifyOutcome({
        project,
        instance,
        previousState,
        stageResult: legacy,
      });
      return {
        disposition: 'terminate',
        nextState: advanceResult?.new_state ?? null,
        reason: legacy?.reason || null,
        stageResult,
        legacy,
        instance,
        advanceResult,
      };
    }

    // 3. Verified — advance to LEARN.
    const moveToLearn = tryMoveInstanceToStage(instance, LOOP_STATES.LEARN, {
      batch_id: instance.batch_id,
      work_item_id: instance.work_item_id,
    });
    instance = moveToLearn.instance;
    return {
      disposition: 'continue',
      nextState: LOOP_STATES.LEARN,
      reason: moveToLearn.blocked
        ? 'stage_occupied'
        : (rerunApprovedVerify ? 'verify_rerun_completed' : 'verified_batch'),
      stageResult,
      legacy,
      instance,
      advanceResult: null,
    };
  };
}

// --- Phase 3: executeVerifyStage executor lifted from loop-controller ---
//
// createVerifyStage(deps) returns executeVerifyStage(project_id, batch_id,
// instance) -- the worktree remote-verify runner: branch-freshness rebase,
// verify-review classifier routing, dep-resolver cascade, bounded auto-retry
// loop, and the no-worktree post-batch guardrail path. The body is verbatim
// from loop-controller.js; the 10 loop-controller-internal helpers in
// VERIFY_FN_DEPS plus 3 constants are injected, leaf modules required above.
// loop-controller keeps a one-line wiring:
//   const executeVerifyStage = createVerifyStage({ ...deps });
function createVerifyStage(deps = {}) {
  for (const name of VERIFY_FN_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createVerifyStage: dep '${name}' is required`);
    }
  }
  if (typeof deps.MAX_AUTO_VERIFY_RETRIES !== 'number') {
    throw new TypeError("createVerifyStage: dep 'MAX_AUTO_VERIFY_RETRIES' (number) is required");
  }
  if (typeof deps.MAX_SUBMISSION_FAILURES !== 'number') {
    throw new TypeError("createVerifyStage: dep 'MAX_SUBMISSION_FAILURES' (number) is required");
  }
  if (!(deps.FATAL_SUBMISSION_REASONS instanceof Set)) {
    throw new TypeError("createVerifyStage: dep 'FATAL_SUBMISSION_REASONS' (Set) is required");
  }
  const {
    getWorktreeRunner,
    listTasksForFactoryBatch,
    safeLogDecision,
    resolveFactoryVerifyCommand,
    isProjectStatusPaused,
    resolveVerifyEmptyBranch,
    attemptSilentRerun,
    submitVerifyFixTask,
    enforceVerifyRetryScopeEnvelope,
    getProjectOrThrow,
    MAX_AUTO_VERIFY_RETRIES,
    FATAL_SUBMISSION_REASONS,
    MAX_SUBMISSION_FAILURES,
  } = deps;

  async function executeVerifyStage(project_id, batch_id, instance = null) {
    // First: run worktree remote verification if there's an active factory
    // worktree for this project. Failure here blocks the loop from reaching
    // LEARN so the operator can decide remediation vs. abandonment before any
    // merge to main.
    const activeBatchId = batch_id || instance?.batch_id || null;
    const worktreeRecord = activeBatchId
      ? factoryWorktrees.getActiveWorktreeByBatch(activeBatchId)
      : factoryWorktrees.getActiveWorktree(project_id);
    const worktreeRunner = worktreeRecord ? getWorktreeRunner() : null;

    // Under pending_approval mode the plan-executor submits tasks and returns
    // immediately. If we reach VERIFY before those tasks actually complete, a
    // remote verify run against the empty branch will fail. Guard: if any batch
    // task is still in a non-terminal state, pause at VERIFY without running
    // the remote tests. The operator re-advances once tasks finish.
    const batchIdForGate = (worktreeRecord && worktreeRecord.batchId) || activeBatchId;
    if (batchIdForGate) {
      const batchTasks = listTasksForFactoryBatch(batchIdForGate);
      if (batchTasks.length > 0) {
        // Match TERMINAL_TASK_STATUSES from db/task-core.js:
        // completed, failed, cancelled, skipped. Without `skipped` here a
        // workflow whose dependency chain short-circuits (every subtask marked
        // `skipped`) loops forever between paused_at_gate and auto-recovery's
        // retry — seen on example-project item #708 where 16 auto-decomposed subtasks
        // all ended in `skipped` and the gate never auto-cleared. `shipped` is
        // a work-item status (CLOSED_WORK_ITEM_STATUSES), not a task status —
        // kept in the list defensively in case a future code path reuses it.
        const nonTerminal = batchTasks.filter(
          (t) => !['completed', 'shipped', 'cancelled', 'failed', 'skipped'].includes(t.status),
        );
        if (nonTerminal.length > 0) {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'waiting_for_batch_tasks',
            reasoning: `VERIFY waiting for ${nonTerminal.length} non-terminal batch task(s) to finish before remote verify.`,
            outcome: {
              batch_id: batchIdForGate,
              pending_count: nonTerminal.length,
              pending_statuses: nonTerminal.map((t) => t.status),
            },
            confidence: 1,
            batch_id: batchIdForGate,
          });
          return {
            status: 'waiting',
            reason: 'batch_tasks_not_terminal',
            pause_at_stage: 'VERIFY',
            pending_count: nonTerminal.length,
          };
        }
      }
    }

    if (worktreeRecord && worktreeRunner) {
      const project = factoryHealth.getProject(project_id);
      // Pull the associated work item so the retry prompt can reference the
      // plan and so VERIFY can honor work-item-specific scoped validation.
      // Best-effort: if we can't resolve it, the retry still runs with less
      // context and falls back to the project verify command.
      let workItemForRetry = null;
      try {
        if (instance && instance.work_item_id) {
          workItemForRetry = factoryIntake.getWorkItem(instance.work_item_id);
        } else if (worktreeRecord.workItemId) {
          workItemForRetry = factoryIntake.getWorkItem(worktreeRecord.workItemId);
        }
      } catch (_err) {
        workItemForRetry = null;
      }
      const resolvedVerify = resolveFactoryVerifyCommand({
        project,
        workItem: workItemForRetry,
      });
      const verifyCommand = resolvedVerify.command;

      let projectConfig = {};
      try {
        projectConfig = project?.config_json ? JSON.parse(project.config_json) : {};
      } catch (_err) {
        projectConfig = {};
      }
      const thresholdValue = Number(projectConfig.stale_branch_commit_threshold);
      const staleBranchCommitThreshold = Number.isFinite(thresholdValue) ? thresholdValue : 0;
      const baseRef = worktreeRecord.base_branch
        || worktreeRecord.baseBranch
        || detectDefaultBranch(worktreeRecord.worktreePath || project?.path || process.cwd())
        || 'main';
      const branchStaleRejectReason = 'branch_stale_vs_base';
      const freshness = await branchFreshness.checkBranchFreshness({
        worktreePath: worktreeRecord.worktreePath,
        branch: worktreeRecord.branch,
        baseRef,
        threshold: staleBranchCommitThreshold,
      });

      if (freshness.stale) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'branch_stale_detected',
          reasoning: `Branch ${worktreeRecord.branch} is stale versus ${baseRef}; attempting automatic rebase before VERIFY.`,
          outcome: {
            commits_behind: freshness.commitsBehind,
            stale_files: freshness.staleFiles,
            threshold: staleBranchCommitThreshold,
          },
          confidence: 1,
          batch_id,
        });

        const rebaseResult = await branchFreshness.attemptRebase(
          worktreeRecord.worktreePath,
          worktreeRecord.branch,
          baseRef,
        );
        if (rebaseResult.ok) {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'branch_auto_rebased',
            reasoning: `Automatically rebased ${worktreeRecord.branch} onto ${baseRef}; proceeding to VERIFY.`,
            outcome: {
              branch: worktreeRecord.branch,
              baseRef,
            },
            confidence: 1,
            batch_id,
          });
        } else {
          if (workItemForRetry && workItemForRetry.id) {
            factoryIntake.rejectWorkItemUnactionable(workItemForRetry.id, branchStaleRejectReason);
          }
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'branch_stale_rebase_conflict',
            reasoning: `Automatic rebase of ${worktreeRecord.branch} onto ${baseRef} failed; marking the work item unactionable so the factory can advance.`,
            outcome: {
              commits_behind: freshness.commitsBehind,
              stale_files: freshness.staleFiles,
              error: rebaseResult.error,
              work_item_id: workItemForRetry?.id || instance?.work_item_id || null,
            },
            confidence: 1,
            batch_id,
          });
          return {
            status: 'unactionable',
            reason: branchStaleRejectReason,
            branch: worktreeRecord.branch,
            worktree_path: worktreeRecord.worktreePath,
          };
        }
      }

      // Auto-retry: if verify fails, submit a fix task via the auto-router with
      // the error output as context, then re-run verify. Bounded at
      // MAX_AUTO_VERIFY_RETRIES. If still failing after that, auto-reject
      // the work item so the loop can advance to the next item.
      const verifyReview = require('../verify-review');
      let review = null;
      // Reset the cascade counter when EXECUTE transitions into VERIFY for a
      // fresh batch. Persisting the counter across stages lets consecutive
      // missing_dep cycles within ONE verify stage add up, without leaking
      // into the next batch.
      try {
        const freshProject = factoryHealth.getProject(project_id);
        const freshCfg = freshProject?.config_json ? JSON.parse(freshProject.config_json) : {};
        if (freshCfg.dep_resolve_cycle_count) {
          freshCfg.dep_resolve_cycle_count = 0;
          factoryHealth.updateProject(project_id, { config_json: JSON.stringify(freshCfg) });
        }
      } catch (_e) { void _e; }
      let res = null;
      let postFailureFreshnessChecked = false;
      // Seed the retry counter from prior verify-retry tasks for this batch.
      // Without this, any re-entry to executeVerifyStage (stall-recovery,
      // VERIFY_FAIL resume, dispatcher re-entry) resets retryAttempt to 0 and
      // the loop cycles retry=1..3 again instead of emitting
      // auto_rejected_verify_fail. The retry tags persisted on task rows are
      // the cross-call source of truth.
      let retryAttempt = countPriorVerifyRetryTasksForBatch(batch_id);
      let submissionFailures = 0;
      try {
        while (true) {
          // Project-row pause gate, re-checked on every iteration. An operator's
          // pause_project must interrupt an in-flight verify-retry loop — not
          // wait for the current retry to finish before the next iteration can
          // submit another Codex task.
          if (isProjectStatusPaused(project_id)) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_aborted_project_paused',
              reasoning: 'Project was paused mid-verify; aborting retry loop instead of submitting another fix task.',
              outcome: { retry_attempts: retryAttempt },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'paused',
              reason: 'project_paused_mid_verify',
              pause_at_stage: 'VERIFY',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              retry_attempts: retryAttempt,
            };
          }
          res = await worktreeRunner.verify({
            worktreePath: worktreeRecord.worktreePath,
            branch: worktreeRecord.branch,
            verifyCommand,
            baseBranch: baseRef,
          });
          if (res.passed) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'worktree_verify_passed',
              reasoning: `Worktree remote verify passed for branch ${worktreeRecord.branch}${retryAttempt > 0 ? ` (after ${retryAttempt} retry attempt${retryAttempt === 1 ? '' : 's'})` : ''}.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                duration_ms: res.durationMs,
                verify_command: verifyCommand,
                verify_command_source: resolvedVerify.source,
                retry_attempt: retryAttempt,
              },
              confidence: 1,
              batch_id,
            });
            break;
          }

          if (!postFailureFreshnessChecked) {
            postFailureFreshnessChecked = true;
            const postFailureFreshness = await branchFreshness.checkBranchFreshness({
              worktreePath: worktreeRecord.worktreePath,
              branch: worktreeRecord.branch,
              baseRef,
              threshold: staleBranchCommitThreshold,
            });

            if (postFailureFreshness.stale) {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'branch_stale_detected_post_verify',
                reasoning: `Branch ${worktreeRecord.branch} became stale versus ${baseRef} during VERIFY; attempting automatic rebase before classifying the failure.`,
                outcome: {
                  commits_behind: postFailureFreshness.commitsBehind,
                  stale_files: postFailureFreshness.staleFiles,
                  threshold: staleBranchCommitThreshold,
                },
                confidence: 1,
                batch_id,
              });

              const postFailureRebase = await branchFreshness.attemptRebase(
                worktreeRecord.worktreePath,
                worktreeRecord.branch,
                baseRef,
              );
              if (postFailureRebase.ok) {
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'branch_auto_rebased_post_verify',
                  reasoning: `Automatically rebased ${worktreeRecord.branch} onto ${baseRef} after VERIFY drift; re-running verify before classifier triage.`,
                  outcome: {
                    branch: worktreeRecord.branch,
                    baseRef,
                  },
                  confidence: 1,
                  batch_id,
                });
                review = null;
                continue;
              }

              if (workItemForRetry && workItemForRetry.id) {
                factoryIntake.rejectWorkItemUnactionable(workItemForRetry.id, branchStaleRejectReason);
              }
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'branch_stale_rebase_conflict_post_verify',
                reasoning: `Automatic rebase of ${worktreeRecord.branch} onto ${baseRef} failed after VERIFY drift; marking the work item unactionable so the factory can advance.`,
                outcome: {
                  commits_behind: postFailureFreshness.commitsBehind,
                  stale_files: postFailureFreshness.staleFiles,
                  error: postFailureRebase.error,
                  work_item_id: workItemForRetry?.id || instance?.work_item_id || null,
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'unactionable',
                reason: branchStaleRejectReason,
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
              };
            }
          }

          // Verify-review classifier: on the FIRST failure only, classify the
          // failure as task_caused, baseline_broken, environment_failure, or
          // ambiguous. Baseline_broken / environment_failure short-circuit the
          // retry loop. Task_caused enters the repair path. Ambiguous failures
          // get one silent rerun, then pause for operator triage instead of
          // letting a retry task repair unrelated full-suite failures.
          if (res?.reason === 'empty_branch') {
            return resolveVerifyEmptyBranch({
              project,
              project_id,
              instance,
              workItem: workItemForRetry,
              worktreeRecord,
              verifyResult: res,
              batch_id,
            });
          }

          if (retryAttempt === 0 && !review) {
            try {
              const wi = instance?.work_item_id
                ? factoryIntake.getWorkItem(instance.work_item_id)
                : null;
              review = await verifyReview.reviewVerifyFailure({
                verifyOutput: res,
                workingDirectory: worktreeRecord.worktreePath || project?.path || process.cwd(),
                worktreeBranch: worktreeRecord.branch,
                mergeBase: baseRef,
                workItem: wi,
                project: project || { id: project_id, path: null },
                batch_id,
              });
            } catch (err) {
              logger.warn('verify-review classifier failed; falling through to existing retry path', {
                project_id, err: err.message,
              });
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_reviewer_fail_open',
                reasoning: `Classifier threw: ${err.message}. Retrying as before.`,
                outcome: { work_item_id: instance?.work_item_id || null },
                confidence: 1,
                batch_id,
              });
              review = null;
            }

            if (review?.classification === 'zero_diff_cascade') {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_retry_suppressed_zero_diff',
                reasoning: 'Verify-retry suppressed: modifiedFiles empty AND prior auto_commit_skipped_clean in batch.',
                outcome: {
                  reject_reason: 'zero_diff_across_retries',
                  work_item_id: instance?.work_item_id,
                },
                confidence: 1,
                batch_id,
              });
              if (instance?.work_item_id) {
                try {
                  factoryIntake.rejectWorkItemUnactionable(instance.work_item_id, 'zero_diff_across_retries');
                } catch (err) {
                  logger.warn('verify zero-diff cascade: failed to mark work item unactionable', {
                    project_id,
                    work_item_id: instance.work_item_id,
                    err: err.message,
                  });
                }
              }
              return {
                status: 'unactionable',
                reason: 'zero_diff_across_retries',
                pause_at_stage: null,
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
              };
            }

            // plan_already_satisfied: EXECUTE reported submitted_tasks=[] (Phase E
            // success-aware) AND verify produced no failing tests. The plan was
            // already fulfilled by prior commits; running the LLM judge against
            // an empty signal repeatedly produces hallucinated baseline failures
            // (example-project WI #783, qwen3-coder:30b, 2026-05-04). Mark unactionable
            // so the factory advances instead of looping.
            if (review?.classification === 'plan_already_satisfied') {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_skipped_plan_already_satisfied',
                reasoning: 'EXECUTE reported submitted_tasks=[] and verify produced no failing tests; plan already fulfilled by prior commits — short-circuiting LLM judge to prevent false-positive baseline rejections.',
                outcome: {
                  reject_reason: 'plan_already_satisfied_no_new_work',
                  work_item_id: instance?.work_item_id,
                },
                confidence: 1,
                batch_id,
              });
              if (instance?.work_item_id) {
                try {
                  factoryIntake.rejectWorkItemUnactionable(instance.work_item_id, 'plan_already_satisfied_no_new_work');
                } catch (err) {
                  logger.warn('verify plan-already-satisfied: failed to mark work item unactionable', {
                    project_id,
                    work_item_id: instance.work_item_id,
                    err: err.message,
                  });
                }
              }
              return {
                status: 'unactionable',
                reason: 'plan_already_satisfied_no_new_work',
                pause_at_stage: null,
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
              };
            }

            // missing_dep branch: submit a Codex resolver task, await, re-verify.
            // Cap cascade at 3 per batch. On resolver failure, escalate once; on
            // escalation pause, treat as baseline_broken and pause the project.
            if (review && review.classification === 'missing_dep') {
              const depResolver = require('../dep-resolver/index');
              const escalationHelper = require('../dep-resolver/escalation');
              const registry = require('../dep-resolver/registry');
              const adapter = registry.getAdapter(review.manager);
              if (!adapter) {
                // Manager disappeared between classify and resolve; fall through
                // as ambiguous so the normal retry path can try.
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_no_adapter',
                  reasoning: `Missing dep detected (manager=${review.manager}) but no adapter is registered; falling through to retry.`,
                  outcome: { work_item_id: instance?.work_item_id || null, manager: review.manager },
                  confidence: 1,
                  batch_id,
                });
              } else {
              const gatedTrust = project.trust_level === 'supervised' || project.trust_level === 'guided';
              if (gatedTrust) {
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_pending_approval',
                  reasoning: `Missing dep ${review.package_name} (${review.manager}) detected. Trust level ${project.trust_level} requires operator approval before installing.`,
                  outcome: {
                    work_item_id: instance?.work_item_id || null,
                    manager: review.manager,
                    package: review.package_name,
                    proposed_action: 'dep_resolve',
                  },
                  confidence: 1,
                  batch_id,
                });
                return {
                  status: 'paused',
                  reason: 'dep_resolver_pending_approval',
                  next_state: LOOP_STATES.PAUSED,
                  paused_at_stage: LOOP_STATES.VERIFY,
                };
              }
                // Check cascade cap + kill switch.
                const currentProject = factoryHealth.getProject(project_id);
                const cfg = currentProject?.config_json ? JSON.parse(currentProject.config_json) : {};
                const enabled = cfg?.dep_resolver?.enabled !== false; // default on
                const cap = Number.isFinite(cfg?.dep_resolver?.cascade_cap) ? cfg.dep_resolver.cascade_cap : 3;
                const count = Number.isFinite(cfg?.dep_resolve_cycle_count) ? cfg.dep_resolve_cycle_count : 0;

                if (!enabled) {
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_disabled',
                    reasoning: 'Missing dep detected but dep_resolver.enabled=false; falling through to existing retry.',
                    outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name },
                    confidence: 1,
                    batch_id,
                  });
                } else if (count >= cap) {
                  // Cascade exhausted — pause as baseline_broken.
                  factoryIntake.updateWorkItem(instance.work_item_id, {
                    status: 'rejected',
                    reject_reason: `dep_cascade_exhausted: ${count} resolutions attempted, next missing dep is ${review.package_name}`,
                  });
                  cfg.baseline_broken_since = new Date().toISOString();
                  cfg.baseline_broken_reason = 'dep_cascade_exhausted';
                  cfg.baseline_broken_evidence = { last_package: review.package_name, cycle_count: count };
                  cfg.baseline_broken_probe_attempts = 0;
                  cfg.baseline_broken_tick_count = 0;
                  factoryHealth.updateProject(project_id, { status: 'paused', config_json: JSON.stringify(cfg) });
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_cascade_exhausted',
                    reasoning: `Reached ${count} dep resolutions this batch; pausing project.`,
                    outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, cycle_count: count },
                    confidence: 1,
                    batch_id,
                  });
                  return { status: 'rejected', reason: 'dep_cascade_exhausted' };
                } else {
                  // Run the resolver.
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_detected',
                    reasoning: `Missing dep detected: ${review.package_name} (manager=${review.manager})`,
                    outcome: { work_item_id: instance?.work_item_id || null, manager: review.manager, package: review.package_name, module: review.module_name },
                    confidence: 1,
                    batch_id,
                  });

                  let resolveResult = await depResolver.resolve({
                    classification: review,
                    project,
                    worktree: worktreeRecord,
                    workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                    instance,
                    adapter,
                    options: {},
                  });

                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: resolveResult.outcome === 'resolved' ? 'dep_resolver_task_completed' : 'dep_resolver_validation_failed',
                    reasoning: `Resolver outcome: ${resolveResult.outcome} (${resolveResult.reason || 'ok'})`,
                    outcome: { work_item_id: instance?.work_item_id || null, ...resolveResult },
                    confidence: 1,
                    batch_id,
                  });

                  // On resolver failure, escalate once.
                  if (resolveResult.outcome !== 'resolved') {
                    const escalationResult = await escalationHelper.escalate({
                      project,
                      workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                      originalError: review.error_output || '',
                      resolverError: resolveResult.resolverError || resolveResult.reason || '',
                      resolverPrompt: adapter.buildResolverPrompt({
                        package_name: review.package_name,
                        project,
                        worktree: worktreeRecord,
                        workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                        error_output: review.error_output || '',
                      }),
                      manifestExcerpt: '',
                    });
                    safeLogDecision({
                      project_id,
                      stage: LOOP_STATES.VERIFY,
                      action: 'dep_resolver_escalated',
                      reasoning: `Escalation verdict: ${escalationResult.action} (${escalationResult.reason})`,
                      outcome: { work_item_id: instance?.work_item_id || null, ...escalationResult },
                      confidence: 1,
                      batch_id,
                    });
                    if (escalationResult.action === 'retry') {
                      resolveResult = await depResolver.resolve({
                        classification: review,
                        project,
                        worktree: worktreeRecord,
                        workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                        instance,
                        adapter,
                        options: { revisedPrompt: escalationResult.revisedPrompt },
                      });
                      safeLogDecision({
                        project_id,
                        stage: LOOP_STATES.VERIFY,
                        action: 'dep_resolver_escalation_retry',
                        reasoning: `Retry resolver outcome: ${resolveResult.outcome} (${resolveResult.reason || 'ok'})`,
                        outcome: { work_item_id: instance?.work_item_id || null, ...resolveResult },
                        confidence: 1,
                        batch_id,
                      });
                    }
                    // If still not resolved (either escalation pause or retry failed), pause project.
                    if (resolveResult.outcome !== 'resolved') {
                      factoryIntake.updateWorkItem(instance.work_item_id, {
                        status: 'rejected',
                        reject_reason: `dep_resolver_unresolvable: ${escalationResult.reason || resolveResult.reason || 'unknown'}`,
                      });
                      cfg.baseline_broken_since = new Date().toISOString();
                      cfg.baseline_broken_reason = 'dep_resolver_unresolvable';
                      cfg.baseline_broken_evidence = { package: review.package_name, escalation_reason: escalationResult.reason, resolver_reason: resolveResult.reason };
                      cfg.baseline_broken_probe_attempts = 0;
                      cfg.baseline_broken_tick_count = 0;
                      factoryHealth.updateProject(project_id, { status: 'paused', config_json: JSON.stringify(cfg) });
                      safeLogDecision({
                        project_id,
                        stage: LOOP_STATES.VERIFY,
                        action: 'dep_resolver_escalation_pause',
                        reasoning: `Pausing project: ${escalationResult.reason || resolveResult.reason}`,
                        outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, escalation: escalationResult, resolver: resolveResult },
                        confidence: 1,
                        batch_id,
                      });
                      return { status: 'rejected', reason: 'dep_resolver_unresolvable' };
                    }
                  }

                  // Success path: bump counter, mark for re-verify. Continue
                  // the outer verify while-loop.
                  cfg.dep_resolve_cycle_count = count + 1;
                  if (!Array.isArray(cfg.dep_resolve_history)) cfg.dep_resolve_history = [];
                  cfg.dep_resolve_history.push({
                    ts: new Date().toISOString(),
                    batch_id,
                    package: review.package_name,
                    manager: review.manager,
                    outcome: 'resolved',
                    task_id: resolveResult.taskId || null,
                  });
                  // Cap history at 20 entries
                  if (cfg.dep_resolve_history.length > 20) cfg.dep_resolve_history = cfg.dep_resolve_history.slice(-20);
                  factoryHealth.updateProject(project_id, { config_json: JSON.stringify(cfg) });

                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_reverify_passed',
                    reasoning: `Dep ${review.package_name} resolved; re-running verify (cycle ${count + 1}/${cap}).`,
                    outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, cycle_count: count + 1 },
                    confidence: 1,
                    batch_id,
                  });

                  // Clear `review` so the next loop iteration re-enters the
                  // classifier on the fresh verify output.
                  review = null;
                  continue;
                }
              }
            }

            if (review && (review.classification === 'baseline_broken'
                           || review.classification === 'baseline_likely'
                           || review.classification === 'environment_failure')) {
              let blockedWorkItem = null;
              if (instance?.work_item_id) {
                try {
                  blockedWorkItem = factoryIntake.getWorkItem(instance.work_item_id);
                  factoryIntake.updateWorkItem(instance.work_item_id, {
                    status: 'rejected',
                    reject_reason: review.suggestedRejectReason,
                  });
                } catch (_e) { void _e; }
              }

              try {
                const currentProject = factoryHealth.getProject(project_id);
                const cfg = currentProject?.config_json ? JSON.parse(currentProject.config_json) : {};
                cfg.baseline_broken_since = new Date().toISOString();
                cfg.baseline_broken_reason = review.suggestedRejectReason;
                cfg.baseline_broken_evidence = {
                  ...baselineRequeue.captureBlockedWorkItemEvidence(blockedWorkItem),
                  failing_tests: review.failingTests,
                  exit_code: res.exitCode,
                  verify_command: verifyCommand,
                  verify_command_source: resolvedVerify.source,
                  environment_signals: review.environmentSignals,
                  llm_critique: review.llmCritique,
                  // baseline_likely was reached without an LLM verdict —
                  // record the deterministic shape that justified it so the
                  // baseline-probe phase has the same evidence the operator
                  // would have used.
                  classification: review.classification,
                  shared_infra_touched: review.sharedInfraTouched || false,
                };
                cfg.baseline_broken_probe_attempts = 0;
                cfg.baseline_broken_tick_count = 0;
                factoryHealth.updateProject(project_id, {
                  status: 'paused',
                  config_json: JSON.stringify(cfg),
                });
              } catch (_e) { void _e; }

              try {
                if (review.classification === 'baseline_broken'
                    || review.classification === 'baseline_likely') {
                  eventBus.emitFactoryProjectBaselineBroken({
                    project_id,
                    reason: review.suggestedRejectReason,
                    failing_tests: review.failingTests,
                    evidence: {
                      exit_code: res.exitCode,
                      llm_critique: review.llmCritique,
                      classification: review.classification,
                    },
                  });
                } else {
                  eventBus.emitFactoryProjectEnvironmentFailure({
                    project_id,
                    signals: review.environmentSignals,
                    exit_code: res.exitCode,
                  });
                }
              } catch (_e) { void _e; }

              const action = review.classification === 'baseline_broken'
                ? 'verify_reviewed_baseline_broken'
                : review.classification === 'baseline_likely'
                  ? 'verify_reviewed_baseline_likely'
                  : 'verify_reviewed_environment_failure';
              const reasoning = review.classification === 'baseline_broken'
                ? `Baseline broken — ${review.failingTests.length} failing test(s) unrelated to this diff. ${review.llmCritique || ''}`
                : review.classification === 'baseline_likely'
                  ? `Baseline likely broken — LLM verdict unavailable (${review.llmStatus || 'null'}); ${review.failingTests.length} failing test(s) do not touch any modified file and no shared infrastructure was modified. Pausing for baseline-probe to confirm against main.`
                  : `Environment failure — signals: ${review.environmentSignals.join(', ')}.`;
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action,
                reasoning,
                outcome: {
                  work_item_id: instance?.work_item_id || null,
                  classification: review.classification,
                  confidence: review.confidence,
                  modifiedFiles: review.modifiedFiles,
                  failingTests: review.failingTests,
                  intersection: review.intersection,
                  environmentSignals: review.environmentSignals,
                  llmVerdict: review.llmVerdict,
                  llmCritique: review.llmCritique || null,
                  llmStatus: review.llmStatus || null,
                  llmTaskId: review.llmTaskId || null,
                  sharedInfraTouched: review.sharedInfraTouched || false,
                  sharedInfraFiles: review.sharedInfraFiles || [],
                },
                confidence: 1,
                batch_id,
              });

              return { status: 'rejected', reason: review.classification };
            }

            if (review && review.classification === 'reviewer_timeout') {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_reviewer_timeout_paused',
                reasoning: `Verify reviewer timed out (task=${review.llmTaskId || 'unknown'}); pausing for controlled recovery instead of reusing the generic ambiguous retry loop.`,
                outcome: {
                  work_item_id: instance?.work_item_id || null,
                  classification: review.classification,
                  confidence: review.confidence,
                  modifiedFiles: review.modifiedFiles,
                  failingTests: review.failingTests,
                  intersection: review.intersection,
                  llmStatus: review.llmStatus || null,
                  task_id: review.llmTaskId || null,
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'failed',
                reason: 'verify_reviewer_timeout_requires_recovery',
                pause_at_stage: 'VERIFY_FAIL',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                verify_output: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              };
            }

            if (review && review.classification === 'ambiguous') {
              let verifyOutput = res.output;
              const silentResult = await attemptSilentRerun({
                project_id,
                batch_id,
                instance_id: instance && instance.id,
                priorVerifyOutput: verifyOutput,
                runVerify: async () => {
                  const execResult = await worktreeRunner.verify({
                    worktreePath: worktreeRecord.worktreePath,
                    branch: worktreeRecord.branch,
                    verifyCommand,
                    baseBranch: baseRef,
                  });
                  return {
                    exitCode: typeof execResult.exitCode === 'number' ? execResult.exitCode : (execResult.passed ? 0 : 1),
                    output: execResult.output,
                  };
                },
              });

              if (silentResult.kind === 'passed') {
                return { status: 'passed' };
              }
              if (silentResult.kind === 'different_failure') {
                verifyOutput = silentResult.combinedOutput;
                res.output = verifyOutput;
              }
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_reviewed_ambiguous_paused',
                reasoning: review.sharedInfraTouched
                  ? `Classifier says ambiguous (confidence=${review.confidence}); shared infrastructure was touched (${(review.sharedInfraFiles || []).join(', ')}) so deterministic baseline upgrade is suppressed; pausing for engine strategy escalation.`
                  : `Classifier says ambiguous (confidence=${review.confidence}); pausing instead of auto-retrying an unscoped failure.`,
                outcome: {
                  work_item_id: instance?.work_item_id || null,
                  classification: review.classification,
                  confidence: review.confidence,
                  modifiedFiles: review.modifiedFiles,
                  failingTests: review.failingTests,
                  intersection: review.intersection,
                  silent_rerun: silentResult.kind,
                  llmVerdict: review.llmVerdict || null,
                  llmCritique: review.llmCritique || null,
                  llmStatus: review.llmStatus || null,
                  llmTaskId: review.llmTaskId || null,
                  sharedInfraTouched: review.sharedInfraTouched || false,
                  sharedInfraFiles: review.sharedInfraFiles || [],
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'failed',
                reason: 'verify_ambiguous_requires_operator',
                pause_at_stage: 'VERIFY_FAIL',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                verify_output: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              };
            }

            // build_failure is treated like task_caused: route to the auto-retry
            // path so MAX_AUTO_VERIFY_RETRIES bounds it. After retries exhaust,
            // the work item gets auto-rejected as unactionable rather than
            // sitting in human-pause limbo (the f9cf2275 failure mode).
            const reviewedAction = review && review.classification === 'task_caused'
              ? 'verify_reviewed_task_caused'
              : review && review.classification === 'build_failure'
                ? 'verify_reviewed_build_failure'
                : 'verify_reviewed_retrying';
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: reviewedAction,
              reasoning: review
                ? `Classifier says ${review.classification} (confidence=${review.confidence}); retry path will fire.`
                : 'Classifier unavailable; retrying as before.',
              outcome: review ? {
                work_item_id: instance?.work_item_id || null,
                classification: review.classification,
                confidence: review.confidence,
                modifiedFiles: review.modifiedFiles,
                failingTests: review.failingTests,
                intersection: review.intersection,
                // Surface build_failure detector signals (e.g.
                // ['csharp_compile_error', 'dotnet_error_count_8']) when present
                // so triage can identify the language/tool that emitted them.
                buildSignals: review.buildSignals || null,
                llmVerdict: review.llmVerdict || null,
                llmCritique: review.llmCritique || null,
                llmStatus: review.llmStatus || null,
                llmTaskId: review.llmTaskId || null,
              } : { work_item_id: instance?.work_item_id || null, classifier: 'unavailable' },
              confidence: 1,
              batch_id,
            });
          }

          if (retryAttempt >= MAX_AUTO_VERIFY_RETRIES) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'worktree_verify_failed',
              reasoning: `Worktree remote verify FAILED for branch ${worktreeRecord.branch} after ${retryAttempt} auto-retry attempt${retryAttempt === 1 ? '' : 's'}; auto-rejecting the work item and advancing.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                duration_ms: res.durationMs,
                verify_command: verifyCommand,
                output_preview: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              },
              confidence: 1,
              batch_id,
            });
            // Before auto-rejecting: check if the work was already done on
            // main (manual fix in a different session). If so, ship it.
            try {
              const { createShippedDetector } = require('../shipped-detector');
              const project = getProjectOrThrow(project_id);
              const wi = instance.work_item_id
                ? factoryIntake.getWorkItem(instance.work_item_id)
                : null;
              if (wi) {
                const detector = createShippedDetector({ repoRoot: project.path });
                const detection = detector.detectShipped({
                  content: wi.description || wi.title || '',
                  title: wi.title,
                });
                if (detection.shipped && detection.confidence !== 'low') {
                  factoryIntake.updateWorkItem(wi.id, { status: 'shipped' });
                  emitAutoShipped({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    reason: AUTO_SHIPPED_REASONS.AT_VERIFY_FAIL,
                    work_item_id: wi.id,
                    confidence: detection.confidence,
                    signals: detection.signals,
                    batch_id,
                    reasoning: `Verify failed but shipped-detector found matching commits on main (${detection.confidence} confidence). Marking shipped instead of auto-rejecting.`,
                  });
                  return { status: 'passed', reason: 'auto_shipped_at_verify_fail' };
                }
              }
            } catch (_e) { void _e; }

            // Auto-reject: mark the work item as rejected and let the loop
            // advance past this item instead of stalling at VERIFY_FAIL.
            if (instance && instance.work_item_id) {
              try {
                factoryIntake.updateWorkItem(instance.work_item_id, {
                  status: 'rejected',
                  reject_reason: `verify_failed_after_${retryAttempt}_retries`,
                });
              } catch (_e) { void _e; }
            }
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'auto_rejected_verify_fail',
              reasoning: `Auto-rejected work item after ${retryAttempt} verify retries. Advancing to LEARN to process next item.`,
              outcome: {
                work_item_id: instance?.work_item_id || null,
                instance_id: instance?.id || null,
                retry_attempts: retryAttempt,
              },
              confidence: 1,
              batch_id,
            });
            return { status: 'passed', reason: 'auto_rejected_after_max_retries' };
          }
          retryAttempt += 1;
          // Phase X8 (2026-05-02): escalate verify retries to codex when an
          // ollama-locked project has a dotnet test verify and the first
          // ollama attempt didn't converge. qwen3-coder:30b can write code
          // but reliably struggles to read NUnit/xUnit failures and patch
          // the right one-line in production code. Live evidence: example-project
          // items 2096, 876, 2082 each got past the build gate but never
          // turned dotnet tests green across 3 ollama retries. Escalating
          // attempts >= 2 to codex preserves cost on the first try while
          // giving the harder retries a model that can actually reason
          // about test failures.
          const retryProject = factoryHealth.getProject(project_id);
          const laneProvider = getEffectiveProjectProvider(retryProject);
          const verifyStack = detectVerifyStack({
            verifyCommand,
            verifyOutput: res.output,
          });
          const shouldEscalate = (
            retryAttempt >= 2
            && laneProvider === 'ollama'
            && verifyStack === 'dotnet'
          );
          const forceProvider = shouldEscalate ? 'codex' : null;
          if (shouldEscalate) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_retry_escalated_to_codex',
              reasoning: `Verify retry #${retryAttempt} escalated from ollama to codex: dotnet test failures rarely converge on local model after a first attempt. Lane policy is preserved for EXECUTE; only this retry submission is escalated.`,
              inputs: {
                attempt: retryAttempt,
                lane_provider: laneProvider,
                verify_stack: verifyStack,
                branch: worktreeRecord.branch,
              },
              outcome: { forced_provider: forceProvider },
              confidence: 1,
              batch_id,
            });
          }
          const retryResult = await submitVerifyFixTask({
            project_id,
            batch_id,
            worktreeRecord,
            workItem: workItemForRetry,
            verifyCommand,
            verifyOutput: res.output,
            attempt: retryAttempt,
            forceProvider,
          });

          // Fix 4: classify the retry result.
          // (a) submission did not happen — distinguish fatal vs transient.
          if (retryResult.submitted === false) {
            // Dark-factory recovery: submitVerifyFixTask already auto-rejected
            // the item (worktree + branch both lost). Advance the loop past
            // VERIFY so the factory picks the next item.
            if (retryResult.auto_rejected) {
              return {
                status: 'passed',
                reason: retryResult.reason || 'auto_rejected_during_verify',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                retry_attempts: retryAttempt,
              };
            }
            if (FATAL_SUBMISSION_REASONS.has(retryResult.reason)) {
              // Fatal: cwd missing, etc. Pause immediately — retrying won't help.
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'worktree_verify_failed',
                reasoning: `Worktree verify FAILED: retry submission cannot proceed (${retryResult.reason}). Pausing at VERIFY_FAIL.`,
                outcome: {
                  branch: worktreeRecord.branch,
                  worktree_path: worktreeRecord.worktreePath,
                  duration_ms: res.durationMs,
                  verify_command: verifyCommand,
                  output_preview: String(res.output || '').slice(-1500),
                  retry_attempts: retryAttempt,
                  submission_reason: retryResult.reason,
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'failed',
                reason: `verify_retry_${retryResult.reason}`,
                pause_at_stage: 'VERIFY_FAIL',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                verify_output: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              };
            }
            // Transient submission failure (no task_id, submit_threw, etc.).
            // Don't consume a retry attempt — the test never ran. Re-attempt
            // the submission, capped at MAX_SUBMISSION_FAILURES so a persistent
            // provider outage doesn't loop forever.
            submissionFailures += 1;
            retryAttempt -= 1;
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_retry_submission_failed',
              reasoning: `Auto-retry submission failed (${retryResult.reason || 'unknown'}); not consuming a retry attempt (${submissionFailures}/${MAX_SUBMISSION_FAILURES}).`,
              outcome: {
                attempt: retryAttempt + 1,
                submission_failures: submissionFailures,
                max_submission_failures: MAX_SUBMISSION_FAILURES,
                reason: retryResult.reason || null,
                error: retryResult.error || null,
                branch: worktreeRecord.branch,
              },
              confidence: 1,
              batch_id,
            });
            if (submissionFailures >= MAX_SUBMISSION_FAILURES) {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'worktree_verify_failed',
                reasoning: `Worktree verify FAILED: ${submissionFailures} consecutive retry-submission errors; pausing at VERIFY_FAIL for operator triage.`,
                outcome: {
                  branch: worktreeRecord.branch,
                  worktree_path: worktreeRecord.worktreePath,
                  duration_ms: res.durationMs,
                  verify_command: verifyCommand,
                  output_preview: String(res.output || '').slice(-1500),
                  retry_attempts: retryAttempt,
                  submission_failures: submissionFailures,
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'failed',
                reason: 'worktree_verify_failed_submission_failures',
                pause_at_stage: 'VERIFY_FAIL',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                verify_output: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
                submission_failures: submissionFailures,
              };
            }
            continue;
          }

          // (b) submission OK but task did not complete — preserve existing
          // pause behavior (provider crashed, await timed out, etc.).
          if (retryResult.awaitStatus !== 'completed') {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_retry_task_failed',
              reasoning: `Auto-retry #${retryAttempt} task did not complete successfully; abandoning retry loop and pausing at VERIFY_FAIL.`,
              outcome: {
                attempt: retryAttempt,
                submitted: retryResult.submitted,
                reason: retryResult.reason || retryResult.awaitStatus || null,
                error: retryResult.error || null,
                branch: worktreeRecord.branch,
              },
              confidence: 1,
              batch_id,
            });
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'worktree_verify_failed',
              reasoning: `Worktree remote verify FAILED and auto-retry #${retryAttempt} did not produce a completed task; pausing loop at VERIFY_FAIL.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                duration_ms: res.durationMs,
                verify_command: verifyCommand,
                output_preview: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'failed',
              reason: 'worktree_verify_failed_retry_task_error',
              pause_at_stage: 'VERIFY_FAIL',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              verify_output: String(res.output || '').slice(-1500),
              retry_attempts: retryAttempt,
            };
          }
          // (c) submission OK + task completed — reset transient counter and re-verify.
          submissionFailures = 0;
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'verify_retry_task_completed',
            reasoning: `Auto-retry #${retryAttempt} task completed; re-running remote verify.`,
            outcome: {
              attempt: retryAttempt,
              task_id: retryResult.task_id,
              branch: worktreeRecord.branch,
            },
            confidence: 1,
            batch_id,
          });
          const scopeEnvelopeResult = await enforceVerifyRetryScopeEnvelope({
            project_id,
            batch_id,
            workItemId: instance?.work_item_id || workItemForRetry?.id || worktreeRecord.workItemId || null,
            planPath: workItemForRetry?.origin?.plan_path || null,
            verifyOutput: res.output,
            worktreePath: worktreeRecord.worktreePath,
            attempt: retryAttempt,
            branch: worktreeRecord.branch,
          });
          if (!scopeEnvelopeResult.ok) {
            return {
              status: 'failed',
              reason: 'retry_off_scope',
              pause_at_stage: 'VERIFY_FAIL',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              off_scope_files: scopeEnvelopeResult.offScopeFiles,
              scope_envelope: Array.from(scopeEnvelopeResult.scopeEnvelope || []),
            };
          }
        }
      } catch (err) {
        logger.warn('worktree verify threw; treating as verify failure', {
          project_id,
          branch: worktreeRecord.branch,
          err: err.message,
        });
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'worktree_verify_errored',
          reasoning: `Worktree verify threw: ${err.message}`,
          outcome: { branch: worktreeRecord.branch, error: err.message },
          confidence: 0.5,
          batch_id,
        });
        return {
          status: 'failed',
          reason: 'worktree_verify_errored',
          pause_at_stage: 'VERIFY_FAIL',
          error: err.message,
        };
      }
    }

    if (!batch_id) {
      logger.info('VERIFY stage: no batch_id, skipping guardrail checks', { project_id });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'skipped_verification',
        reasoning: 'VERIFY stage skipped because no batch_id is attached.',
        outcome: {
          status: 'skipped',
          reason: 'no_batch_id',
        },
        confidence: 1,
        batch_id: null,
      });
      return { status: 'skipped', reason: 'no_batch_id' };
    }
    try {
      const result = guardrailRunner.runPostBatchChecks(project_id, batch_id, []);
      logger.info('VERIFY stage: guardrail checks complete', { project_id, batch_id, result });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'verified_batch',
        reasoning: 'VERIFY stage completed post-batch guardrail checks.',
        outcome: {
          batch_id,
          status: result?.status || null,
          passed: result?.passed ?? null,
        },
        confidence: 1,
        batch_id,
      });
      return result;
    } catch (err) {
      logger.warn(`VERIFY stage guardrail check failed: ${err.message}`, { project_id });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'verify_failed',
        reasoning: err.message,
        outcome: {
          batch_id,
          status: 'error',
          error: err.message,
        },
        confidence: 1,
        batch_id,
      });
      return { status: 'error', error: err.message };
    }
  }

  return executeVerifyStage;
}

module.exports = { createVerifyStageRunner, createVerifyStage };
