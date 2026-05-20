// PRIORITIZE stage — Phase 3 (executor + transition lifted out of loop-controller).
//
// `createPrioritizeStage(deps)` returns both:
//   - executePrioritizeStage(project, instance, selectedWorkItem) — claims/
//     scores the next work item; auto-rejects stuck-executing items and
//     auto-ships already-done ones, re-selecting recursively.
//   - handlePrioritizeTransition({project, instance, currentState}) — the
//     dispatcher-facing transition: runs the executor, handles the
//     no-work-item STARVED/IDLE short-circuit, the Codex-fallback park /
//     failover-routing branches, then advances to PLAN.
// handlePrioritizeTransition calls executePrioritizeStage directly (same
// closure); the executor recurses on itself for re-selection.
//
// Bodies are verbatim from loop-controller.js. Leaf modules are required
// directly; the ~24 loop-controller-internal helpers (and the
// STARVATION_THRESHOLD constant) are injected — they have not been
// extracted, so injecting them keeps this module free of a require cycle
// back into loop-controller.js. loop-controller keeps a one-line wiring:
//   const { executePrioritizeStage, handlePrioritizeTransition } =
//     createPrioritizeStage({ ...deps });

const fs = require('fs');
const factoryIntake = require('../../db/factory/intake');
const { LOOP_STATES, getPendingGateStage } = require('../loop-states');
const { emitAutoShipped, AUTO_SHIPPED_REASONS } = require('../auto-ship');
const { decideCodexFallbackAction, decomposeBeforePark } = require('../codex-fallback');
const logger = require('../../logger').child({ component: 'factory-prioritize-stage' });

const FN_DEPS = [
  'getNeedsReplanCooldownInfo',
  'clearSelectedWorkItem',
  'updateInstanceAndSync',
  'nowIso',
  'claimNextWorkItemForInstance',
  'safeLogDecision',
  'getWorkItemDecisionContext',
  'getDecisionBatchId',
  'parseFactoryTimestampMs',
  'scoreWorkItemForPrioritize',
  'rememberSelectedWorkItem',
  'getWorkItemScopedBatchId',
  'tryGetSelectedWorkItem',
  'incrementConsecutiveEmptyCycles',
  'terminateInstanceAndSync',
  'recordFactoryIdleIfExhausted',
  'setConsecutiveEmptyCycles',
  'getInstanceOrThrow',
  'getDatabaseHandle',
  'getCurrentLoopState',
  'markInstanceFallbackRouting',
  'tryMoveInstanceToStage',
  'getExecutePlanStageForTransition',
];

/**
 * @param {Object} deps  — the 23 FN_DEPS loop-controller-internal helpers
 *   plus `STARVATION_THRESHOLD` (number).
 * @returns {{
 *   executePrioritizeStage: Function,
 *   handlePrioritizeTransition: Function,
 * }}
 */
