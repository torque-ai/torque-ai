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
const decisionLog = require('../../decision-log');
const { normalizeDecisionStage, getDecisionActor } = require('../../decision-actors');
const { resolveContainerDbHandle } = require('../../../db/db-handle-resolver');

function resolveDecisionDb(decisionsStore, resolveDbHandle) {
  if (typeof decisionsStore.getDb === 'function') {
    const db = decisionsStore.getDb();
    if (db && typeof db.prepare === 'function') {
      return db;
    }
  }
  try {
    const db = resolveDbHandle();
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
function createDecisionStore(options = {}) {
  const decisionsStore = options.factoryDecisions || factoryDecisions;
  const decisionLogger = options.decisionLog || decisionLog;
  const resolveDbHandle = options.resolveContainerDbHandle || resolveContainerDbHandle;

  return {
    log(record) {
      const normalizedStage = normalizeDecisionStage(record?.stage);
      const actor = getDecisionActor(normalizedStage, record?.actor);
      if (!normalizedStage || !actor || !record?.action) {
        return null;
      }
      try {
        const db = resolveDecisionDb(decisionsStore, resolveDbHandle);
        if (!db) {
          // No DB available — match safeLogDecision's silent-skip semantics.
          return null;
        }
        if (typeof decisionsStore.setDb === 'function') {
          decisionsStore.setDb(db);
        }
        return decisionLogger.logDecision({
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
      if (typeof decisionsStore.getLatestDecisionForStage !== 'function') {
        return null;
      }
      try {
        return decisionsStore.getLatestDecisionForStage(projectId, stage);
      } catch {
        return null;
      }
    },

    listForBatch(batchId) {
      if (typeof decisionsStore.listDecisionsForBatch !== 'function') {
        return [];
      }
      try {
        return decisionsStore.listDecisionsForBatch(batchId) || [];
      } catch {
        return [];
      }
    },
  };
}

module.exports = { createDecisionStore };
