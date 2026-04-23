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

function listProjectsToRearm(db) {
  return db.prepare(`
    SELECT id, name, status, loop_state, loop_paused_at_stage
    FROM factory_projects
    WHERE COALESCE(auto_recovery_exhausted, 0) = 1
      AND LOWER(COALESCE(status, '')) = 'running'
      AND UPPER(COALESCE(loop_state, 'IDLE')) != 'PAUSED'
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

  function markExhausted(projectId, reason) {
    db.prepare(`UPDATE factory_projects SET auto_recovery_exhausted = 1 WHERE id = ?`).run(projectId);
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
    for (const project of projects) {
      db.prepare(`UPDATE factory_projects
                  SET auto_recovery_attempts = 0,
                      auto_recovery_exhausted = 0,
                      auto_recovery_last_action_at = NULL,
                      auto_recovery_last_strategy = NULL
                  WHERE id = ?`).run(project.id);
      logDecision(db, {
        project_id: project.id,
        stage: 'verify',
        action: 'auto_recovery_rearmed',
        reasoning: `Project resumed active loop state ${project.loop_state || 'IDLE'}; resetting exhausted auto-recovery counters.`,
        outcome: {
          status: project.status,
          loop_state: project.loop_state || null,
          loop_paused_at_stage: project.loop_paused_at_stage || null,
        },
      });
      eventBus?.emit?.('factory.auto_recovery.rearmed', {
        project_id: project.id,
        loop_state: project.loop_state || null,
      });
    }
    return projects.length;
  }

  async function recoverOne(project) {
    const decision = latestRealDecisionForProject(db, project.id);
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

    const strategy = registry.pick(classification);
    if (!strategy) {
      logDecision(db, {
        project_id: project.id, stage: decision?.stage || 'verify',
        action: 'auto_recovery_no_strategy',
        reasoning: `No strategy registered for category ${classification.category}`,
        outcome: { category: classification.category, suggested: classification.suggested_strategies },
        batch_id: decision?.batch_id || null,
      });
      markExhausted(project.id, 'no_strategy');
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
