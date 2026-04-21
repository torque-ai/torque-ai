'use strict';

module.exports = [
  {
    name: 'dotnet_sourcelink_file_lock',
    category: 'transient',
    priority: 200,
    confidence: 0.9,
    match: {
      stage: 'verify', action: 'worktree_verify_failed',
      outcome_path: 'output_preview',
      outcome_regex: 'being used by another process|sourcelink\\.json',
    },
    suggested_strategies: ['clean_and_retry', 'retry', 'reject_and_advance'],
  },
  {
    name: 'codex_phantom_success',
    category: 'sandbox_interrupt',
    priority: 150,
    confidence: 0.7,
    match: {
      action: 'cannot_generate_plan',
      outcome_regex: 'Reconnecting|high[- ]demand|workspace-write|\\bsandbox\\b',
    },
    suggested_strategies: ['retry_with_fresh_session', 'fallback_provider', 'escalate'],
  },
  {
    name: 'plan_generation_failed',
    category: 'plan_failure',
    priority: 100,
    confidence: 0.8,
    match: { action: 'cannot_generate_plan' },
    suggested_strategies: ['retry_plan_generation', 'fallback_provider', 'reject_and_advance'],
  },
  {
    name: 'never_started_paused_project',
    category: 'never_started',
    priority: 90,
    confidence: 0.9,
    match_fn: (d) => d && d.action === 'never_started',
    suggested_strategies: ['retry_plan_generation', 'escalate'],
  },
  {
    name: 'verify_fail_unclassified',
    category: 'unknown',
    priority: 10,
    confidence: 0.3,
    match: { stage: 'verify', action: 'worktree_verify_failed' },
    suggested_strategies: ['retry', 'escalate'],
  },
];
