# REST API Gap Analysis

Generated on 2026-04-06 for the TORQUE server in `server/`.

## Summary

- MCP tool catalog: **600** unique tools.
- REST surface on port `3457`: **626** mounted endpoints.
- Coverage result: **500 COVERED**, **7 PARTIAL**, **93 GAP**.
- Direct REST tool passthrough exists for **456** tools; another **44** tools are only reachable through handler-based REST routes.
- Structural note: the 3457 API server is not implemented with Express route calls in `server/index.js`; `server/index.js` starts `server/api-server.core.js`, which mounts declarative route tables from `server/api/routes.js`, `server/api/v2-router.js`, and `server/api/health.js`.
- Structural note: `server/index.js` does not declare extra MCP tool names. It merges built-in `server/tools.js` tools with plugin `mcpTools()` results, and it skips plugin tools that shadow built-ins.

## Source Inventory

- Built-in MCP tool defs from `server/tool-defs/*.js`: **537** tools.
- SnapScope plugin tools from `server/plugins/snapscope/tool-defs.js` and `server/plugins/snapscope/new-tool-defs.js`: **45** tools.
- Version-control plugin tools from `server/plugins/version-control/tool-defs.js`: **13** tools.
- Remote-agent plugin tools from `server/plugins/remote-agents/tool-defs.js`: **7** tools.
- REST route defs in `server/api/routes.js`: **635** route records, including the auto-generated `server/api/routes-passthrough.js` spread.
- Additional provider discovery routes from `server/api/v2-router.js`: **5**.
- Additional health probes from `server/api/health.js`: **3**.
- The exclusion filter in `server/api-server.core.js` removes 12 string `/api/auth*` routes from the 3457 mount, but **3 regex auth routes still survive the filter** and appear in the mounted inventory: `DELETE /api/auth/keys/:key_id`, `PATCH /api/auth/users/:user_id`, `DELETE /api/auth/users/:user_id`.

## Priority Matrix

| Priority | MCP tool | Status | REST endpoint(s) | Notes |
| --- | --- | --- | --- | --- |
| P0 | `submit_task` | COVERED | `POST /api/tasks/submit` | Direct tool route exists. |
| P0 | `smart_submit_task` | COVERED | `POST /api/tasks` | Direct tool route exists. |
| P0 | `cancel_task` | COVERED | `DELETE /api/tasks/:task_id` | Direct tool route exists. |
| P0 | `task_info` | COVERED | `POST /api/v2/tasks/task-info` | Direct tool route exists. |
| P0 | `get_result` | COVERED | `GET /api/tasks/:task_id` | Direct tool route exists. |
| P0 | `await_task` | COVERED | `POST /api/tasks/await` | Direct tool route exists. |
| P0 | `await_workflow` | COVERED | `POST /api/workflows/await` | Direct tool route exists. |
| P0 | `create_workflow` | COVERED | `POST /api/workflows` | Direct tool route exists. |
| P0 | `add_workflow_task` | COVERED | `POST /api/workflows/:workflow_id/tasks` | Direct tool route exists. |
| P0 | `run_workflow` | COVERED | `POST /api/workflows/:workflow_id/run` | Direct tool route exists. |
| P0 | `workflow_status` | COVERED | `GET /api/workflows/:workflow_id` | Direct tool route exists. |
| P0 | `list_tasks` | COVERED | `GET /api/tasks` | Direct tool route exists. |
| P1 | `set_project_defaults` | COVERED | `POST /api/project/defaults` | Direct tool route exists. |
| P1 | `get_project_defaults` | COVERED | `GET /api/project/defaults` | Direct tool route exists. |
| P1 | `scan_project` | COVERED | `POST /api/scan` | Direct tool route exists. |
| P1 | `auto_verify_and_fix` | COVERED | `POST /api/verify` | Direct tool route exists. |
| P1 | `detect_file_conflicts` | COVERED | `POST /api/batch/conflicts` | Direct tool route exists. |
| P2 | `discover_models` | GAP | None | No mounted REST route found. |
| P2 | `list_models` | COVERED | `GET /api/v2/models` | Covered by a handler-based REST route. |
| P2 | `assign_model_role` | GAP | None | No mounted REST route found. |
| P2 | `configure_provider` | COVERED | `POST /api/providers/configure` | Direct tool route exists. |
| P2 | `list_ollama_hosts` | COVERED | `GET /api/ollama/hosts` | Direct tool route exists. |
| P3 | `register_remote_agent` | PARTIAL | `POST /api/v2/agents` | REST create-agent requires an explicit `id`; MCP derives the id from `name` and updates by derived id. |
| P3 | `list_remote_agents` | COVERED | `GET /api/v2/agents` | Covered by a handler-based REST route. |
| P3 | `get_remote_agent` | COVERED | `GET /api/v2/agents/:agent_id` | Covered by a handler-based REST route. |
| P3 | `remove_remote_agent` | COVERED | `DELETE /api/v2/agents/:agent_id` | Covered by a handler-based REST route. |
| P3 | `check_remote_agent_health` | PARTIAL | `GET /api/v2/agents/:agent_id/health` | REST only exposes per-agent health; MCP also supports checking all enabled agents with no id. |
| P3 | `run_remote_command` | COVERED | `POST /api/v2/automation/run-remote-command` | Direct tool route exists. |
| P3 | `run_tests` | COVERED | `POST /api/v2/automation/run-tests` | Direct tool route exists. |
| P3 | `register_peek_host` | COVERED | `POST /api/v2/peek/register-peek-host` | Direct tool route exists. |
| P3 | `unregister_peek_host` | COVERED | `DELETE /api/v2/peek/unregister-peek-host` | Direct tool route exists. |
| P3 | `list_peek_hosts` | COVERED | `GET /api/v2/peek-hosts` | Covered by a handler-based REST route. |
| P4 | `ping` | COVERED | `POST /api/v2/system/ping` | Direct tool route exists. |
| P4 | `restart_server` | COVERED | `POST /api/v2/system/restart-server` | Direct tool route exists. |
| P4 | `get_tool_schema` | GAP | None | No mounted REST route found. |
| P4 | `unlock_tier` | COVERED | `POST /api/v2/system/unlock-tier` | Direct tool route exists. |
| P4 | `unlock_all_tools` | COVERED | `POST /api/v2/system/unlock-all-tools` | Direct tool route exists. |
| P4 | `await_restart` | GAP | None | No mounted REST route found. |

