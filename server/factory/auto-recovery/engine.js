'use strict';

const { listRecoveryCandidates } = require('./candidate-query');
const { createClassifier } = require('./classifier');
const { createRegistry } = require('./registry');

const MAX_ATTEMPTS = 5;

function latestRealDecisionForProject(db, projectId) {
  const row = db.prepare(`
    SELECT id, project_id, stage, actor, action, reasoning,
           inputs_json, outcome_json, confidence, batch_id, created_at
    FROM factory_decisions
    WHERE project_id = ? AND COALESCE(actor, '') != 'auto-recovery'
    ORDER BY id DESC LIMIT 1
  `).get(projectId);
  if (!row) return null;
  let outcome = null;
  try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : null; } catch {}
  return { ...row, outcome };
}

function latestRelevantDecisionForProject(db, project) {
  if (!project?.id) return null;
  const batchId = project.loop_batch_id || null;
  const pausedStage = String(project.loop_paused_at_stage || '').trim().toLowerCase();
  const scopedClauses = [];
  const params = [project.id];

  if (batchId) {
    scopedClauses.push('batch_id = ?');
    params.push(batchId);
  }
  if (pausedStage) {
    scopedClauses.push('stage = ?');
    params.push(pausedStage);
  }

  const scopedWhere = scopedClauses.length > 0
    ? ` AND (${scopedClauses.join(' OR ')})`
    : '';
  const row = db.prepare(`
    SELECT id, project_id, stage, actor, action, reasoning,
           inputs_json, outcome_json, confidence, batch_id, created_at
    FROM factory_decisions
    WHERE project_id = ? AND COALESCE(actor, '') != 'auto-recovery'${scopedWhere}
    ORDER BY id DESC LIMIT 1
  `).get(...params);
  if (!row) return latestRealDecisionForProject(db, project.id);
  let outcome = null;
  try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : null; } catch {}
  return { ...row, outcome };
}

function logDecision(db, { project_id, stage, action, reasoning, outcome, confidence, batch_id }) {
  db.prepare(`INSERT INTO factory_decisions
    (project_id, stage, actor, action, reasoning, outcome_json, confidence, batch_id, created_at)
    VALUES (?, ?, 'auto-recovery', ?, ?, ?, ?, ?, ?)`)
    .run(project_id, stage || 'verify', action, reasoning || null,
         outcome ? JSON.stringify(outcome) : null,
         typeof confidence === 'number' ? confidence : 1,
         batch_id || null,
         new Date().toISOString());
}

