// Decision-stage actor map + normalization helpers.
//
// Each factory_decisions row has an `actor` field naming the abstract
// "agent" responsible for the decision (the health model, the architect,
// etc.). Stages don't usually pass `actor` explicitly — it's derived from
// `stage` via this map.
//
// Extracted from loop-controller.js as part of Phase 2c so the stages/
// decisionStore facade can apply the same normalization + actor defaulting
// that loop-controller's legacy `safeLogDecision` does. Without this, the
// scaffold's `decisionStore.log` would silently drop rows whose stage
// failed the normalization check (e.g. uppercase 'SENSE' vs lowercase
// 'sense') or skip the actor-default lookup.
//
// `safeLogDecision` itself still lives in loop-controller and continues to
// route through these helpers. Once Phase 3 finishes lifting stage bodies,
// `safeLogDecision` becomes a thin back-compat alias for
// `decisionStore.log` and can drop.

const DECISION_STAGE_ACTORS = Object.freeze({
  sense: 'health_model',
  prioritize: 'architect',
  plan: 'planner',
  plan_review: 'reviewer',
  execute: 'executor',
  verify: 'verifier',
  learn: 'verifier',
});

/**
 * Lowercase + membership-check a stage name. Returns null when the input
 * is not a recognized decision stage; that null signal is what
 * `safeLogDecision` uses to skip writing decisions for unknown stages.
 *
 * @param {string|null|undefined} stage
 * @returns {string|null}
 */
function normalizeDecisionStage(stage) {
  if (!stage || typeof stage !== 'string') {
    return null;
  }
  const normalized = stage.toLowerCase();
  return DECISION_STAGE_ACTORS[normalized] ? normalized : null;
}

/**
 * Resolve the actor for a decision record. Prefers an explicit `actor`
 * arg; falls back to the stage→actor map. Returns null when neither is
 * resolvable.
 *
 * @param {string|null|undefined} stage
 * @param {string|null|undefined} actor
 * @returns {string|null}
 */
function getDecisionActor(stage, actor) {
  if (actor) {
    return actor;
  }
  const normalizedStage = normalizeDecisionStage(stage);
  return normalizedStage ? DECISION_STAGE_ACTORS[normalizedStage] : null;
}

module.exports = {
  DECISION_STAGE_ACTORS,
  normalizeDecisionStage,
  getDecisionActor,
};
