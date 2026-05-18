// Plan-generation timeout policy + wait-field housekeeping. Pure helpers
// over the project config and the work-item's persisted origin object.
//
// Side-effect-heavy `buildPlanGeneration*Result` orchestrators (deferred /
// provider-fallback / retry / project-busy) intentionally stay in
// loop-controller.js for now — they fan out to the DB, logger, and
// decision recorder. They will move during a later lifecycle-extraction
// phase that explicitly allows side effects.
//
// Extracted from server/factory/loop-controller.js as Phase 1d of the
// god-object refactor. Behavior preserved; no signature changes.

const { getEffectiveProjectProvider } = require('../shared/project-config');

const DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES = 30;
const PLAN_GENERATION_HARD_CAP_EXTENSION_MINUTES = 15;
const DEFAULT_STALE_PENDING_PLAN_GENERATION_MS = DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES * 60 * 1000;

// Phase G: small local models (qwen3-coder:30b) consistently exceed the
// 30min default architect timeout on harder work items because the prompt
// is heavy (codegraph guidance + 5-signal specificity rules + scope files
// + project context). Cap their plan-generation budget so the auto-recovery
// loop kicks in faster — burning 30min on a stalled architect cycle is
// strictly worse than failing fast and letting the cap-based reject move
// the queue forward.
const OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES = 10;

function resolvePlanGenerationTimeoutMinutes(project) {
  let configured = null;
  try {
    const cfg = project?.config_json ? JSON.parse(project.config_json) : {};
    configured = cfg.plan_generation_timeout_minutes
      ?? cfg.factory_plan_generation_timeout_minutes
      ?? null;
  } catch (_cfgErr) {
    void _cfgErr;
  }
  const numeric = Number(configured);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(Math.max(Math.ceil(numeric), 1), 120);
  }
  // Provider-aware default: small local models get a tighter cap.
  if (getEffectiveProjectProvider(project) === 'ollama') {
    return OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES;
  }
  return DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES;
}

function buildPlanGenerationActivityTimeoutPolicy(timeoutMinutes) {
  const numeric = Number(timeoutMinutes);
  const boundedTimeoutMinutes = Number.isFinite(numeric) && numeric > 0
    ? Math.min(Math.max(Math.ceil(numeric), 1), 120)
    : DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES;
  const minimumHardCapMinutes = boundedTimeoutMinutes + PLAN_GENERATION_HARD_CAP_EXTENSION_MINUTES;
  const doubledActivityBudgetMinutes = boundedTimeoutMinutes * 2;
  return {
    kind: 'plan_generation',
    timeout_minutes: boundedTimeoutMinutes,
    max_wall_clock_minutes: Math.min(
      Math.max(doubledActivityBudgetMinutes, minimumHardCapMinutes),
      120
    ),
    overrun_intake_problem: 'timeout_overrun_active',
  };
}

function clearPlanGenerationWaitFields(origin = {}) {
  const next = { ...(origin && typeof origin === 'object' ? origin : {}) };
  delete next.plan_generation_task_id;
  delete next.plan_generation_status;
  delete next.plan_generation_wait_reason;
  delete next.plan_generation_retry_after;
  delete next.plan_generation_retry_count;
  delete next.plan_generation_last_error;
  delete next.plan_generation_updated_at;
  delete next.plan_generation_provider_fallback_count;
  delete next.plan_generation_provider_fallback_from;
  delete next.plan_generation_provider_fallback_to;
  delete next.plan_generation_provider_fallback_error;
  delete next.plan_generation_provider_unavailable_at;
  delete next.plan_generation_provider_unavailable_error;
  return next;
}

module.exports = {
  DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES,
  PLAN_GENERATION_HARD_CAP_EXTENSION_MINUTES,
  DEFAULT_STALE_PENDING_PLAN_GENERATION_MS,
  OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES,
  resolvePlanGenerationTimeoutMinutes,
  buildPlanGenerationActivityTimeoutPolicy,
  clearPlanGenerationWaitFields,
};