## Full Gap List

### P0 Core task/workflow

- No P0 gaps. All requested P0 tools have REST coverage.

### P1 Automation

- No P1 gaps. All requested P1 tools have REST coverage.

### P2 Discovery/providers

- GAP: `discover_models`, `assign_model_role`.
  These tools have no REST endpoint that triggers provider model discovery or assigns provider model roles.
- Related P2 gaps in the same area: `configure_model_roles`, `list_model_roles`.

### P3 Plugins

- PARTIAL: `register_remote_agent`, `check_remote_agent_health`.
  `register_remote_agent` is only partially represented because `POST /api/v2/agents` requires an explicit id instead of deriving one from `name`. `check_remote_agent_health` is only partially represented because REST exposes per-agent health but not the MCP "check all enabled agents" behavior.
- GAP: SnapScope runtime tools (38): `peek_action_sequence`, `peek_assert`, `peek_baselines`, `peek_build_and_open`, `peek_cdp`, `peek_color`, `peek_diagnose`, `peek_discover`, `peek_elements`, `peek_health_all`, `peek_history`, `peek_hit_test`, `peek_interact`, `peek_launch`, `peek_ocr`, `peek_onboard`, `peek_onboard_detect`, `peek_open_url`, `peek_pre_analyze`, `peek_recovery`, `peek_recovery_execute`, `peek_recovery_log`, `peek_recovery_status`, `peek_refresh`, `peek_regression`, `peek_semantic_diff`, `peek_snapshot`, `peek_summary`, `peek_table`, `peek_ui`, `peek_verify`, `peek_verify_run`, `peek_verify_specs`, `peek_wait`, `peek_watch_add`, `peek_watch_control`, `peek_watch_remove`, `peek_watch_status`.
  Only SnapScope capture/manifest routes and peek-host management are reachable via REST today; the interactive `peek_*` surface is not.
- GAP: version-control tools (13): `vc_cleanup_stale`, `vc_commit_status`, `vc_create_pr`, `vc_create_release`, `vc_create_worktree`, `vc_generate_changelog`, `vc_generate_commit`, `vc_get_policy`, `vc_list_worktrees`, `vc_merge_worktree`, `vc_prepare_pr`, `vc_switch_worktree`, `vc_update_changelog_file`.
  No REST routes are mounted for the version-control plugin.

### P4 Utility

- GAP: `await_restart`, `get_tool_schema`.
  `get_tool_schema` has no REST equivalent; `/api/openapi.json` documents REST routes, not MCP tool schemas.

### Additional partials outside P0-P4

- PARTIAL: `check_workstation_health`, `get_routing_template`, `set_routing_template`, `delete_routing_template`, `strategic_config_apply_template`.
  These all have adjacent REST routes, but the REST contract is narrower than the MCP tool contract.

### Additional gaps outside P0-P4

- Discovery, indexing, and templates: `detect_project_type`, `discover_agents`, `get_project_template`, `list_project_templates`, `search_symbols`, `get_file_outline`, `get_symbol_source`, `index_project`.
- Diffusion, context, and broad analysis: `compare_providers`, `create_diffusion_plan`, `diffusion_status`, `full_project_audit`, `get_context`, `submit_scout`.
- Governance and risk: `get_circuit_breaker_status`, `get_governance_rules`, `set_governance_rule_mode`, `toggle_governance_rule`, `get_file_risk`, `set_file_risk_override`, `get_high_risk_files`, `get_task_risk_summary`, `get_verification_checks`, `get_verification_summary`, `get_adversarial_reviews`, `request_adversarial_review`, `get_provider_scores`.
- Workflow/import/export/review utilities: `export_workflow`, `import_workflow`, `polish_task_description`, `review_task_output`, `test_inbound_webhook`.
- Advanced agent and hashline tools: `get_agent`, `list_agents`, `hashline_read`, `hashline_edit`.

## Notes on the Biggest Gaps

