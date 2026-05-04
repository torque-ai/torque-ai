'use strict';

const factoryDecisions = require('../db/factory/decisions');
const eventBus = require('../event-bus');
const logger = require('../logger').child({ component: 'decision-log' });

function logDecision({
  project_id,
  stage,
  actor,
  action,
  reasoning,
  inputs,
  outcome,
  confidence,
  batch_id,
}) {
  const result = factoryDecisions.recordDecision({
    project_id,
    stage,
    actor,
    action,
    reasoning,
    inputs,
    outcome,
    confidence,
    batch_id,
  });

  eventBus.emitTaskEvent({
    type: 'factory_decision',
    project_id,
    stage,
    actor,
    action,
    decision_id: result.id,
    batch_id,
    timestamp: result.created_at,
  });

  logger.info({ project_id, stage, actor, action }, 'Factory decision logged');

  return result;
}

function getAuditTrail(project_id, opts) {
  return factoryDecisions.listDecisions(project_id, opts);
}

function getDecisionContext(project_id, batch_id) {
  return factoryDecisions.getDecisionContext(project_id, batch_id);
}

function getDecisionStats(project_id) {
  return factoryDecisions.getDecisionStats(project_id);
}

module.exports = {
  logDecision,
  getAuditTrail,
  getDecisionContext,
  getDecisionStats,
};
