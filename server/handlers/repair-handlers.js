'use strict';

const { ErrorCodes, makeError } = require('./shared');
const logger = require('../logger').child({ component: 'repair-handlers' });

function unwrapDb(db) {
  return db && typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
}

/**
 * Resolve candidatePatches service from the DI container, or lazy-create
 * from the factory.  The module is not yet registered in the container,
 * so we fall back to direct construction.
 */
function resolveCandidatePatches() {
  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer?.has?.('candidatePatches')) {
      return defaultContainer.get('candidatePatches');
    }
    // Not registered yet — construct from factory with the container's db.
    const db = unwrapDb(defaultContainer.get('db'));
    const { createCandidatePatches } = require('../validation/candidate-patches');
    return createCandidatePatches({ db, logger });
  } catch (err) {
    logger.warn({ err: err.message }, 'candidatePatches dependency unavailable');
    return null;
  }
}

/**
 * Resolve faultLocalization service from the DI container.
 */
function resolveFaultLocalization() {
  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer?.has?.('faultLocalization')) {
      return defaultContainer.get('faultLocalization');
    }
    // Fallback — construct with whatever deps are available.
    const { createFaultLocalization } = require('../validation/fault-localization');
    return createFaultLocalization({ logger });
  } catch (err) {
    logger.warn({ err: err.message }, 'faultLocalization dependency unavailable');
    return null;
  }
}

function handleRecordRepairCandidate(args = {}) {
  const cp = resolveCandidatePatches();
  if (!cp) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'candidatePatches service unavailable');
  }

  try {
    const id = cp.recordCandidate({
      taskId: args.taskId,
      attempt: args.attempt,
      diffText: args.diffText,
      validatorScore: args.validatorScore,
      verifyExitCode: args.verifyExitCode,
      verifyOutput: args.verifyOutput,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, id }) }],
    };
  } catch (err) {
    logger.error({ err: err.message }, 'record_repair_candidate failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function handleListRepairCandidates(args = {}) {
  const cp = resolveCandidatePatches();
  if (!cp) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'candidatePatches service unavailable');
  }

  try {
    const candidates = cp.listCandidates(args.taskId);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, candidates }) }],
    };
  } catch (err) {
    logger.error({ err: err.message }, 'list_repair_candidates failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function handleSelectBestRepairCandidate(args = {}) {
  const cp = resolveCandidatePatches();
  if (!cp) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'candidatePatches service unavailable');
  }

  try {
    const selected = cp.selectBestCandidate(args.taskId);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, selected }) }],
    };
  } catch (err) {
    logger.error({ err: err.message }, 'select_best_repair_candidate failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function handleGetFaultLocalization(args = {}) {
  const fl = resolveFaultLocalization();
  if (!fl) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'faultLocalization service unavailable');
  }

  try {
    const ranked = fl.rankSuspiciousFiles({
      taskId: args.taskId,
      verifyOutput: args.verifyOutput,
      workingDirectory: args.workingDirectory,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, ranked }) }],
    };
  } catch (err) {
    logger.error({ err: err.message }, 'get_fault_localization failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

module.exports = {
  handleRecordRepairCandidate,
  handleListRepairCandidates,
  handleSelectBestRepairCandidate,
  handleGetFaultLocalization,
};