// Counts auto-recovery strategy_selected decisions for a given matched_rule
// since the most recent rearm/exhaust event (or since the start of time if
// neither has fired). Used by the engine to budget-pick the next strategy
// instead of always returning the first applicable one.
//
// The scope window resets on `auto_recovery_rearmed` (project resumed
// active progress) and on `auto_recovery_exhausted` (a previous chain ended).
// This means each fresh PAUSED state gets a clean budget per strategy —
// retry's 3 attempts are scoped to the current pause, not lifetime.
function recentStrategyAttemptsForRule(db, projectId, matchedRule) {
  const counts = new Map();
  if (!projectId) return counts;
  const scopeRow = db.prepare(`
    SELECT created_at FROM factory_decisions
    WHERE project_id = ? AND COALESCE(actor, '') = 'auto-recovery'
      AND action IN ('auto_recovery_rearmed', 'auto_recovery_exhausted')
    ORDER BY id DESC LIMIT 1
  `).get(projectId);
  const scopeStart = scopeRow?.created_at || null;

  const params = [projectId];
  let sql = `SELECT outcome_json FROM factory_decisions
             WHERE project_id = ? AND COALESCE(actor, '') = 'auto-recovery'
               AND action = 'auto_recovery_strategy_selected'`;
  if (scopeStart) {
    sql += ` AND created_at > ?`;
    params.push(scopeStart);
  }
  sql += ` ORDER BY id ASC`;

  const rows = db.prepare(sql).all(...params);
  for (const row of rows) {
    if (!row?.outcome_json) continue;
    let outcome = null;
    try { outcome = JSON.parse(row.outcome_json); } catch { continue; }
    if (!outcome || typeof outcome !== 'object') continue;
    // Decisions are logged with outcome { strategy, classification: { matched_rule, ... } }.
    // When matchedRule is null (e.g., 'unknown' classification with no rule),
    // scope strictly by null to avoid cross-rule pollution.
    const rowRule = outcome.classification?.matched_rule ?? null;
    if (rowRule !== matchedRule) continue;
    const name = outcome.strategy;
    if (typeof name !== 'string' || !name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function isTerminalRealDecision(decision) {
  if (!decision) return false;
  const action = String(decision.action || '').toLowerCase();
  const outcome = decision.outcome && typeof decision.outcome === 'object' ? decision.outcome : {};
  const status = String(outcome.status || outcome.work_item_status || '').toLowerCase();

  if (action.includes('terminal') && (
    action.includes('rejection')
    || action.includes('terminated')
    || action.includes('completed')
  )) {
    return true;
  }

  return ['rejected', 'closed', 'completed', 'shipped'].includes(status);
}

// Benign-flow decisions are normal-progression signals (loop stage advances,
// item selection, worktree lifecycle, success/no-op execution outcomes,
// post-cancel routing). When the project is paused but the latest decision
// is a benign-flow signal, auto-recovery has nothing to recover FROM —
// trying to recover a successful advance burns the budget and lands the
// project on `pauseProject` via the default escalate strategy, entrenching
// the pause instead of unsticking it.
//
// Live evidence (bitsy 2026-05-03): repeated cycles where a concurrent
// session's `cancel_task` interrupted a running plan_generation, the
// factory routed it to needs_replan, the project paused while the
// LATEST decision was `prioritize/advance_from_prioritize` (a SUCCESS
// signal). Auto-recovery classified that as `unknown`, picked retry,
// exhausted, escalated, paused. Five new "unknown classification"
// cascades emerged in 24h, each with a different benign latest-decision
// shape. Adding rules per shape is whack-a-mole; categorizing benign
// signals at the engine level neutralizes the entire bug class.
//
// IMPORTANT: this set must be empirically maintained as `success` signals
// only. Anything that COULD indicate a stuck condition (paused_at_gate,
// merge_target_dirty, *_failed, *_rejected, *_unusable_*, *_blocked_*,
// *_exhausted, *_short_circuit, baseline_broken) is NOT benign — the
// classifier rules continue to handle those.
const BENIGN_FLOW_ACTION_PREFIXES = [
  'advance_from_',           // SENSE→PRIORITIZE→PLAN→EXECUTE→VERIFY→LEARN transitions
  'started_loop',            // first SENSE entry of a fresh instance
  'started_execution',       // entered EXECUTE
  'starting',                 // generic stage-started signal
];
const BENIGN_FLOW_ACTION_EXACT = new Set([
  'scanned_plans',           // SENSE scanned the plans directory
  'selected_work_item',      // PRIORITIZE picked a WI
  'scored_work_item',        // PRIORITIZE rescored a WI before planning
  'auto_shipped_at_prioritize',  // shipped-detector matched existing commits
  'pre_written_plan_quality_passed',
  'skipped_for_plan_file',   // PLAN bypassed because a pre-written plan exists
  'generated_plan',          // architect cycle completed with a plan
  'plan_quality_passed',     // plan-quality gate accepted the plan
  'worktree_created',        // EXECUTE created an isolated worktree
  'worktree_reused_completed_owner',  // benign reuse, owner already done
  'worktree_reclaimed',      // pre-reclaim of a stale row before fresh create
  'auto_committed_task',     // factory auto-committed leftover dirty state
  'auto_commit_skipped_clean',  // task committed cleanly; nothing extra to capture
  'completed_execution',     // plan executor finished (success path)
  'execute_completed_after_no_op_retries',  // Phase E benign no-op cluster
  'execute_completed_with_agent_self_commits',  // 2026-05-03 self-commits fix
  'verified_batch',          // VERIFY guardrails passed
  'worktree_verify_passed',  // verify_command passed remotely
  'verify_empty_branch_routed_to_needs_replan',  // factory-level routing decision
  'cannot_generate_plan_routed_to_needs_replan',  // post-cancel routing
  'learned',                 // LEARN analyzed post-batch feedback
  'worktree_merged',         // LEARN merged the feature branch
  'shipped_work_item',       // LEARN marked the WI shipped
  'gate_approved',           // recovery's prior approval cleared a pause
]);

function isBenignFlowDecision(decision) {
  if (!decision) return false;
  const action = String(decision.action || '');
  if (BENIGN_FLOW_ACTION_EXACT.has(action)) return true;
  for (const prefix of BENIGN_FLOW_ACTION_PREFIXES) {
    if (action.startsWith(prefix)) return true;
  }
  return false;
}

function listProjectsToRearm(db) {
  return db.prepare(`
    SELECT id, name, status, loop_state, loop_batch_id, loop_paused_at_stage, auto_recovery_last_action_at
    FROM factory_projects
    WHERE COALESCE(auto_recovery_exhausted, 0) = 1
      AND LOWER(COALESCE(status, '')) = 'running'
  `).all();
}

function createAutoRecoveryEngine({
  db, logger, eventBus,
  rules = [], strategies = [],
  services = null,
  nowMs = () => Date.now(),
}) {
  const registry = createRegistry({ logger });
  registry.registerFromPlugin('engine-direct', {
    classifierRules: rules, recoveryStrategies: strategies,
  });
  const classifier = createClassifier({ rules: registry.getRules() });

  // Closure-level cache of prepared statements. The factory is constructed
  // once per engine instance and `db` stays bound, so prepares are reused
  // across all tick invocations.
  const _stmtCache = new Map();
  function _getStmt(key, sql) {
    const cached = _stmtCache.get(key);
    if (cached) return cached;
    const stmt = db.prepare(sql);
    _stmtCache.set(key, stmt);
    return stmt;
  }

  function markExhausted(projectId, reason) {
    // Bump auto_recovery_last_action_at alongside the exhausted flag so
    // rearmRecoveredProjects' "newer real decision" check has a fresh
    // anchor. Previously, hitting the no_strategy path (which doesn't
    // call recoverOne's strategy block where last_action_at gets bumped)
    // left this column unchanged. With the new `await_self_heal`
    // classifier rules — execute_paused_active_worktree_owner et al —
    // the no_strategy path is now hot, and the stale anchor caused
    // every factory tick to:
    //   1. classify the same paused_at_gate fingerprint
    //   2. mark exhausted (without bumping last_action_at)
    //   3. tick → rearm sees latestDecisionAt > stale lastRecoveryAt → rearm
    //   4. classify again → same outcome → exhaust again
    // The decision log fills with rearm/classify/exhaust spam every tick
    // for as long as the underlying wait condition holds. Bumping
    // last_action_at here breaks the cycle: rearm only triggers when a
    // genuinely new decision lands after the exhaust, not on every tick.
    db.prepare(`UPDATE factory_projects
                SET auto_recovery_exhausted = 1,
                    auto_recovery_last_action_at = ?
                WHERE id = ?`).run(new Date().toISOString(), projectId);
    logDecision(db, {
      project_id: projectId, stage: 'verify',
      action: 'auto_recovery_exhausted',
      reasoning: `Auto-recovery exhausted: ${reason}`,
      outcome: { reason, max_attempts: MAX_ATTEMPTS },
    });
    eventBus?.emit?.('factory.auto_recovery.exhausted', { project_id: projectId, reason });
  }

  function rearmRecoveredProjects() {
    const projects = listProjectsToRearm(db);
    let rearmed = 0;
    for (const project of projects) {
      const activeProgress = String(project.loop_state || 'IDLE').toUpperCase() !== 'PAUSED';
      const latestDecision = activeProgress ? null : latestRelevantDecisionForProject(db, project);
      const latestDecisionAt = Date.parse(latestDecision?.created_at || '');
      const lastRecoveryAt = Date.parse(project.auto_recovery_last_action_at || '');
      const hasNewRealDecision = Number.isFinite(latestDecisionAt)
        && (!Number.isFinite(lastRecoveryAt) || latestDecisionAt > lastRecoveryAt);

      if (!activeProgress && !hasNewRealDecision) {
        continue;
      }

      const rearmCause = activeProgress ? 'active_progress' : 'new_real_decision';
      _getStmt('rearmProject', `UPDATE factory_projects
                  SET auto_recovery_attempts = 0,
                      auto_recovery_exhausted = 0,
                      auto_recovery_last_action_at = NULL,
                      auto_recovery_last_strategy = NULL
                  WHERE id = ?`).run(project.id);
      logDecision(db, {
        project_id: project.id,
        stage: 'verify',
        action: 'auto_recovery_rearmed',
        reasoning: activeProgress
          ? `Project resumed active loop state ${project.loop_state || 'IDLE'}; resetting exhausted auto-recovery counters.`
          : `Project recorded a newer real decision (${latestDecision?.action || 'unknown'}) after the last auto-recovery attempt; resetting exhausted auto-recovery counters.`,
        outcome: {
          status: project.status,
          loop_state: project.loop_state || null,
          loop_paused_at_stage: project.loop_paused_at_stage || null,
          rearm_cause: rearmCause,
          latest_decision_action: latestDecision?.action || null,
          latest_decision_stage: latestDecision?.stage || null,
        },
      });
      eventBus?.emit?.('factory.auto_recovery.rearmed', {
        project_id: project.id,
        loop_state: project.loop_state || null,
        rearm_cause: rearmCause,
      });
      rearmed += 1;
    }
    return rearmed;
  }

  async function recoverOne(project) {
    const decision = latestRelevantDecisionForProject(db, project);
    if (isTerminalRealDecision(decision)) {
      logDecision(db, {
        project_id: project.id,
        stage: decision?.stage || 'verify',
        action: 'auto_recovery_skipped_terminal',
        reasoning: `Latest real decision ${decision.action} is terminal; auto-recovery will not retry a stopped loop.`,
        outcome: {
          latest_decision_action: decision.action,
          latest_decision_stage: decision.stage || null,
          latest_decision_outcome: decision.outcome || null,
        },
        confidence: 1,
        batch_id: decision?.batch_id || null,
      });
      markExhausted(project.id, 'terminal_decision');
      return { attempted: false, strategy: null, skipped: 'terminal_decision' };
    }

    // 2026-05-03: skip recovery when the latest decision is a benign
    // forward-progress signal. The project may be paused for a reason
    // unrelated to the loop's logical state (concurrent cutover killed a
    // task subprocess, a peer session called pauseProject, etc.). Trying
    // to recover a successful advance burns the budget on no-op retries
    // and culminates in escalate's pauseProject — entrenching the pause
    // and triggering peer-session "leaked task" cancellations on the next
    // attempt. The factory tick will naturally re-tick when pause-cause
    // resolves. Log a deterministic skip action so the decision log shows
    // recovery's reasoning instead of a silent no-op.
    if (isBenignFlowDecision(decision)) {
      logDecision(db, {
        project_id: project.id,
        stage: decision?.stage || 'verify',
        action: 'auto_recovery_skipped_benign',
        reasoning: `Latest real decision ${decision.action} is a benign forward-progress signal; auto-recovery has nothing to recover from. Project will resume on the next tick when the pause-cause clears.`,
        outcome: {
          latest_decision_action: decision.action,
          latest_decision_stage: decision.stage || null,
        },
        confidence: 1,
        batch_id: decision?.batch_id || null,
      });
      // Bump last_action_at without touching the exhausted flag so rearm's
      // "newer real decision" check does not treat this skip as fresh
      // progress. The project keeps its current exhausted status; it is
      // not paused, not exhausted, just deferred to the next tick.
      db.prepare(`UPDATE factory_projects
                  SET auto_recovery_last_action_at = ?
                  WHERE id = ?`).run(new Date().toISOString(), project.id);
      return { attempted: false, strategy: null, skipped: 'benign_flow_decision' };
    }

    const classifyInput = decision
      ? decision
      : { action: 'never_started', stage: 'plan', outcome: {} };
    const classification = classifier.classify(classifyInput);

    logDecision(db, {
      project_id: project.id, stage: decision?.stage || 'verify',
      action: 'auto_recovery_classified',
      reasoning: `Classified as ${classification.category} (rule: ${classification.matched_rule || 'none'})`,
      outcome: classification,
      confidence: classification.confidence,
      batch_id: decision?.batch_id || null,
    });

    const recentAttempts = recentStrategyAttemptsForRule(db, project.id, classification.matched_rule);
    const strategy = typeof registry.pickWithBudget === 'function'
      ? registry.pickWithBudget(classification, recentAttempts)
      : registry.pick(classification);
    if (!strategy) {
      // Two reasons we end up here:
      //   1. None of the suggested strategies are registered (legacy case
      //      — `no_strategy`).
      //   2. Every applicable strategy in the chain has already burned its
      //      `max_attempts_per_project` budget for this matched_rule since
      //      the most recent rearm — `all_strategies_exhausted`.
      // Distinguishing the two matters for triage: case 2 means the chain
      // ran to completion without unblocking the loop, which is the signal
      // we want to surface. Without this distinction, every operator would
      // see "no_strategy" and assume a misconfiguration.
      const anyApplicableExists = (classification.suggested_strategies || []).some((name) => {
        const strat = registry.getStrategyByName(name);
        if (!strat) return false;
        return strat.applicable_categories.includes(classification.category)
            || strat.applicable_categories.includes('any');
      });
      const reason = anyApplicableExists ? 'all_strategies_exhausted' : 'no_strategy';
      const action = anyApplicableExists
        ? 'auto_recovery_all_strategies_exhausted'
        : 'auto_recovery_no_strategy';
      const reasoning = anyApplicableExists
        ? `Every strategy in chain [${(classification.suggested_strategies || []).join(', ')}] has hit max_attempts_per_project for matched_rule=${classification.matched_rule || 'none'} since the last rearm; advancing to ${reason}.`
        : `No strategy registered for category ${classification.category}`;
      logDecision(db, {
        project_id: project.id, stage: decision?.stage || 'verify',
        action,
        reasoning,
        outcome: {
          category: classification.category,
          matched_rule: classification.matched_rule || null,
          suggested: classification.suggested_strategies,
          strategy_attempts: Object.fromEntries(recentAttempts),
        },
        batch_id: decision?.batch_id || null,
      });
      markExhausted(project.id, reason);
      return { attempted: false, strategy: null };
    }

    logDecision(db, {
      project_id: project.id, stage: decision?.stage || 'verify',
      action: 'auto_recovery_strategy_selected',
      reasoning: `Selected ${strategy.name} for ${classification.category}`,
      outcome: { strategy: strategy.name, classification },
      batch_id: decision?.batch_id || null,
    });

    const attempts = (project.auto_recovery_attempts || 0) + 1;
    db.prepare(`UPDATE factory_projects
                SET auto_recovery_attempts = ?, auto_recovery_last_strategy = ?,
                    auto_recovery_last_action_at = ?
                WHERE id = ?`)
      .run(attempts, strategy.name, new Date().toISOString(), project.id);

    try {
      const result = await strategy.run({ project, decision, classification, services, logger });
      logDecision(db, {
        project_id: project.id, stage: decision?.stage || 'verify',
        action: 'auto_recovery_strategy_succeeded',
        reasoning: `${strategy.name} returned next_action=${result?.next_action || 'unknown'}`,
        outcome: { strategy: strategy.name, result },
        batch_id: decision?.batch_id || null,
      });
      eventBus?.emit?.('factory.auto_recovery.attempted', {
        project_id: project.id, strategy: strategy.name, attempts, success: true,
      });
    } catch (err) {
      logDecision(db, {
        project_id: project.id, stage: decision?.stage || 'verify',
        action: 'auto_recovery_strategy_failed',
        reasoning: `${strategy.name} threw: ${err.message}`,
        outcome: { strategy: strategy.name, error: err.message, stack: err.stack },
        batch_id: decision?.batch_id || null,
      });
      eventBus?.emit?.('factory.auto_recovery.attempted', {
        project_id: project.id, strategy: strategy.name, attempts, success: false,
      });
    }

    if (attempts >= MAX_ATTEMPTS) markExhausted(project.id, 'max_attempts');
    return { attempted: true, strategy: strategy.name };
  }

  async function tick() {
    const currentNowMs = nowMs();
    const rearmed = rearmRecoveredProjects();
    const candidates = listRecoveryCandidates(db, { nowMs: currentNowMs });
    let attempts = 0;
    for (const project of candidates) {
      try {
        const r = await recoverOne(project);
        if (r.attempted) attempts += 1;
      } catch (err) {
        logger.error?.('auto-recovery engine error', { project_id: project.id, err: err.message });
      }
    }
    return { candidates: candidates.length, attempts, rearmed };
  }

  async function reconcileOnStartup() { return tick(); }

  return {
    tick, reconcileOnStartup, recoverOne, MAX_ATTEMPTS,
    _registry: { getRules: () => registry.getRules(), getStrategies: () => registry.getStrategies() },
  };
}

module.exports = { createAutoRecoveryEngine, MAX_ATTEMPTS };
