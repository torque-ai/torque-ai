'use strict';

const { ErrorCodes, makeError } = require('./shared');
const logger = require('../logger').child({ component: 'auto-recovery-handlers' });

function listRecoveryStrategies({ engine }) {
  if (!engine || !engine._registry) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'engine not initialized');
  }
  return {
    rules: engine._registry.getRules().map(r => ({
      name: r.name, category: r.category, priority: r.priority,
      confidence: r.confidence, suggested_strategies: r.suggested_strategies,
    })),
    strategies: engine._registry.getStrategies().map(s => ({
      name: s.name, applicable_categories: s.applicable_categories,
      max_attempts_per_project: s.max_attempts_per_project || null,
    })),
  };
}

function getRecoveryHistory({ db, project_id, limit = 100 }) {
  if (!project_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'project_id is required');
  }
  const rows = db.prepare(`
    SELECT id, project_id, stage, actor, action, reasoning,
           outcome_json, confidence, batch_id, created_at
    FROM factory_decisions
    WHERE project_id = ? AND actor = 'auto-recovery'
    ORDER BY id DESC LIMIT ?
  `).all(project_id, limit);
  return {
    decisions: rows.map(r => {
      let outcome = null;
      try {
        outcome = r.outcome_json ? JSON.parse(r.outcome_json) : null;
      } catch (err) {
        logger.warn({ decision_id: r.id, err: err.message }, 'outcome_json parse failed');
      }
      return { ...r, outcome };
    }),
  };
}

function clearAutoRecovery({ db, project_id }) {
  if (!project_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'project_id is required');
  }
  db.prepare(`UPDATE factory_projects
              SET auto_recovery_attempts = 0,
                  auto_recovery_exhausted = 0,
                  auto_recovery_last_action_at = NULL,
                  auto_recovery_last_strategy = NULL
              WHERE id = ?`).run(project_id);
  db.prepare(`INSERT INTO factory_decisions
              (project_id, stage, actor, action, reasoning, confidence, created_at)
              VALUES (?, 'verify', 'auto-recovery', 'auto_recovery_operator_cleared',
                      'Operator cleared auto-recovery counters', 1, ?)`)
    .run(project_id, new Date().toISOString());
  return { cleared: true, project_id };
}

async function triggerAutoRecovery({ db, engine, project_id }) {
  if (!project_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'project_id is required');
  }
  if (!engine || typeof engine.recoverOne !== 'function') {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'engine not initialized');
  }
  const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(project_id);
  if (!project) {
    return makeError(ErrorCodes.NOT_FOUND, `project not found: ${project_id}`);
  }
  return engine.recoverOne(project);
}

module.exports = { listRecoveryStrategies, getRecoveryHistory, clearAutoRecovery, triggerAutoRecovery };
