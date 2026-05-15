// Decision store. Thin facade over server/factory/decision-log.js
// (logDecision) + server/db/factory/decisions.js (read queries).
//
// Stages call `decisionStore.log(record)` instead of the legacy
// `safeLogDecision(record)` helper. The "safe" suffix is dropped because
// the store is unconditionally safe — it never throws into the stage,
// and the dispatcher tolerates missing decision rows. If a stage needs
// stricter delivery, it can throw from inside its handler.
//
// `log()` mirrors the legacy safeLogDecision contract:
//   - stage is normalized (lowercased + membership-checked against
//     DECISION_STAGE_ACTORS); unknown stages → drop with no write.
//   - actor defaults to the stage→actor map when not explicitly set;
//     missing action or missing actor → drop.
//   - factoryDecisions.setDb(...) is called before write so the
//     db-handle plumbing stays consistent with safeLogDecision.

const factoryDecisions = require('../../../db/factory/decisions');
const { logDecision } = require('../../decision-log');
const { normalizeDecisionStage, getDecisionActor } = require('../../decision-actors');
const { resolveContainerDbHandle } = require('../../../db/db-handle-resolver');

function resolveDecisionDb() {
  if (typeof factoryDecisions.getDb === 'function') {
    const db = factoryDecisions.getDb();
    if (db && typeof db.prepare === 'function') {
      return db;
    }
  }
  try {
    const db = resolveContainerDbHandle();
    if (db && typeof db.prepare === 'function') {
      return db;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @returns {import('../types').DecisionStore}
 */
function createDecisionStore() {
  return {
    log(record) {
      const normalizedStage = normalizeDecisionStage(record?.stage);
      const actor = getDecisionActor(normalizedStage, record?.actor);
      if (!normalizedStage || !actor || !record?.action) {
        return null;
      }
      try {
        const db = resolveDecisionDb();
        if (!db) {
          // No DB available — match safeLogDecision's silent-skip semantics.
          return null;
        }
        if (typeof factoryDecisions.setDb === 'function') {
          factoryDecisions.setDb(db);
        }
        return logDecision({
          ...record,
          stage: normalizedStage,
          actor,
        });
      } catch (_err) {
        // Decision-log writes must never propagate into stage execution.
        // The legacy safeLogDecision helper swallowed the same way.
        void _err;
        return null;
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
