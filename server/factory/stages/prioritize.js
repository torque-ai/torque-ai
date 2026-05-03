'use strict';

// Phase X1: minimum delay between a needs_replan rejection and PRIORITIZE
// re-pickup. Without a cooldown, a rejected item would loop straight back
// into PLAN on the next tick, racing the architect against itself. 5min
// gives the queue room to admit other work and lets the operator see the
// rejection in the dashboard before the next attempt fires.
const NEEDS_REPLAN_COOLDOWN_MS = 5 * 60 * 1000;
const STARVATION_THRESHOLD = 3;

const PRIORITIZE_SOURCE_BASE_SCORES = Object.freeze({
  plan_file: 82,
  manual: 76,
  api: 72,
  webhook: 72,
  github_issue: 68,
  github: 68,
  conversation: 64,
  conversational: 64,
  ci: 60,
  scheduled_scan: 56,
  scout: 56,
  self_generated: 52,
});

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`Missing PRIORITIZE stage dependency: ${name}`);
  }
}

function getCreatedAtValue(item) {
  const createdAt = item?.created_at ? Date.parse(item.created_at) : Number.NaN;
  if (Number.isFinite(createdAt)) {
    return createdAt;
  }

  const numericId = Number(item?.id);
  return Number.isFinite(numericId) ? numericId : Number.MAX_SAFE_INTEGER;
}

function compareByIntakeOrder(left, right) {
  const leftCreatedAt = getCreatedAtValue(left);
  const rightCreatedAt = getCreatedAtValue(right);

  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  const leftId = Number(left?.id);
  const rightId = Number(right?.id);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }

  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

