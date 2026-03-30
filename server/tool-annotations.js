'use strict';

// ── Annotation shape ──
const READONLY    = Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false });
const DISPATCH    = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  });
const IDEMPOTENT  = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false });
const LIFECYCLE   = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const ASYNC_RO    = Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: false, openWorldHint: false });
// FALLBACK is structurally identical to LIFECYCLE but a distinct object.
// validateCoverage() uses identity comparison (=== FALLBACK) to detect uncovered tools.
// Do NOT merge these into a shared constant.
const FALLBACK    = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

// ── Prefix rules (checked first, first match wins) ──
const PREFIX_RULES = [
  { prefixes: [
    'list_', 'get_', 'check_', 'find_', 'search_', 'scan_', 'diff_', 'export_',
    'analyze_', 'validate_', 'detect_', 'compare_', 'predict_', 'estimate_', 'forecast_',
    'verify_', 'view_', 'explain_', 'inspect_', 'preview_', 'diagnose_', 'capture_',
    'lookup_', 'query_', 'suggest_', 'compute_', 'calculate_', 'calibrate_', 'tsserver_',
    'peek_',
  ], annotation: READONLY },
  { prefixes: [
    'delete_', 'rollback_', 'archive_', 'remove_', 'clear_', 'revoke_', 'cleanup_',
  ], annotation: DESTRUCTIVE },
  { prefixes: [
    'cancel_',
  ], annotation: DESTRUCTIVE },
  { prefixes: [
    'submit_', 'queue_', 'create_', 'run_', 'schedule_', 'fork_', 'clone_',
    'import_', 'bulk_import_', 'notify_', 'send_', 'test_', 'trigger_',
    'generate_', 'backup_', 'sync_',
  ], annotation: DISPATCH },
  { prefixes: [
    'set_', 'configure_', 'tag_', 'untag_', 'manage_', 'add_', 'inject_', 'wire_',
    'normalize_', 'update_', 'replace_', 'register_', 'unregister_', 'enable_',
    'disable_', 'activate_', 'toggle_', 'approve_', 'reject_', 'deny_', 'apply_',
    'learn_', 'save_', 'setup_', 'record_', 'resolve_',
  ], annotation: IDEMPOTENT },
  { prefixes: [
    'retry_', 'resume_', 'restore_', 'start_', 'pause_', 'skip_', 'stop_',
    'release_', 'claim_', 'steal_', 'recover_', 'refresh_',
  ], annotation: LIFECYCLE },
  { prefixes: [
    'await_', 'wait_', 'poll_', 'stream_',
  ], annotation: ASYNC_RO },
];

// ── Suffix rules (checked second, only if no prefix matched) ──
const SUFFIX_RULES = [
  { suffixes: [
    '_status', '_info', '_summary', '_history', '_timeline', '_graph', '_path',
    '_stats', '_report', '_dashboard', '_health', '_insights', '_changes', '_quotas',
  ], annotation: READONLY },
];

// ── Exact matches (checked after overrides, before prefix/suffix) ──
const EXACT_MATCHES = Object.freeze({
  ping:             READONLY,
  blocked_tasks:    READONLY,
  critical_path:    READONLY,
  what_if:          READONLY,
  dependency_graph: READONLY,
  batch_cancel:     DESTRUCTIVE,
});