- The largest missing surface area is the SnapScope `peek_*` family. That is the main blocker if the goal is “every MCP tool callable via REST.”
- The second-largest plugin gap is the entire version-control plugin. None of the 13 `vc_*` tools have mounted REST routes.
- The most important non-plugin product gaps are model discovery/role assignment (`discover_models`, `assign_model_role`, `configure_model_roles`, `list_model_roles`), diffusion orchestration (`submit_scout`, `create_diffusion_plan`, `diffusion_status`), and indexing/introspection (`search_symbols`, `get_file_outline`, `get_symbol_source`, `index_project`, `get_tool_schema`).

## Mounted REST Route Inventory

The list below reflects the actual 3457 mount surface after `server/api-server.core.js` filtering and `server/api/v2-router.js` + `server/api/health.js` expansion.

    DELETE /api/auth/keys/:key_id
    DELETE /api/auth/users/:user_id
    DELETE /api/ollama/hosts/:host_id
    DELETE /api/tasks
    DELETE /api/tasks/:task_id
    DELETE /api/v2/advanced/clear-breakpoint/:breakpoint_id
    DELETE /api/v2/advanced/clear-cache
    DELETE /api/v2/advanced/delete-agent-routing-rule
    DELETE /api/v2/advanced/delete-artifact/:artifact_id
    DELETE /api/v2/advanced/delete-failure-pattern/:pattern_id
    DELETE /api/v2/advanced/invalidate-cache
    DELETE /api/v2/advanced/release-lock/:agent_id
    DELETE /api/v2/advanced/release-task/:claim_id
    DELETE /api/v2/advanced/remove-from-group
    DELETE /api/v2/advanced/unregister-agent/:agent_id
    DELETE /api/v2/agents/:agent_id
    DELETE /api/v2/automation/delete-task-template
    DELETE /api/v2/hosts/:host_id
    DELETE /api/v2/hosts/:host_name/credentials/:credential_type
    DELETE /api/v2/integration/delete-routing-rule
    DELETE /api/v2/peek-hosts/:host_name
    DELETE /api/v2/peek/unregister-peek-host
    DELETE /api/v2/plan-projects/:project_id
    DELETE /api/v2/providers/:provider_name/api-key
    DELETE /api/v2/routing/templates/:template_id
    DELETE /api/v2/schedules/:schedule_id
    DELETE /api/v2/tasks/:task_id
    DELETE /api/v2/tasks/delete-budget/:budget_id
    DELETE /api/v2/tuning/:project_path
    DELETE /api/v2/validation/release-file-locks/:task_id
    DELETE /api/v2/validation/remove-hook
    DELETE /api/v2/webhooks/:webhook_id
    DELETE /api/v2/webhooks/delete-inbound-webhook
    DELETE /api/v2/webhooks/remove-budget-alert
    DELETE /api/v2/workflows/delete-workflow-template/:template_id
    DELETE /api/v2/workstations/:workstation_name
    GET /api/bootstrap/workstation
    GET /api/health
    GET /api/hooks/claude-files
    GET /api/metrics
    GET /api/ollama/hosts
    GET /api/openapi.json
    GET /api/project/defaults
    GET /api/provider-quotas
    GET /api/providers
    GET /api/quota/auto-scale
    GET /api/quota/history
    GET /api/quota/status
    GET /api/status
    GET /api/tasks
    GET /api/tasks/:task_id
    GET /api/tasks/:task_id/changes
    GET /api/tasks/:task_id/progress
    GET /api/v2/advanced/coordination-dashboard
    GET /api/v2/advanced/debug-status/:task_id
    GET /api/v2/advanced/experiment-status/:experiment_id
    GET /api/v2/advanced/get-artifact
    GET /api/v2/advanced/get-audit-log
    GET /api/v2/advanced/get-claim
    GET /api/v2/advanced/get-priority-queue
    GET /api/v2/advanced/get-resource-usage/:task_id
    GET /api/v2/advanced/get-retry-recommendation/:task_id
    GET /api/v2/advanced/get-stealing-history
    GET /api/v2/advanced/list-agent-routing-rules
    GET /api/v2/advanced/list-approval-rules
    GET /api/v2/advanced/list-artifacts/:task_id
    GET /api/v2/advanced/list-breakpoints/:task_id
    GET /api/v2/advanced/list-claims/:agent_id
    GET /api/v2/advanced/list-failure-patterns
    GET /api/v2/advanced/list-pending-approvals/:task_id
    GET /api/v2/advanced/list-routing-rules
    GET /api/v2/advanced/query-plan
    GET /api/v2/agents
    GET /api/v2/agents/:agent_id
    GET /api/v2/agents/:agent_id/health
    GET /api/v2/analytics/throughput
    GET /api/v2/approvals
    GET /api/v2/approvals/check-approval-gate/:task_id
    GET /api/v2/audit/runs
    GET /api/v2/audit/runs/:audit_run_id/findings
    GET /api/v2/audit/runs/:audit_run_id/summary
    GET /api/v2/automation/get-task-events/:task_id
    GET /api/v2/automation/list-task-templates
    GET /api/v2/baselines/get-auto-rollback-history/:task_id
    GET /api/v2/baselines/list-backups/:task_id
    GET /api/v2/baselines/list-rollbacks
    GET /api/v2/benchmarks
    GET /api/v2/budget/status
    GET /api/v2/budget/summary
    GET /api/v2/ci/runs
    GET /api/v2/ci/runs/:run_id
    GET /api/v2/concurrency
    GET /api/v2/config
    GET /api/v2/config/:key
    GET /api/v2/coordination
    GET /api/v2/hosts
    GET /api/v2/hosts/:host_id
    GET /api/v2/hosts/:host_name/credentials
    GET /api/v2/hosts/activity
    GET /api/v2/integration/get-email-notification
    GET /api/v2/integration/get-file-chunks
    GET /api/v2/integration/get-review-workflow-config
    GET /api/v2/integration/list-database-backups
    GET /api/v2/integration/list-email-notifications/:task_id
    GET /api/v2/integration/list-integrations
    GET /api/v2/integration/list-report-exports
    GET /api/v2/integration/list-rollback-points/:task_id
    GET /api/v2/integration/success-rates
    GET /api/v2/intelligence/cache-stats
    GET /api/v2/intelligence/database-stats
    GET /api/v2/intelligence/intelligence-dashboard
    GET /api/v2/metrics/prometheus
    GET /api/v2/models
    GET /api/v2/models/pending
    GET /api/v2/notifications
    GET /api/v2/peek-hosts
    GET /api/v2/peek/attestations/:id
    GET /api/v2/plan-projects
    GET /api/v2/plan-projects/:project_id
    GET /api/v2/policies
    GET /api/v2/policies/:policy_id
    GET /api/v2/policy-evaluations
    GET /api/v2/policy-evaluations/:evaluation_id
    GET /api/v2/projects/defaults
    GET /api/v2/providers
    GET /api/v2/providers
    GET /api/v2/providers/:provider_id
    GET /api/v2/providers/:provider_id/capabilities
    GET /api/v2/providers/:provider_id/health
    GET /api/v2/providers/:provider_id/models
    GET /api/v2/providers/:provider_id/percentiles
    GET /api/v2/providers/:provider_id/stats
    GET /api/v2/providers/get-auto-tuning
    GET /api/v2/providers/get-discovery-status
    GET /api/v2/providers/get-format-success-rates
    GET /api/v2/providers/get-hardware-tuning
    GET /api/v2/providers/get-host-capacity
    GET /api/v2/providers/get-host-settings/:host_id
    GET /api/v2/providers/get-instruction-templates
    GET /api/v2/providers/get-llm-tuning
    GET /api/v2/providers/get-memory-protection-status
    GET /api/v2/providers/get-model-leaderboard
    GET /api/v2/providers/get-model-prompts
    GET /api/v2/providers/get-model-settings
    GET /api/v2/providers/get-provider-health-trends
    GET /api/v2/providers/list-llm-presets
    GET /api/v2/providers/list-ollama-models
    GET /api/v2/providers/start-dashboard
    GET /api/v2/providers/stop-dashboard
    GET /api/v2/providers/trends
    GET /api/v2/quota/auto-scale
    GET /api/v2/quota/history
    GET /api/v2/quota/status
    GET /api/v2/routing/active
    GET /api/v2/routing/categories
    GET /api/v2/routing/categories
    GET /api/v2/routing/templates
    GET /api/v2/routing/templates/:template_id
    GET /api/v2/schedules
    GET /api/v2/schedules/:schedule_id
    GET /api/v2/stats/events
    GET /api/v2/stats/format-success
    GET /api/v2/stats/models
    GET /api/v2/stats/notifications
    GET /api/v2/stats/overview
    GET /api/v2/stats/quality
    GET /api/v2/stats/stuck
    GET /api/v2/stats/timeseries
    GET /api/v2/stats/webhooks
    GET /api/v2/strategic/config
    GET /api/v2/strategic/decisions
    GET /api/v2/strategic/operations
    GET /api/v2/strategic/provider-health
    GET /api/v2/strategic/status
    GET /api/v2/strategic/templates
    GET /api/v2/strategic/templates/:template_name
    GET /api/v2/system/status
    GET /api/v2/tasks
    GET /api/v2/tasks/:task_id
    GET /api/v2/tasks/:task_id/diff
    GET /api/v2/tasks/:task_id/events
    GET /api/v2/tasks/:task_id/logs
    GET /api/v2/tasks/:task_id/progress
    GET /api/v2/tasks/bulk-operation-status
    GET /api/v2/tasks/check-stalled-tasks
    GET /api/v2/tasks/check-task-progress
    GET /api/v2/tasks/cost-summary
    GET /api/v2/tasks/current-project
    GET /api/v2/tasks/duration-insights
    GET /api/v2/tasks/get-analytics
    GET /api/v2/tasks/get-archive-stats
    GET /api/v2/tasks/get-complexity-routing
    GET /api/v2/tasks/get-pipeline-status/:pipeline_id
    GET /api/v2/tasks/get-project-config
    GET /api/v2/tasks/get-task-logs/:task_id
    GET /api/v2/tasks/get-task-usage/:task_id
    GET /api/v2/tasks/health-check
    GET /api/v2/tasks/health-status
    GET /api/v2/tasks/list-archived
    GET /api/v2/tasks/list-bulk-operations
    GET /api/v2/tasks/list-comments/:task_id
    GET /api/v2/tasks/list-commits
    GET /api/v2/tasks/list-groups
    GET /api/v2/tasks/list-paused-tasks
    GET /api/v2/tasks/list-pending-reviews
    GET /api/v2/tasks/list-pipelines
    GET /api/v2/tasks/list-project-configs
    GET /api/v2/tasks/list-projects
    GET /api/v2/tasks/list-scheduled
    GET /api/v2/tasks/list-tags
    GET /api/v2/tasks/list-tasks-needing-correction
    GET /api/v2/tasks/list-templates
    GET /api/v2/tasks/output-stats
    GET /api/v2/tasks/project-stats
    GET /api/v2/tasks/set-task-review-status/:task_id
    GET /api/v2/tsserver/tsserver-status
    GET /api/v2/tuning
    GET /api/v2/validation/check-accessibility/:task_id
    GET /api/v2/validation/check-doc-coverage/:task_id
    GET /api/v2/validation/check-duplicate-files/:task_id
    GET /api/v2/validation/check-file-locations/:task_id
    GET /api/v2/validation/check-i18n/:task_id
    GET /api/v2/validation/check-test-coverage/:task_id
    GET /api/v2/validation/check-xaml-consistency/:task_id
    GET /api/v2/validation/get-audit-summary
    GET /api/v2/validation/get-audit-trail
    GET /api/v2/validation/get-best-provider
    GET /api/v2/validation/get-budget-status/:budget_id
    GET /api/v2/validation/get-build-error-analysis/:task_id
    GET /api/v2/validation/get-build-result/:task_id
    GET /api/v2/validation/get-complexity-metrics/:task_id
    GET /api/v2/validation/get-cost-forecast
    GET /api/v2/validation/get-cost-summary
    GET /api/v2/validation/get-dead-code-results/:task_id
    GET /api/v2/validation/get-doc-coverage-results/:task_id
    GET /api/v2/validation/get-failure-matches
    GET /api/v2/validation/get-file-location-issues/:task_id
    GET /api/v2/validation/get-file-locks/:task_id
    GET /api/v2/validation/get-provider-quality
    GET /api/v2/validation/get-provider-stats
    GET /api/v2/validation/get-quality-score/:task_id
    GET /api/v2/validation/get-rate-limits
    GET /api/v2/validation/get-safeguard-tools
    GET /api/v2/validation/get-security-results/:task_id
    GET /api/v2/validation/get-similar-file-results/:task_id
    GET /api/v2/validation/get-smoke-test-results/:task_id
    GET /api/v2/validation/get-task-complexity-score/:task_id
    GET /api/v2/validation/get-timeout-alerts/:task_id
    GET /api/v2/validation/get-type-verification-results/:task_id
    GET /api/v2/validation/get-validation-results/:task_id
    GET /api/v2/validation/get-vulnerability-results/:task_id
    GET /api/v2/validation/get-xaml-consistency-results/:task_id
    GET /api/v2/validation/get-xaml-validation-results/:task_id
    GET /api/v2/validation/list-hooks
    GET /api/v2/validation/list-retry-rules
    GET /api/v2/validation/list-security-rules
    GET /api/v2/validation/list-syntax-validators
    GET /api/v2/validation/list-validation-rules
    GET /api/v2/webhooks
    GET /api/v2/webhooks/get-retry-history/:task_id
    GET /api/v2/webhooks/list-budget-alerts
    GET /api/v2/webhooks/list-inbound-webhooks
    GET /api/v2/workflows
    GET /api/v2/workflows/:workflow_id
    GET /api/v2/workflows/:workflow_id/history
    GET /api/v2/workflows/:workflow_id/tasks
    GET /api/v2/workflows/blocked-tasks/:workflow_id
    GET /api/v2/workflows/critical-path/:workflow_id
    GET /api/v2/workflows/dependency-graph/:workflow_id
    GET /api/v2/workflows/list-workflow-templates
    GET /api/v2/workstations
    GET /api/workflows
    GET /api/workflows/:workflow_id
    GET /healthz
    GET /livez
    GET /readyz
    PATCH /api/auth/users/:user_id
    PATCH /api/v2/audit/findings/:finding_id
    PATCH /api/v2/hosts/:host_id
    PATCH /api/v2/tasks/:task_id/provider
    POST /api/batch
    POST /api/batch/:workflow_id/summary
    POST /api/batch/commit
    POST /api/batch/conflicts
    POST /api/hooks/claude-event
    POST /api/ollama/hosts
    POST /api/ollama/hosts/:host_id/disable
    POST /api/ollama/hosts/:host_id/enable
    POST /api/ollama/hosts/:host_id/refresh-models
    POST /api/project/defaults
    POST /api/providers/configure
    POST /api/providers/default
    POST /api/scan
    POST /api/shutdown
    POST /api/snapscope/capture
    POST /api/snapscope/validate
    POST /api/snapscope/view
    POST /api/snapscope/views
    POST /api/stall-detection
    POST /api/tasks
    POST /api/tasks/:task_id/commit
    POST /api/tasks/await
    POST /api/tasks/generate-feature
    POST /api/tasks/generate-tests
    POST /api/tasks/submit
    POST /api/tools/strategic_benchmark
    POST /api/tools/strategic_decompose
    POST /api/tools/strategic_diagnose
    POST /api/tools/strategic_review
    POST /api/v2/advanced/acquire-lock
    POST /api/v2/advanced/add-approval-rule
    POST /api/v2/advanced/add-to-group
    POST /api/v2/advanced/agent-heartbeat
    POST /api/v2/advanced/analyze-query-performance
    POST /api/v2/advanced/analyze-retry-patterns
    POST /api/v2/advanced/apply-intervention
    POST /api/v2/advanced/approve-task
    POST /api/v2/advanced/boost-priority
    POST /api/v2/advanced/cache-task-result
    POST /api/v2/advanced/claim-task
    POST /api/v2/advanced/compute-priority
    POST /api/v2/advanced/conclude-experiment
    POST /api/v2/advanced/configure-adaptive-retry
    POST /api/v2/advanced/configure-artifact-storage
    POST /api/v2/advanced/configure-audit
    POST /api/v2/advanced/configure-cache
    POST /api/v2/advanced/configure-failover
    POST /api/v2/advanced/configure-priority-weights
    POST /api/v2/advanced/create-agent-group
    POST /api/v2/advanced/create-cron-schedule
    POST /api/v2/advanced/create-experiment
    POST /api/v2/advanced/create-routing-rule
    POST /api/v2/advanced/explain-priority
    POST /api/v2/advanced/export-artifacts
    POST /api/v2/advanced/export-audit-report
    POST /api/v2/advanced/inspect-state
    POST /api/v2/advanced/learn-failure-pattern
    POST /api/v2/advanced/lookup-cache
    POST /api/v2/advanced/optimize-database
    POST /api/v2/advanced/rate-limit-tasks
    POST /api/v2/advanced/register-agent
    POST /api/v2/advanced/renew-lease
    POST /api/v2/advanced/resource-report
    POST /api/v2/advanced/retry-with-adaptation
    POST /api/v2/advanced/set-breakpoint
    POST /api/v2/advanced/set-resource-limits
    POST /api/v2/advanced/steal-task
    POST /api/v2/advanced/step-execution
    POST /api/v2/advanced/store-artifact
    POST /api/v2/advanced/suggest-intervention
    POST /api/v2/advanced/task-quotas
    POST /api/v2/advanced/trigger-failover
    POST /api/v2/advanced/update-agent
    POST /api/v2/advanced/warm-cache
    POST /api/v2/agents
    POST /api/v2/approvals/:approval_id/decide
    POST /api/v2/approvals/approve-diff
    POST /api/v2/approvals/reject-task
    POST /api/v2/audit
    POST /api/v2/automation/add-import-statement
    POST /api/v2/automation/add-ts-enum-members
    POST /api/v2/automation/add-ts-interface-members
    POST /api/v2/automation/add-ts-method-to-class
    POST /api/v2/automation/add-ts-union-members
    POST /api/v2/automation/configure-quota-auto-scale
    POST /api/v2/automation/create-task-template
    POST /api/v2/automation/inject-class-dependency
    POST /api/v2/automation/inject-method-calls
    POST /api/v2/automation/normalize-interface-formatting
    POST /api/v2/automation/replace-ts-method-body
    POST /api/v2/automation/run-remote-command
    POST /api/v2/automation/run-tests
    POST /api/v2/automation/submit-from-template
    POST /api/v2/baselines/capture-config-baselines
    POST /api/v2/baselines/capture-file-baselines
    POST /api/v2/baselines/capture-test-baseline
    POST /api/v2/baselines/compare-file-baseline
    POST /api/v2/baselines/perform-auto-rollback
    POST /api/v2/baselines/restore-backup
    POST /api/v2/benchmarks/apply
    POST /api/v2/budget
    POST /api/v2/ci/await-run
    POST /api/v2/ci/configure
    POST /api/v2/ci/diagnose
    POST /api/v2/ci/stop
    POST /api/v2/ci/watch
    POST /api/v2/concurrency/set
    POST /api/v2/config
    POST /api/v2/config/stall-detection
    POST /api/v2/conflicts/resolve-workflow-conflicts
    POST /api/v2/experiments/compare-ab-test
    POST /api/v2/experiments/submit-ab-test
    POST /api/v2/hosts
    POST /api/v2/hosts/:host_id/refresh-models
    POST /api/v2/hosts/:host_id/toggle
    POST /api/v2/hosts/scan
    POST /api/v2/inference
    POST /api/v2/integration/add-routing-rule
    POST /api/v2/integration/backup-database
    POST /api/v2/integration/compare-performance
    POST /api/v2/integration/configure-integration
    POST /api/v2/integration/configure-review-workflow
    POST /api/v2/integration/disable-integration
    POST /api/v2/integration/enable-integration
    POST /api/v2/integration/export-report-csv
    POST /api/v2/integration/export-report-json
    POST /api/v2/integration/integration-health
    POST /api/v2/integration/pause-plan-project
    POST /api/v2/integration/restore-database
    POST /api/v2/integration/resume-plan-project
    POST /api/v2/integration/retry-plan-project
    POST /api/v2/integration/rollback-file
    POST /api/v2/integration/send-email-notification
    POST /api/v2/integration/set-host-priority
    POST /api/v2/integration/stash-changes
    POST /api/v2/integration/submit-chunked-review
    POST /api/v2/integration/test-integration
    POST /api/v2/integration/test-routing
    POST /api/v2/integration/update-routing-rule
    POST /api/v2/integration/view-dependencies
    POST /api/v2/intelligence/log-intelligence-outcome
    POST /api/v2/intelligence/predict-failure
    POST /api/v2/models/approve
    POST /api/v2/models/bulk-approve
    POST /api/v2/models/deny
    POST /api/v2/peek-hosts
    POST /api/v2/peek-hosts/:host_name/toggle
    POST /api/v2/peek/register-peek-host
    POST /api/v2/plan-projects/:project_id/:action
    POST /api/v2/plan-projects/import
    POST /api/v2/policies/:policy_id/mode
    POST /api/v2/policies/evaluate
    POST /api/v2/policy-evaluations/:evaluation_id/override
    POST /api/v2/projects/defaults
    POST /api/v2/projects/scan
    POST /api/v2/providers/:provider_id/configure
    POST /api/v2/providers/:provider_id/inference
    POST /api/v2/providers/:provider_id/toggle
    POST /api/v2/providers/add
    POST /api/v2/providers/apply-llm-preset
    POST /api/v2/providers/approve-provider-switch
    POST /api/v2/providers/cleanup-null-id-hosts
    POST /api/v2/providers/configure-auto-scan
    POST /api/v2/providers/configure-fallback-chain
    POST /api/v2/providers/configure-memory-protection
    POST /api/v2/providers/default
    POST /api/v2/providers/detect-provider-degradation
    POST /api/v2/providers/manage-host
    POST /api/v2/providers/manage-tuning
    POST /api/v2/providers/recover-ollama-host
    POST /api/v2/providers/reject-provider-switch
    POST /api/v2/providers/remove
    POST /api/v2/providers/run-benchmark
    POST /api/v2/providers/scan-network-for-ollama
    POST /api/v2/providers/set-auto-tuning
    POST /api/v2/providers/set-discovery-config
    POST /api/v2/providers/set-hardware-tuning
    POST /api/v2/providers/set-host-max-concurrent
    POST /api/v2/providers/set-host-memory-limit
    POST /api/v2/providers/set-host-settings
    POST /api/v2/providers/set-instruction-template
    POST /api/v2/providers/set-llm-tuning
    POST /api/v2/providers/set-model-prompt
    POST /api/v2/providers/set-model-settings
    POST /api/v2/providers/toggle-instruction-wrapping
    POST /api/v2/remote/run
    POST /api/v2/remote/test
    POST /api/v2/routing/activate
    POST /api/v2/routing/templates
    POST /api/v2/schedules
    POST /api/v2/schedules/:schedule_id/toggle
    POST /api/v2/strategic/config/reset
    POST /api/v2/strategic/strategic-usage
    POST /api/v2/strategic/test/:capability
    POST /api/v2/system/ping
    POST /api/v2/system/restart-server
    POST /api/v2/system/unlock-all-tools
    POST /api/v2/system/unlock-tier
    POST /api/v2/tasks
    POST /api/v2/tasks/:task_id/approve-switch
    POST /api/v2/tasks/:task_id/cancel
    POST /api/v2/tasks/:task_id/commit
    POST /api/v2/tasks/:task_id/reject-switch
    POST /api/v2/tasks/:task_id/retry
    POST /api/v2/tasks/add-comment
    POST /api/v2/tasks/analyze-task
    POST /api/v2/tasks/apply-smart-defaults
    POST /api/v2/tasks/archive-task
    POST /api/v2/tasks/archive-tasks
    POST /api/v2/tasks/batch-cancel
    POST /api/v2/tasks/batch-retry
    POST /api/v2/tasks/batch-tag
    POST /api/v2/tasks/bulk-import-tasks
    POST /api/v2/tasks/calibrate-predictions
    POST /api/v2/tasks/cancel-scheduled
    POST /api/v2/tasks/clone-task
    POST /api/v2/tasks/configure
    POST /api/v2/tasks/configure-project
    POST /api/v2/tasks/create-group
    POST /api/v2/tasks/create-pipeline
    POST /api/v2/tasks/dry-run-bulk
    POST /api/v2/tasks/estimate-cost
    POST /api/v2/tasks/export-data
    POST /api/v2/tasks/find-similar-tasks
    POST /api/v2/tasks/forecast-costs
    POST /api/v2/tasks/group-action
    POST /api/v2/tasks/import-data
    POST /api/v2/tasks/learn-defaults
    POST /api/v2/tasks/pause-scheduled
    POST /api/v2/tasks/pause-task
    POST /api/v2/tasks/poll-task-events
    POST /api/v2/tasks/predict-duration
    POST /api/v2/tasks/preview-diff
    POST /api/v2/tasks/queue-task
    POST /api/v2/tasks/record-usage
    POST /api/v2/tasks/restore-task
    POST /api/v2/tasks/resume-task
    POST /api/v2/tasks/rollback-task
    POST /api/v2/tasks/run-pipeline
    POST /api/v2/tasks/save-template
    POST /api/v2/tasks/schedule-task
    POST /api/v2/tasks/search-outputs
    POST /api/v2/tasks/set-default-limits
    POST /api/v2/tasks/set-task-complexity
    POST /api/v2/tasks/share-context
    POST /api/v2/tasks/start-pending-task
    POST /api/v2/tasks/stream-task-output
    POST /api/v2/tasks/subscribe-task-events
    POST /api/v2/tasks/suggest-improvements
    POST /api/v2/tasks/sync-files
    POST /api/v2/tasks/tag-task
    POST /api/v2/tasks/task-info
    POST /api/v2/tasks/task-timeline
    POST /api/v2/tasks/untag-task
    POST /api/v2/tasks/use-template
    POST /api/v2/tasks/validate-import
    POST /api/v2/tasks/wait-for-task
    POST /api/v2/tsserver/tsserver-definition
    POST /api/v2/tsserver/tsserver-diagnostics
    POST /api/v2/tsserver/tsserver-quickinfo
    POST /api/v2/tuning
    POST /api/v2/validation/add-failure-pattern
    POST /api/v2/validation/add-retry-rule
    POST /api/v2/validation/add-validation-rule
    POST /api/v2/validation/analyze-build-output
    POST /api/v2/validation/analyze-change-impact
    POST /api/v2/validation/analyze-complexity
    POST /api/v2/validation/calculate-task-complexity
    POST /api/v2/validation/configure-build-check
    POST /api/v2/validation/configure-diff-preview
    POST /api/v2/validation/configure-output-limits
    POST /api/v2/validation/conflicts
    POST /api/v2/validation/detect-config-drift
    POST /api/v2/validation/detect-dead-code
    POST /api/v2/validation/detect-regressions
    POST /api/v2/validation/estimate-resources
    POST /api/v2/validation/preview-task-diff
    POST /api/v2/validation/record-file-change
    POST /api/v2/validation/register-hook
    POST /api/v2/validation/resolve-file-location-issue
    POST /api/v2/validation/run-app-smoke-test
    POST /api/v2/validation/run-build-check
    POST /api/v2/validation/run-security-scan
    POST /api/v2/validation/run-style-check
    POST /api/v2/validation/run-syntax-check
    POST /api/v2/validation/scan-vulnerabilities
    POST /api/v2/validation/search-similar-files
    POST /api/v2/validation/set-expected-output-path
    POST /api/v2/validation/set-rate-limit
    POST /api/v2/validation/setup-precommit-hook
    POST /api/v2/validation/update-validation-rule
    POST /api/v2/validation/validate-api-contract
    POST /api/v2/validation/validate-task-output
    POST /api/v2/validation/validate-xaml-semantics
    POST /api/v2/validation/verify-and-fix
    POST /api/v2/validation/verify-type-references
    POST /api/v2/webhooks
    POST /api/v2/webhooks/:webhook_id/test
    POST /api/v2/webhooks/add-budget-alert
    POST /api/v2/webhooks/configure-auto-cleanup
    POST /api/v2/webhooks/configure-retries
    POST /api/v2/webhooks/create-inbound-webhook
    POST /api/v2/webhooks/manage-webhook
    POST /api/v2/webhooks/notify-discord
    POST /api/v2/webhooks/notify-slack
    POST /api/v2/webhooks/quick-setup-notifications
    POST /api/v2/webhooks/run-maintenance
    POST /api/v2/webhooks/webhook-logs
    POST /api/v2/workflows
    POST /api/v2/workflows/:workflow_id/cancel
    POST /api/v2/workflows/:workflow_id/pause
    POST /api/v2/workflows/:workflow_id/resume
    POST /api/v2/workflows/:workflow_id/run
    POST /api/v2/workflows/:workflow_id/tasks
    POST /api/v2/workflows/create-conditional-template
    POST /api/v2/workflows/create-workflow-template
    POST /api/v2/workflows/diff-task-runs
    POST /api/v2/workflows/duplicate-pipeline
    POST /api/v2/workflows/export-report
    POST /api/v2/workflows/feature
    POST /api/v2/workflows/fork-workflow
    POST /api/v2/workflows/instantiate-template
    POST /api/v2/workflows/merge-workflows
    POST /api/v2/workflows/replay-task
    POST /api/v2/workflows/retry-workflow-from
    POST /api/v2/workflows/skip-task
    POST /api/v2/workflows/template-loop
    POST /api/v2/workflows/what-if
    POST /api/v2/workstations
    POST /api/v2/workstations/:workstation_name/probe
    POST /api/v2/workstations/:workstation_name/toggle
    POST /api/verify
    POST /api/workflows
    POST /api/workflows/:workflow_id/cancel
    POST /api/workflows/:workflow_id/pause
    POST /api/workflows/:workflow_id/run
    POST /api/workflows/:workflow_id/tasks
    POST /api/workflows/await
    POST /api/workflows/feature
    PUT /api/v2/config/:key
    PUT /api/v2/hosts/:host_name/credentials/:credential_type
    PUT /api/v2/providers/:provider_name/api-key
    PUT /api/v2/routing/active
    PUT /api/v2/routing/templates/:template_id
    PUT /api/v2/schedules/:schedule_id
    PUT /api/v2/strategic/config