function createPrioritizeStage(deps = {}) {
  for (const name of FN_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createPrioritizeStage: dep '${name}' is required`);
    }
  }
  if (typeof deps.STARVATION_THRESHOLD !== 'number') {
    throw new TypeError("createPrioritizeStage: dep 'STARVATION_THRESHOLD' (number) is required");
  }
  const {
    getNeedsReplanCooldownInfo,
    clearSelectedWorkItem,
    updateInstanceAndSync,
    nowIso,
    claimNextWorkItemForInstance,
    safeLogDecision,
    getWorkItemDecisionContext,
    getDecisionBatchId,
    parseFactoryTimestampMs,
    scoreWorkItemForPrioritize,
    rememberSelectedWorkItem,
    getWorkItemScopedBatchId,
    tryGetSelectedWorkItem,
    incrementConsecutiveEmptyCycles,
    terminateInstanceAndSync,
    recordFactoryIdleIfExhausted,
    setConsecutiveEmptyCycles,
    getInstanceOrThrow,
    getDatabaseHandle,
    getCurrentLoopState,
    markInstanceFallbackRouting,
    tryMoveInstanceToStage,
    getExecutePlanStageForTransition,
    STARVATION_THRESHOLD,
  } = deps;
  const createShippedDetector = deps.createShippedDetector
    || require('../shipped-detector').createShippedDetector;

  async function executePrioritizeStage(project, instance, selectedWorkItem = null) {
    if (selectedWorkItem && getNeedsReplanCooldownInfo(selectedWorkItem).active) {
      try {
        clearSelectedWorkItem(instance.id);
        factoryIntake.releaseClaimForInstance(instance.id);
        updateInstanceAndSync(instance.id, {
          work_item_id: null,
          last_action_at: nowIso(),
        });
      } catch (err) {
        logger.warn('PRIORITIZE: failed to release cooling needs_replan selection', {
          project_id: project.id,
          instance_id: instance.id,
          work_item_id: selectedWorkItem.id,
          err: err && err.message,
        });
      }
      selectedWorkItem = null;
    }

    const claimResult = selectedWorkItem
      ? { openItems: factoryIntake.listOpenWorkItems({ project_id: project.id, limit: 100 }), workItem: selectedWorkItem }
      : await claimNextWorkItemForInstance(project.id, instance.id);
    const openItems = claimResult.openItems;
    const workItem = claimResult.workItem;
    const coolingNeedsReplanItems = Array.isArray(claimResult.coolingNeedsReplanItems)
      ? claimResult.coolingNeedsReplanItems
      : [];

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PRIORITIZE,
      action: 'selected_work_item',
      reasoning: workItem
        ? 'PRIORITIZE selected the highest-priority open work item.'
        : 'PRIORITIZE found no open work item to select.',
      outcome: {
        selection_status: workItem ? 'selected' : 'not_found',
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, workItem, null, instance),
    });

    if (!workItem) {
      clearSelectedWorkItem(instance.id);
      updateInstanceAndSync(instance.id, { work_item_id: null });
      if (coolingNeedsReplanItems.length > 0) {
        const nextReadyMs = Math.min(...coolingNeedsReplanItems
          .map((item) => Number(item.remaining_ms))
          .filter((value) => Number.isFinite(value)));
        return {
          work_item: null,
          reason: 'needs_replan_cooling',
          stage_result: {
            status: 'needs_replan_cooling',
            cooling_count: coolingNeedsReplanItems.length,
            next_ready_ms: Number.isFinite(nextReadyMs) ? nextReadyMs : null,
            cooling_work_item_ids: coolingNeedsReplanItems.map((item) => item.id),
          },
        };
      }
      return {
        work_item: null,
        reason: 'no open work item selected',
        stage_result: null,
      };
    }

    // Stuck-executing auto-reject: if PRIORITIZE finds a work item already
    // in 'executing' status with updated_at older than 1 hour, a prior
    // cycle claimed it but never reached a terminal state (shipped,
    // rejected, failed). The LEARN reject-not-skip fix closes most of
    // these, but defense-in-depth: close items that slip through here
    // so PRIORITIZE doesn't re-pick the same wedged item every cycle.
    if (workItem.status === 'executing') {
      const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 1h
      const updatedAtMs = workItem.updated_at ? parseFactoryTimestampMs(workItem.updated_at) : NaN;
      if (Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) > STUCK_THRESHOLD_MS) {
        const stalledMinutes = Math.round((Date.now() - updatedAtMs) / 60000);
        try {
          factoryIntake.updateWorkItem(workItem.id, {
            status: 'rejected',
            reject_reason: `stuck_executing_over_1h_no_progress (${stalledMinutes}m since updated_at)`,
          });
        } catch (_e) { void _e; }
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PRIORITIZE,
          action: 'auto_rejected_stuck_executing',
          reasoning: `Work item was in 'executing' status for ${stalledMinutes} minutes without reaching a terminal state. A prior cycle likely failed silently — rejecting so PRIORITIZE can pick real work.`,
          outcome: {
            work_item_id: workItem.id,
            stalled_minutes: stalledMinutes,
            prior_status: 'executing',
          },
          confidence: 1,
          batch_id: getDecisionBatchId(project, workItem, null, instance),
        });
        logger.warn('PRIORITIZE auto-rejected stuck-executing item', {
          project_id: project.id,
          work_item_id: workItem.id,
          title: workItem.title,
          stalled_minutes: stalledMinutes,
        });
        return executePrioritizeStage(project, instance);
      }
    }

    // Auto-detect already-shipped items before wasting execution cycles.
    // If git commit subjects match the item's title (meaning a human or
    // prior session already fixed this), mark it shipped and re-select.
    let shippedDetection = null;
    try {
      const detector = createShippedDetector({ repoRoot: project.path });
      const planContent = workItem.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)
        ? fs.readFileSync(workItem.origin.plan_path, 'utf8')
        : workItem.description || '';
      shippedDetection = detector.detectShipped({ content: planContent, title: workItem.title });
    } catch (_e) { void _e; }

    if (shippedDetection?.shipped && shippedDetection.confidence !== 'low') {
      let shippedWorkItem = null;
      try {
        shippedWorkItem = factoryIntake.updateWorkItem(workItem.id, { status: 'shipped' });
      } catch (err) {
        logger.warn('PRIORITIZE auto-ship status update failed', {
          project_id: project.id,
          work_item_id: workItem.id,
          title: workItem.title,
          err: err && err.message,
        });
      }

      if (shippedWorkItem?.status === 'shipped') {
        factoryIntake.releaseClaimForInstance(instance.id);
        clearSelectedWorkItem(instance.id);
        try {
          emitAutoShipped({
            project_id: project.id,
            stage: LOOP_STATES.PRIORITIZE,
            reason: AUTO_SHIPPED_REASONS.AT_PRIORITIZE,
            work_item_id: workItem.id,
            confidence: shippedDetection.confidence,
            signals: shippedDetection.signals,
            batch_id: getDecisionBatchId(project, workItem, null, instance),
            extra: { ...getWorkItemDecisionContext(shippedWorkItem) },
            reasoning: `Shipped-detector found existing commits matching "${workItem.title}" with ${shippedDetection.confidence} confidence — skipping to next item.`,
          });
        } catch (err) {
          logger.warn('PRIORITIZE auto-ship decision logging failed after status update', {
            project_id: project.id,
            work_item_id: workItem.id,
            title: workItem.title,
            err: err && err.message,
          });
        }
        logger.info('PRIORITIZE auto-shipped already-done item', {
          project_id: project.id,
          work_item_id: workItem.id,
          title: workItem.title,
          confidence: shippedDetection.confidence,
        });
        // Re-select next item recursively (bounded by open item count)
        return executePrioritizeStage(project, instance);
      }
    }

    const scoring = scoreWorkItemForPrioritize(workItem, openItems);
    const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
      priority: scoring.newPriority,
    });
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
    updateInstanceAndSync(instance.id, {
      work_item_id: updatedWorkItem.id,
      batch_id: getWorkItemScopedBatchId(project, updatedWorkItem, instance?.batch_id)
        || updatedWorkItem.batch_id
        || null,
    });

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PRIORITIZE,
      action: 'scored_work_item',
      reasoning: 'PRIORITIZE rescored the selected work item before planning.',
      inputs: {
        open_work_item_count: openItems.length,
      },
      outcome: {
        work_item_id: updatedWorkItem.id,
        old_priority: scoring.oldPriority,
        new_priority: updatedWorkItem.priority,
        score_reason: scoring.scoreReason,
        ...getWorkItemDecisionContext(updatedWorkItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
    });

    return {
      work_item: updatedWorkItem,
      reason: 'scored selected work item',
      stage_result: {
        work_item_id: updatedWorkItem.id,
        old_priority: scoring.oldPriority,
        new_priority: updatedWorkItem.priority,
        score_reason: scoring.scoreReason,
      },
    };
  }

  async function handlePrioritizeTransition({ project, instance, currentState }) {
    let stageResult = null;
    let transitionReason = null;
    let transitionWorkItem = tryGetSelectedWorkItem(instance, project.id) || null;

    const prioritizeStage = await executePrioritizeStage(project, instance, transitionWorkItem);
    transitionWorkItem = prioritizeStage?.work_item || transitionWorkItem;
    stageResult = prioritizeStage?.stage_result || null;
    transitionReason = prioritizeStage?.reason || null;

    if (!prioritizeStage?.work_item) {
      if (stageResult?.status === 'needs_replan_cooling') {
        setConsecutiveEmptyCycles(project.id, 0);
        const updatedInstance = terminateInstanceAndSync(instance.id);
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PRIORITIZE,
          action: 'needs_replan_cooldown_wait',
          reasoning: 'PRIORITIZE found only needs_replan work items still inside cooldown; waiting for the next tick instead of treating intake as empty.',
          outcome: {
            reason: 'needs_replan_cooling',
            from_state: currentState,
            to_state: LOOP_STATES.IDLE,
            cooling_count: stageResult.cooling_count,
            next_ready_ms: stageResult.next_ready_ms,
            cooling_work_item_ids: stageResult.cooling_work_item_ids,
          },
          confidence: 1,
          batch_id: getDecisionBatchId(project, null, null, updatedInstance),
        });
        return {
          instance: updatedInstance,
          transitionWorkItem: null,
          stageResult,
          transitionReason: 'needs_replan_cooling',
          nextState: LOOP_STATES.IDLE,
        };
      }

      const consecutiveEmptyCycles = incrementConsecutiveEmptyCycles(project);
      const nextState = consecutiveEmptyCycles >= STARVATION_THRESHOLD
        ? LOOP_STATES.STARVED
        : LOOP_STATES.IDLE;
      const updatedInstance = nextState === LOOP_STATES.IDLE
        ? terminateInstanceAndSync(instance.id)
        : updateInstanceAndSync(instance.id, {
            loop_state: nextState,
            paused_at_stage: null,
            last_action_at: nowIso(),
          });
      if (nextState === LOOP_STATES.IDLE) {
        recordFactoryIdleIfExhausted(project.id, {
          last_action_at: updatedInstance.last_action_at || null,
          reason: 'no_open_work_item',
        });
      }
      const action = nextState === LOOP_STATES.STARVED
        ? 'entered_starved'
        : 'short_circuit_to_idle';
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PRIORITIZE,
        action,
        reasoning: nextState === LOOP_STATES.STARVED
          ? 'PRIORITIZE repeatedly returned no work item; entering STARVED until recovery scouts replenish intake'
          : 'PRIORITIZE returned no work item; skipping PLAN and architect cycle',
        outcome: {
          reason: 'no_open_work_item',
          from_state: currentState,
          to_state: nextState,
          consecutive_empty_cycles: consecutiveEmptyCycles,
          threshold: STARVATION_THRESHOLD,
          suggested_actions: nextState === LOOP_STATES.STARVED
            ? ['run_starvation_recovery_scout', 'inspect_plans_dir', 'add_factory_work_item']
            : [],
        },
        confidence: 1,
        batch_id: getDecisionBatchId(project, null, null, updatedInstance),
      });
      return {
        instance: updatedInstance,
        transitionWorkItem: null,
        stageResult,
        transitionReason: 'no_open_work_item',
        nextState,
      };
    }

    setConsecutiveEmptyCycles(project.id, 0);
    instance = getInstanceOrThrow(instance.id);

    // Codex Fallback Phase 1 — consult the breaker + project policy before
    // we advance to PLAN. If the breaker is open and the project policy is
    // `wait_for_codex`, park the work item and skip the PLAN advance for
    // this cycle. The park-resume handler (event-bus listener for
    // `circuit:recovered`) will flip parked items back to `pending` once
    // Codex recovers; the next PRIORITIZE tick will re-pick the work.
    // 'auto' / 'manual' policies fall through to the existing PLAN path
    // (Phase 2 will wire actual provider rerouting for 'auto').
    if (transitionWorkItem) {
      let breaker = null;
      try {
        const container = require('../../container').defaultContainer;
        if (container && typeof container.has === 'function' && container.has('circuitBreaker')) {
          breaker = container.get('circuitBreaker');
        }
      } catch (_e) { void _e; /* container unavailable — treat as breaker-closed */ }

      const codexDecision = decideCodexFallbackAction({
        db: getDatabaseHandle(),
        projectId: project.id,
        workItemId: transitionWorkItem.id,
        breaker,
      });

      if (codexDecision.action === 'park') {
        // Codex Fallback Phase 3 — before parking, probe whether decomposition
        // could yield free-eligible sub-items. Log the finding so operators can
        // see "this item WOULD have decomposed into N free sub-tasks" without
        // actually materialising sub-item rows (deferred to Phase 4).
        try {
          let parkProjectConfig = {};
          try { parkProjectConfig = project?.config_json ? JSON.parse(project.config_json) : {}; } catch (_e) { void _e; }
          const decomposeResult = decomposeBeforePark({
            db: getDatabaseHandle(),
            projectId: project.id,
            workItem: transitionWorkItem,
            projectConfig: parkProjectConfig,
          });
          if (decomposeResult.decomposed && decomposeResult.eligibleCount > 0) {
            safeLogDecision({
              project_id: project.id,
              stage: LOOP_STATES.PRIORITIZE,
              actor: 'codex_fallback',
              action: 'decompose_would_yield_eligible',
              reasoning: `Item ${transitionWorkItem.id} could decompose into ${decomposeResult.eligibleCount}/${decomposeResult.subtaskCount} free-eligible sub-items; parking original (sub-item creation deferred).`,
              outcome: { work_item_id: transitionWorkItem.id, ...decomposeResult },
              confidence: 0.9,
              batch_id: getDecisionBatchId(project, transitionWorkItem, null, instance),
            });
          }
        } catch (_decompErr) { void _decompErr; }

        try {
          const { parkWorkItemForCodex } = require('../../db/factory/intake');
          parkWorkItemForCodex({
            db: getDatabaseHandle(),
            workItemId: transitionWorkItem.id,
            reason: codexDecision.reason,
          });
        } catch (parkError) {
          logger.warn('Failed to park work item for codex fallback', {
            err: parkError.message,
            project_id: project.id,
            work_item_id: transitionWorkItem.id,
          });
        }
        // Drop the loop's hold on the now-parked item so a future tick
        // picks fresh work without reusing the parked id.
        try {
          clearSelectedWorkItem(instance.id);
          instance = updateInstanceAndSync(instance.id, {
            work_item_id: null,
            last_action_at: nowIso(),
          });
        } catch (_e) { void _e; }
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PRIORITIZE,
          actor: 'codex_fallback',
          action: 'parked_codex_unavailable',
          reasoning: `Codex unavailable and project policy=wait_for_codex; parking item ${transitionWorkItem.id}`,
          outcome: {
            work_item_id: transitionWorkItem.id,
            reason: codexDecision.reason,
          },
          confidence: 1,
          batch_id: getDecisionBatchId(project, transitionWorkItem, null, instance),
        });
        return {
          instance,
          transitionWorkItem: null,
          stageResult,
          transitionReason: 'parked_codex_unavailable',
          nextState: getCurrentLoopState(instance),
        };
      }
      if (codexDecision.action === 'proceed_with_fallback') {
        // Codex Fallback Phase 2 — Codex is unavailable but project policy
        // is 'auto'. Mark the loop instance so the EXECUTE submit path
        // (Task 7) routes the next task through the 'codex-down-failover'
        // routing template instead of the system default. The marker lives
        // in module-memory (`instancesPendingFallbackRouting`); see the
        // declaration block for the rationale on choosing in-memory over
        // a DB column or per-task arg propagation. We still fall through
        // to the existing PLAN advance — only the routing changes.
        markInstanceFallbackRouting(instance.id);
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PRIORITIZE,
          actor: 'codex_fallback',
          action: 'marked_for_failover_routing',
          reasoning:
            `Codex breaker open and project policy=auto; marking instance ${instance.id} so EXECUTE uses codex-down-failover chain for work item ${transitionWorkItem.id}`,
          outcome: {
            work_item_id: transitionWorkItem.id,
            instance_id: instance.id,
            fallback_template: 'codex-down-failover',
          },
          confidence: 1,
          batch_id: getDecisionBatchId(project, transitionWorkItem, null, instance),
        });
      }
      // 'proceed' falls through to PLAN with normal routing.
    }

    const enterPlan = tryMoveInstanceToStage(instance, LOOP_STATES.PLAN, {
      work_item_id: transitionWorkItem?.id ?? instance.work_item_id,
    });
    if (enterPlan.blocked) {
      instance = enterPlan.instance;
      return {
        instance,
        transitionWorkItem,
        stageResult,
        transitionReason: 'stage_occupied',
        nextState: getCurrentLoopState(instance),
      };
    }

    instance = enterPlan.instance;
    const planStage = await getExecutePlanStageForTransition()(project, instance, transitionWorkItem);
    if (planStage?.stage_result) {
      stageResult = planStage.stage_result;
    }
    if (planStage?.reason) {
      transitionReason = planStage.reason;
    }
    if (planStage?.work_item) {
      transitionWorkItem = planStage.work_item;
    }
    instance = getInstanceOrThrow(instance.id);

    if (planStage?.skip_to_execute) {
      const moveToExecute = tryMoveInstanceToStage(instance, LOOP_STATES.EXECUTE, {
        work_item_id: transitionWorkItem?.id ?? instance.work_item_id,
      });
      instance = moveToExecute.instance;
      if (moveToExecute.blocked) {
        transitionReason = 'stage_occupied';
      }
    } else if (getPendingGateStage(currentState, project.trust_level) === LOOP_STATES.PLAN) {
      instance = updateInstanceAndSync(instance.id, {
        paused_at_stage: LOOP_STATES.PLAN,
        last_action_at: nowIso(),
      });
    }

    return {
      instance,
      transitionWorkItem,
      stageResult,
      transitionReason,
      nextState: getCurrentLoopState(instance),
    };
  }

  return { executePrioritizeStage, handlePrioritizeTransition };
}

module.exports = { createPrioritizeStage };
