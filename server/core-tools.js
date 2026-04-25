/**
 * Tool tier system — controls which tools are visible in each mode.
 *
 * Tier 1 (default core): Essential task lifecycle — what 90% of workflows need.
 * Tier 2 (extended):     Power user tools — batch orchestration, TS structural, advanced config.
 * Tier 3 (full):         Everything — admin, provider config, webhooks, experiments.
 *
 * Modes:
 *   'core'     → Tier 1 only. Default on connect.
 *   'extended' → Tier 1 + 2. Unlocked via unlock_tier(2).
 *   'full'     → All tools. Unlocked via unlock_all_tools.
 *
 * Shared between index.js (stdio) and mcp-sse.js (SSE transport).
 */

const TIER_1 = [
  // Meta
  'ping', 'restart_server', 'restart_status', 'await_restart', 'unlock_all_tools', 'unlock_tier',
  // Task lifecycle (unified — submit_task now auto-routes by default)
  'submit_task', 'cancel_task', 'task_info', 'list_tasks',
  // Workflows
  'create_workflow', 'add_workflow_task', 'run_workflow',
  'await_workflow', 'await_task',
  'workflow_status', 'list_workflows',
  // Project config
  'scan_project', 'set_project_defaults', 'get_project_defaults',
  // Local LLM operations needed for autonomous factory tuning
  'list_ollama_hosts', 'list_ollama_models', 'manage_host', 'manage_tuning', 'run_benchmark',
  // CI Watcher
  'await_ci_run', 'list_ci_runs', 'ci_run_status',
  'diagnose_ci_failure', 'watch_ci_repo', 'stop_ci_watch',
  'configure_ci_provider',
  // Diffusion engine
  'submit_scout', 'create_diffusion_plan', 'diffusion_status',
  // Factory
  'factory_status', 'pause_project', 'resume_project', 'pause_all_projects', 'project_health', 'trigger_architect', 'architect_backlog',
  // Schedule management
  'list_scheduled', 'pause_scheduled', 'cancel_scheduled', 'schedule_task', 'schedule_workflow_spec',
  // Context (compact session resume)
  'get_context',
];

const TIER_2 = [
  // Host management (legacy aliases — manage_host is preferred for new code)
  'add_ollama_host',
  // Unified management tools (replaces individual host/tuning/webhook tools)
  'manage_webhook',
  // Legacy task aliases (backward compat — task_info is preferred)
  'smart_submit_task', 'check_status', 'get_result', 'get_progress',
  // Workflows (advanced)
  'create_feature_workflow', 'cancel_workflow',
  // Typed NL dispatch
  'register_action_schema', 'list_actions', 'dispatch_nl',
  'action_app_run', 'action_app_fork', 'action_app_history',
  'dispatch_subagent', 'resume_session', 'fork_session', 'list_sessions',
  'save_memory', 'search_memory', 'optimize_prompt', 'reflect_on_run',
  'register_specialist', 'route_turn', 'get_session_history',
  'create_eval_task', 'run_eval_task', 'set_approval_policy',
  // Project config (advanced)
  'configure_stall_detection', 'auto_verify_and_fix', 'commit_task',
  // Batch orchestration
  'generate_feature_tasks', 'generate_test_tasks', 'run_batch',
  'detect_file_conflicts', 'auto_commit_batch', 'get_batch_summary',
  // Universal TypeScript structural tools
  'add_ts_interface_members', 'inject_class_dependency', 'add_ts_union_members',
  'inject_method_calls', 'add_ts_enum_members',
  // Semantic TypeScript tools (Harness Problem mitigation)
  'add_ts_method_to_class', 'replace_ts_method_body', 'add_import_statement',
  // Validation & maintenance
  'normalize_interface_formatting',
  // Factory (extended)
  'register_factory_project', 'list_factory_projects', 'scan_project_health', 'set_factory_trust_level', 'get_project_policy', 'set_project_policy',
  // Factory intake
  'create_work_item', 'list_work_items', 'update_work_item', 'reject_work_item', 'intake_from_findings', 'scan_plans_directory', 'execute_plan_file', 'get_plan_execution_status', 'list_plan_intake_items', 'poll_github_issues', 'architect_log',
  // Factory loop
  'reset_factory_loop', 'start_factory_loop', 'await_factory_loop', 'advance_factory_loop', 'approve_factory_gate', 'retry_factory_verify', 'resume_project_baseline_fixed', 'factory_loop_status',
  'list_recovery_strategies', 'get_recovery_history', 'clear_auto_recovery', 'trigger_auto_recovery',
  'list_factory_loop_instances', 'factory_loop_instance_status', 'start_factory_loop_instance', 'advance_factory_loop_instance',
  'approve_factory_gate_instance', 'reject_factory_gate_instance', 'retry_factory_verify_instance', 'terminate_factory_loop_instance',
  'attach_factory_batch',
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
