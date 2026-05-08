'use strict';

// Catalog of valid factory_decisions actions.
//
// Source of truth for action shape, classifier kind, and outcome key list.
// New emission sites must add a corresponding entry; the audit at
// server/tests/factory-decision-actions-catalog.test.js enforces this.
//
// Schema per entry:
//   stage: SENSE | PRIORITIZE | PLAN | EXECUTE | VERIFY | LEARN | IDLE | PAUSED | STARVED | ANY
//   classifier: 'benign' | 'recovery-rule' | 'b-side-reject' | 'terminal' | 'engine'
//   rule_id: required when classifier === 'recovery-rule'
//   outcome: array of documented outcome keys (informational only in v1)
//
// See docs/factory-loop-states.md for the loop's state machine and
// docs/recovery-decisions.md for the recovery subsystems consuming these.

const DECISION_ACTIONS = {
  // Populated in subsequent commits.
};

module.exports = { DECISION_ACTIONS };
