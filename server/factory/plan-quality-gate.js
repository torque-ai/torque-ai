'use strict';

const MAX_REPLAN_ATTEMPTS = 1;
const LLM_TIMEOUT_MS = 60_000;

const RULES = {
  plan_has_task_heading:       { severity: 'hard', scope: 'plan' },
  plan_task_count_upper_bound: { severity: 'hard', scope: 'plan', max: 15 },
  plan_task_count_lower_bound: { severity: 'warn', scope: 'plan', min: 2 },
  task_body_min_length:        { severity: 'hard', scope: 'task', min: 100 },
  task_has_file_reference:     { severity: 'hard', scope: 'task' },
  task_has_acceptance_criterion: { severity: 'hard', scope: 'task' },
  task_avoids_vague_phrases:   { severity: 'hard', scope: 'task', minHits: 2 },
  no_duplicate_task_titles:    { severity: 'hard', scope: 'plan' },
  task_heading_grammar:        { severity: 'hard', scope: 'plan' },
  plan_size_upper_bound:       { severity: 'hard', scope: 'plan', maxBytes: 100 * 1024 },
};

function runDeterministicRules(_planMarkdown) {
  return { hardFails: [], warnings: [] };
}

async function runLlmSemanticCheck(_opts) {
  return null;
}

function buildFeedbackPrompt(_hardFails, _warnings, _llmCritique) {
  return null;
}

async function evaluatePlan(_opts) {
  return { passed: true, hardFails: [], warnings: [], llmCritique: null, feedbackPrompt: null };
}

module.exports = {
  MAX_REPLAN_ATTEMPTS,
  LLM_TIMEOUT_MS,
  RULES,
  runDeterministicRules,
  runLlmSemanticCheck,
  buildFeedbackPrompt,
  evaluatePlan,
};
