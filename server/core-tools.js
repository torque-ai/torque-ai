/**
 * Tool tier system — controls which tools are visible in each mode.
 *
 * Tier 1 (default core): Essential task lifecycle — what 90% of workflows need.
 * Tier 2 (extended):     Power user tools — batch orchestration, TS structural, SnapScope.
 * Tier 3 (full):         Everything — admin, provider config, webhooks, experiments.
 *
 * Modes:
 *   'core'     → Tier 1 only (~20 tools). Default on connect.
 *   'extended' → Tier 1 + 2 (~85 tools). Unlocked via unlock_tier(2).
 *   'full'     → All tools (~494). Unlocked via unlock_all_tools.
 *
 * Shared between index.js (stdio) and mcp-sse.js (SSE transport).
 */

const TIER_1 = [
  // Meta
  'ping', 'restart_server', 'unlock_all_tools', 'unlock_tier',
  // Task lifecycle (unified — submit_task now auto-routes by default)
  'submit_task', 'cancel_task', 'task_info', 'list_tasks',
  // Workflows
  'create_workflow', 'add_workflow_task', 'run_workflow',
  'await_workflow', 'await_task',
  'workflow_status', 'list_workflows',
  // Project config
  'scan_project', 'set_project_defaults', 'get_project_defaults',
  // Hashline editing (Harness Problem solution)
  'hashline_read', 'hashline_edit',
  // CI Watcher
  'await_ci_run', 'list_ci_runs', 'ci_run_status',
  'diagnose_ci_failure', 'watch_ci_repo', 'stop_ci_watch',
  'configure_ci_provider',
];

const TIER_2 = [
  // Host management (legacy aliases — manage_host is preferred for new code)
  'add_ollama_host', 'list_ollama_hosts',
  // Unified management tools (replaces individual host/tuning/webhook tools)
  'manage_host',
  'manage_tuning',
  'manage_webhook',
  // Legacy task aliases (backward compat — task_info is preferred)
  'smart_submit_task', 'check_status', 'get_result', 'get_progress',
  // Workflows (advanced)
  'create_feature_workflow', 'cancel_workflow',
  // Project config (advanced)
  'configure_stall_detection', 'auto_verify_and_fix', 'commit_task',
  // Batch orchestration
  'generate_feature_tasks', 'generate_test_tasks', 'run_batch',
  'detect_file_conflicts', 'auto_commit_batch', 'get_batch_summary',
  // Batch lifecycle
  'plan_next_batch', 'extract_feature_spec', 'update_project_stats',
  'cache_feature_gaps', 'run_full_batch',
  // Universal TypeScript structural tools
  'add_ts_interface_members', 'inject_class_dependency', 'add_ts_union_members',
  'inject_method_calls', 'add_ts_enum_members',
  // Semantic TypeScript tools (Harness Problem mitigation)
  'add_ts_method_to_class', 'replace_ts_method_body', 'add_import_statement',
  // Headwaters wiring wrappers
  'wire_system_to_gamescene', 'wire_events_to_eventsystem', 'wire_notifications_to_bridge',
  // Validation & maintenance
  'validate_event_consistency', 'normalize_interface_formatting', 'audit_class_completeness',
  // SnapScope & Peek
  'capture_screenshots', 'capture_view', 'capture_views', 'validate_manifest',
  'peek_ui', 'peek_interact', 'peek_launch', 'peek_discover', 'peek_open_url',
  'peek_cdp', 'peek_refresh', 'peek_health_all', 'peek_build_and_open',
  'peek_elements', 'peek_regression', 'peek_diagnose', 'peek_semantic_diff',
  'peek_wait', 'peek_action_sequence', 'peek_assert', 'peek_ocr',
  'peek_hit_test', 'peek_summary', 'peek_table', 'peek_snapshot', 'peek_color',
  'list_peek_hosts',
];

/**
 * Get tool names for a given tier level (cumulative).
 * @param {number} tier - 1, 2, or 3
 * @returns {string[]}
 */
function getToolNamesForTier(tier) {
  if (tier <= 1) return [...TIER_1];
  if (tier <= 2) return [...TIER_1, ...TIER_2];
  return [...TIER_1, ...TIER_2];
}

// Backward-compat: CORE_TOOL_NAMES is now Tier 1 (reduced from 78 to ~25)
const CORE_TOOL_NAMES = [...TIER_1];

// Extended set for 'extended' mode (Tier 1 + 2, same as old CORE_TOOL_NAMES)
const EXTENDED_TOOL_NAMES = [...TIER_1, ...TIER_2];

module.exports = {
  CORE_TOOL_NAMES,
  EXTENDED_TOOL_NAMES,
  TIER_1,
  TIER_2,
  getToolNamesForTier,
};