function createPrioritizeStage({
  LOOP_STATES,
  clearFactoryIdleForPendingWork,
  clearSelectedWorkItem,
  database,
  decideCodexFallbackAction,
  decomposeBeforePark,
  factoryHealth,
  factoryIntake,
  factoryWorktrees,
  fs,
  getCurrentLoopState,
  getDecisionBatchId,
  getExecutePlanStage,
  getInstanceOrThrow,
  getPendingGateStage,
  getWorkItemDecisionContext,
  incrementConsecutiveEmptyCycles,
  logger,
  markInstanceFallbackRouting,
  nowIso,
  recordFactoryIdleIfExhausted,
  rememberSelectedWorkItem,
  safeLogDecision,
  setConsecutiveEmptyCycles,
  terminateInstanceAndSync,
  tryGetSelectedWorkItem,
  tryMoveInstanceToStage,
  updateInstanceAndSync,
  workItemStatusOrder,
} = {}) {
  assertFunction(clearFactoryIdleForPendingWork, 'clearFactoryIdleForPendingWork');
  assertFunction(clearSelectedWorkItem, 'clearSelectedWorkItem');
  assertFunction(database?.getDbInstance, 'database.getDbInstance');
  assertFunction(decideCodexFallbackAction, 'decideCodexFallbackAction');
  assertFunction(decomposeBeforePark, 'decomposeBeforePark');
  assertFunction(factoryHealth?.getProject, 'factoryHealth.getProject');
  assertFunction(factoryIntake?.claimWorkItem, 'factoryIntake.claimWorkItem');
  assertFunction(factoryIntake?.listOpenWorkItems, 'factoryIntake.listOpenWorkItems');
  assertFunction(factoryIntake?.normalizePriority, 'factoryIntake.normalizePriority');
  assertFunction(factoryIntake?.updateWorkItem, 'factoryIntake.updateWorkItem');
  assertFunction(factoryWorktrees?.getLatestWorktreeForWorkItem, 'factoryWorktrees.getLatestWorktreeForWorkItem');
  assertFunction(fs?.existsSync, 'fs.existsSync');
  assertFunction(fs?.readFileSync, 'fs.readFileSync');
  assertFunction(getCurrentLoopState, 'getCurrentLoopState');
  assertFunction(getDecisionBatchId, 'getDecisionBatchId');
  assertFunction(getExecutePlanStage, 'getExecutePlanStage');
  assertFunction(getInstanceOrThrow, 'getInstanceOrThrow');
  assertFunction(getPendingGateStage, 'getPendingGateStage');
  assertFunction(getWorkItemDecisionContext, 'getWorkItemDecisionContext');
  assertFunction(incrementConsecutiveEmptyCycles, 'incrementConsecutiveEmptyCycles');
  assertFunction(markInstanceFallbackRouting, 'markInstanceFallbackRouting');
  assertFunction(nowIso, 'nowIso');
  assertFunction(recordFactoryIdleIfExhausted, 'recordFactoryIdleIfExhausted');
  assertFunction(rememberSelectedWorkItem, 'rememberSelectedWorkItem');
  assertFunction(safeLogDecision, 'safeLogDecision');
  assertFunction(setConsecutiveEmptyCycles, 'setConsecutiveEmptyCycles');
  assertFunction(terminateInstanceAndSync, 'terminateInstanceAndSync');
  assertFunction(tryGetSelectedWorkItem, 'tryGetSelectedWorkItem');
  assertFunction(tryMoveInstanceToStage, 'tryMoveInstanceToStage');
  assertFunction(updateInstanceAndSync, 'updateInstanceAndSync');

  if (!Array.isArray(workItemStatusOrder)) {
    throw new TypeError('Missing PRIORITIZE stage dependency: workItemStatusOrder');
  }

  function healAlreadyShippedWorkItem(project_id, item) {
    // Self-heal: if an open work item already has a merged factory_worktrees
    // row, its EXECUTE batch shipped but the work-item status update didn't
    // land (crash between markMerged and updateWorkItem, or loop interrupted
    // at LEARN). Advance the item to 'shipped' now so PRIORITIZE won't
    // re-pick it and trigger a duplicate EXECUTE.
    try {
      const latest = factoryWorktrees.getLatestWorktreeForWorkItem(project_id, item.id);
      if (!latest || latest.status !== 'merged') {
        return null;
      }
      const healed = factoryIntake.updateWorkItem(item.id, { status: 'shipped' });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'healed_already_shipped',
        reasoning: 'Self-heal: work item had a merged factory worktree but status was non-terminal. Advancing to shipped before PRIORITIZE re-picks.',
        inputs: {
          work_item_id: item.id,
          previous_status: item.status,
        },
        outcome: {
          work_item_id: item.id,
          previous_status: item.status,
          new_status: 'shipped',
          factory_worktree_id: latest.id,
          branch: latest.branch,
          merged_at: latest.mergedAt || latest.merged_at || null,
        },
        confidence: 1,
        batch_id: latest.batchId || latest.batch_id || null,
      });
      return healed;
    } catch (err) {
      logger.warn('factory self-heal check for merged worktree failed', {
        project_id,
        work_item_id: item?.id,
        err: err.message,
      });
      return null;
    }
  }

  function parseProjectScoresForPromotion(project) {
    if (!project) return {};
    if (project.scores && typeof project.scores === 'object') return project.scores;
    if (typeof project.scores_json === 'string') {
      try { return JSON.parse(project.scores_json); } catch { return {}; }
    }
    return {};
  }

  function parsePromotionConfigForPromotion(project) {
    const raw = project?.config_json;
    if (!raw) return null;
    try {
      const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return cfg.scout_promotion || null;
    } catch (err) {
      logger.warn('promotion_config_parse_failed', { err: err && err.message });
      return null;
    }
  }

  function didPromoteScoutAhead(originalSurvivors, ranked) {
    const origFirst = originalSurvivors[0];
    const rankedFirst = ranked[0];
    if (!origFirst || !rankedFirst) return false;
    return origFirst.source !== 'scout' && rankedFirst.source === 'scout';
  }

  async function claimNextWorkItemForInstance(project_id, instance_id) {
    const openItems = factoryIntake.listOpenWorkItems({ project_id, limit: 100 });
    if (!Array.isArray(openItems) || openItems.length === 0) {
      return { openItems: [], workItem: null };
    }
    clearFactoryIdleForPendingWork(project_id, openItems.length);

    // Pre-pass: heal any items whose worktrees already merged. These must not
    // be considered for PRIORITIZE - they already shipped; the EXECUTE was
    // just never closed out cleanly.
    const survivors = [];
    for (const item of openItems) {
      if (!item) continue;
      const healed = healAlreadyShippedWorkItem(project_id, item);
      if (healed) {
        continue; // dropped from candidates
      }
      survivors.push(item);
    }

    // Cluster B promotion: rank survivors by severity + score triggers.
    // Fall back to today's status-only order on any error - observability
    // must never block the loop.
    const project = factoryHealth.getProject(project_id);
    const projectScores = parseProjectScoresForPromotion(project);
    const promotionConfig = parsePromotionConfigForPromotion(project);
    let rankedCandidates = survivors;
    try {
      const { rankIntake } = require('../promotion-policy');
      rankedCandidates = rankIntake(survivors, { projectScores, promotionConfig });
      if (didPromoteScoutAhead(survivors, rankedCandidates)) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.PRIORITIZE,
          action: 'scout_promoted',
          reasoning: 'Scout finding promoted ahead of lower-severity / lower-score candidates.',
          outcome: {
            promoted_ids: rankedCandidates
              .filter((i) => i && i.source === 'scout')
              .slice(0, 3)
              .map((i) => i.id),
            project_scores: projectScores,
          },
          confidence: 1,
        });
      }
    } catch (err) {
      logger.warn('promotion_policy_failed', { err: err && err.message });
      rankedCandidates = survivors;
    }

    const orderedCandidates = [];
    for (const status of workItemStatusOrder) {
      orderedCandidates.push(...rankedCandidates.filter((item) => item && item.status === status));
    }
    orderedCandidates.push(...rankedCandidates.filter((item) => !orderedCandidates.includes(item)));

    const maxRepicks = Math.max(1, (promotionConfig?.stale_max_repicks) || 3);
    const skipped = [];
    let staleProbeBudgetExhaustedLogged = false;
    const projectPath = project?.path || null;
    const { probeStaleness } = require('../stale-probe');

    for (const item of orderedCandidates) {
      if (!item) continue;
      if (item.claimed_by_instance_id === instance_id) {
        return { openItems: survivors, workItem: item };
      }
      if (item.claimed_by_instance_id) continue;

      // Phase X1: needs_replan cooldown. An item that was just rejected
      // for plan quality must not be re-picked on the next tick - that
      // would race the architect against itself with no chance for fresh
      // context. Skip if we're inside the cooldown window; PRIORITIZE will
      // try again on a subsequent tick once the cooldown expires.
      if (item.status === 'needs_replan') {
        const updatedAtMs = item.updated_at ? Date.parse(item.updated_at) : NaN;
        if (Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) < NEEDS_REPLAN_COOLDOWN_MS) {
          continue;
        }
      }

      // Stale probe - non-scout items Gate-1-out immediately in probeStaleness,
      // so it is safe to run for every candidate.
      let probe = { stale: false, reason: 'skipped' };
      if (skipped.length < maxRepicks) {
        try {
          probe = await probeStaleness(item, { projectPath, promotionConfig });
        } catch (err) {
          logger.warn('stale_probe_threw', { err: err && err.message, work_item_id: item.id });
          probe = { stale: false, reason: 'probe_errored' };
        }
      } else if (!staleProbeBudgetExhaustedLogged) {
        staleProbeBudgetExhaustedLogged = true;
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.PRIORITIZE,
          action: 'stale_probe_budget_exhausted',
          reasoning: 'Stale probe skip budget exhausted; claiming the next open item instead of reporting an empty intake queue.',
          outcome: {
            skipped,
            max_repicks: maxRepicks,
            fallback_work_item_id: item.id,
          },
          confidence: 1,
        });
      }

      if (probe.stale) {
        try {
          factoryIntake.updateWorkItem(item.id, { status: 'shipped_stale' });
        } catch (err) {
          logger.warn('stale_status_write_failed', { err: err && err.message, work_item_id: item.id });
        }
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.PRIORITIZE,
          action: 'skipped_stale_scout_item',
          reasoning: `Scout finding no longer reproduces: ${probe.reason}`,
          outcome: {
            work_item_id: item.id,
            stale_reason: probe.reason,
            commits_since_scan: probe.commits_since_scan,
            probe_ms: probe.probe_ms,
          },
          confidence: 1,
        });
        skipped.push(item.id);
        continue;
      }

      const claimed = factoryIntake.claimWorkItem(item.id, instance_id);
      if (claimed) {
        return { openItems: survivors, workItem: claimed };
      }
    }

    if (skipped.length >= maxRepicks) {
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'stale_probe_starvation',
        reasoning: `Top ${skipped.length} candidates all marked stale; PRIORITIZE advanced without a claim.`,
        outcome: { skipped },
        confidence: 1,
      });
    }

    return { openItems: survivors, workItem: null };
  }

  function clampPriority(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return factoryIntake.normalizePriority(undefined);
    }

    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  function scoreWorkItemForPrioritize(workItem, openItems = []) {
    if (!workItem) {
      return null;
    }

    const oldPriority = factoryIntake.normalizePriority(
      workItem.priority,
      factoryIntake.normalizePriority(undefined)
    );
    const sourceBase = PRIORITIZE_SOURCE_BASE_SCORES[workItem.source] ?? 62;
    const createdAt = getCreatedAtValue(workItem);
    const ageMs = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : 0;
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const ageBoost = Math.min(12, ageDays);

    const intakeOrder = openItems
      .slice()
      .sort(compareByIntakeOrder)
      .findIndex((item) => item?.id === workItem.id);
    const intakeIndex = intakeOrder === -1 ? openItems.length : intakeOrder;
    const backlogBoost = Math.max(0, Math.min(6, openItems.length - intakeIndex - 1));

    const newPriority = clampPriority(sourceBase + ageBoost + backlogBoost);

    return {
      oldPriority,
      newPriority,
      scoreReason: `source=${workItem.source || 'unknown'} base=${sourceBase}; age_days=${ageDays}; intake_order=${intakeIndex + 1}/${Math.max(openItems.length, 1)}`,
    };
  }

  async function executePrioritizeStage(project, instance, selectedWorkItem = null) {
    const claimResult = selectedWorkItem
      ? { openItems: factoryIntake.listOpenWorkItems({ project_id: project.id, limit: 100 }), workItem: selectedWorkItem }
      : await claimNextWorkItemForInstance(project.id, instance.id);
    const openItems = claimResult.openItems;
    const workItem = claimResult.workItem;

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
      const updatedAtMs = workItem.updated_at ? Date.parse(workItem.updated_at) : NaN;
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
          reasoning: `Work item was in 'executing' status for ${stalledMinutes} minutes without reaching a terminal state. A prior cycle likely failed silently - rejecting so PRIORITIZE can pick real work.`,
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
    try {
      const { createShippedDetector } = require('../shipped-detector');
      const detector = createShippedDetector({ repoRoot: project.path });
      const planContent = workItem.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)
        ? fs.readFileSync(workItem.origin.plan_path, 'utf8')
        : workItem.description || '';
      const detection = detector.detectShipped({ content: planContent, title: workItem.title });
      if (detection.shipped && detection.confidence !== 'low') {
        factoryIntake.updateWorkItem(workItem.id, { status: 'shipped' });
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PRIORITIZE,
          action: 'auto_shipped_at_prioritize',
          reasoning: `Shipped-detector found existing commits matching "${workItem.title}" with ${detection.confidence} confidence - skipping to next item.`,
          inputs: { ...getWorkItemDecisionContext(workItem) },
          outcome: {
            work_item_id: workItem.id,
            confidence: detection.confidence,
            signals: detection.signals,
          },
          confidence: 1,
          batch_id: getDecisionBatchId(project, workItem, null, instance),
        });
        logger.info('PRIORITIZE auto-shipped already-done item', {
          project_id: project.id,
          work_item_id: workItem.id,
          title: workItem.title,
          confidence: detection.confidence,
        });
        // Re-select next item recursively (bounded by open item count)
        return executePrioritizeStage(project, instance);
      }
    } catch (_e) { void _e; }

    const scoring = scoreWorkItemForPrioritize(workItem, openItems);
    const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
      priority: scoring.newPriority,
    });
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
    updateInstanceAndSync(instance.id, { work_item_id: updatedWorkItem.id });

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

    // Codex Fallback Phase 1 - consult the breaker + project policy before
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
      } catch (_e) { void _e; /* container unavailable - treat as breaker-closed */ }

      const codexDecision = decideCodexFallbackAction({
        db: database.getDbInstance(),
        projectId: project.id,
        workItemId: transitionWorkItem.id,
        breaker,
      });

      if (codexDecision.action === 'park') {
        // Codex Fallback Phase 3 - before parking, probe whether decomposition
        // could yield free-eligible sub-items. Log the finding so operators can
        // see "this item WOULD have decomposed into N free sub-tasks" without
        // actually materialising sub-item rows (deferred to Phase 4).
        try {
          let parkProjectConfig = {};
          try { parkProjectConfig = project?.config_json ? JSON.parse(project.config_json) : {}; } catch (_e) { void _e; }
          const decomposeResult = decomposeBeforePark({
            db: database.getDbInstance(),
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
          const { parkWorkItemForCodex } = require('../../db/factory-intake');
          parkWorkItemForCodex({
            db: database.getDbInstance(),
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
        // Codex Fallback Phase 2 - Codex is unavailable but project policy
        // is 'auto'. Mark the loop instance so the EXECUTE submit path
        // (Task 7) routes the next task through the 'codex-down-failover'
        // routing template instead of the system default. The marker lives
        // in module-memory (`instancesPendingFallbackRouting`); see the
        // declaration block for the rationale on choosing in-memory over
        // a DB column or per-task arg propagation. We still fall through
        // to the existing PLAN advance - only the routing changes.
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
    const planStage = await getExecutePlanStage()(project, instance, transitionWorkItem);
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

  return {
    claimNextWorkItemForInstance,
    handlePrioritizeTransition,
    healAlreadyShippedWorkItem,
  };
}

module.exports = {
  createPrioritizeStage,
};