// ── Explicit overrides (checked first — full 4-field objects) ──
const OVERRIDES = Object.freeze({
  restart_server:                  Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }),
  unlock_all_tools:                Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  unlock_tier:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  commit_task:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  auto_commit_batch:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  smart_submit_task:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  configure:                       Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  stash_changes:                   Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }),
  hashline_read:                   Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  hashline_edit:                   Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  auto_verify_and_fix:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  optimize_database:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_config_get:            Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_config_set:            Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_config_apply_template: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_config_templates:      Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_usage:                 Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_decompose:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  strategic_diagnose:              Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  strategic_review:                Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  strategic_benchmark:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  audit_codebase:                  Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  compare_providers:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  get_adversarial_reviews:        Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  request_adversarial_review:      Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  get_file_risk:                   READONLY,
  get_task_risk_summary:           READONLY,
  get_high_risk_files:             READONLY,
  get_verification_checks:         READONLY,
  get_verification_summary:        READONLY,
  set_file_risk_override:          Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  batch_retry:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  batch_tag:                       Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),

  // ── Coverage gap closure — tools with no matching convention rule ──
  // readOnly: queries, reads, analysis
  health_check:                    Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  current_project:                 Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  dry_run_bulk:                    Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  webhook_logs:                    Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  success_rates:                   Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  evaluate_policies:               Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  probe_workstation:               Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  get_context:                     Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  get_circuit_breaker_status:      Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  get_budget_status:               Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  get_provider_scores:             Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  get_governance_rules:            READONLY,
  set_governance_rule_mode:        IDEMPOTENT,
  toggle_governance_rule:          IDEMPOTENT,

  // destructive: deletes, removes, invalidates
  perform_auto_rollback:           Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }),
  invalidate_cache:                Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }),

  // dispatch/openWorld: creates resources, dispatches work
  use_template:                    Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  group_action:                    Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  duplicate_pipeline:              Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  instantiate_template:            Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  template_loop:                   Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  replay_task:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  quick_setup_notifications:       Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  full_project_audit:              Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),

  // idempotent: safe mutations, configurations, records
  share_context:                   Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  merge_workflows:                 Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  log_intelligence_outcome:        Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  store_artifact:                  Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  cache_task_result:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  warm_cache:                      Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  boost_priority:                  Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  agent_heartbeat:                 Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  rate_limit_tasks:                Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  override_policy_decision:        Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  bulk_approve_models:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),

  // lifecycle: state transitions, lock/lease management
  watch_ci_repo:                   Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  step_execution:                  Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  conclude_experiment:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  renew_lease:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  acquire_lock:                    Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),

  // ── Tools added by TORQUE competitive features workflow ──
  review_task_output:              Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  discover_agents:                 READONLY,
  discover_models:                 Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true  }),
  list_models:                     Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  assign_model_role:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  polish_task_description:         Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  search_symbols:                  Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  get_file_outline:                Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  index_project:                   Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
});

/**
 * Get MCP annotations for a tool by name.
 * Resolution order: explicit overrides → exact matches → prefix rules → suffix rules → fallback.
 * @param {string} name - Tool name
 * @returns {{ readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }}
 */
function getAnnotations(name) {
  if (typeof name !== 'string') return FALLBACK;

  // 1. Explicit overrides
  if (OVERRIDES[name]) return OVERRIDES[name];

  // 2. Exact matches
  if (EXACT_MATCHES[name]) return EXACT_MATCHES[name];

  // 3. Prefix rules (first match wins)
  for (const rule of PREFIX_RULES) {
    for (const prefix of rule.prefixes) {
      if (name.startsWith(prefix)) return rule.annotation;
    }
  }

  // 4. Suffix rules (first match wins)
  for (const rule of SUFFIX_RULES) {
    for (const suffix of rule.suffixes) {
      if (name.endsWith(suffix)) return rule.annotation;
    }
  }

  // 5. Fallback
  return FALLBACK;
}

/**
 * Validate annotation coverage for a list of tool names.
 * @param {string[]} toolNames - All registered tool names
 * @returns {{ uncovered: string[], stale: string[] }}
 *   uncovered: tools that hit the fallback (no convention, no override, no exact match)
 *   stale: override keys that don't appear in toolNames
 */
function validateCoverage(toolNames) {
  const nameSet = new Set(toolNames);

  const uncovered = [];
  for (const name of toolNames) {
    const ann = getAnnotations(name);
    if (ann === FALLBACK) {
      uncovered.push(name);
    }
  }

  const stale = [];
  for (const name of Object.keys(OVERRIDES)) {
    if (!nameSet.has(name)) {
      stale.push(name);
    }
  }

  return { uncovered, stale };
}

module.exports = {
  getAnnotations,
  validateCoverage,
  OVERRIDES,
  EXACT_MATCHES,
  PREFIX_RULES,
  SUFFIX_RULES,
  FALLBACK,
  READONLY, DESTRUCTIVE, DISPATCH, IDEMPOTENT, LIFECYCLE, ASYNC_RO,
};
