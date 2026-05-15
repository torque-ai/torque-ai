// Decision store. Thin facade over server/factory/decision-log.js
// (logDecision) + server/db/factory/decisions.js (read queries).
//
// Stages call `decisionStore.log(record)` instead of the legacy
// `safeLogDecision(record)` helper. The "safe" suffix is dropped because
// the store is unconditionally safe — it never throws into the stage,
// and the dispatcher tolerates missing decision rows. If a stage needs
// stricter delivery, it can throw from inside its handler.

const factoryDecisions = require('../../../db/factory/decisions');
const { logDecision } = require('../../decision-log');

/**
 * @returns {import('../types').DecisionStore}
 */
function createDecisionStore() {
  return {
    log(record) {
      try {
        logDecision(record);
      } catch (_err) {
        // Decision-log writes must never propagate into stage execution.
        // The legacy safeLogDecision helper swallowed the same way.
        void _err;
      }
    },

    getLatestForStage(projectId, stage) {
      if (typeof factoryDecisions.getLatestDecisionForStage !== 'function') {
        return null;
      }
      try {
        return factoryDecisions.getLatestDecisionForStage(projectId, stage);
      } catch {
        return null;
      }
    },

    listForBatch(batchId) {
      if (typeof factoryDecisions.listDecisionsForBatch !== 'function') {
        return [];
      }
      try {
        return factoryDecisions.listDecisionsForBatch(batchId) || [];
      } catch {
        return [];
      }
    },
  };
}

module.exports = { createDecisionStore };
