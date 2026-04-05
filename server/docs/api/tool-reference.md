# Tool Reference

Complete reference for all TORQUE MCP tools. Tools are grouped by category and listed with their parameters.

TORQUE provides ~600 tools total, with a **core mode** (~30 core tools) enabled by default to reduce context window usage. Call `unlock_all_tools` to access the full set.

---

## Core Task Management

| Tool | Description |
|------|-------------|
| `smart_submit_task` | Submit task with automatic provider selection (preferred) |
| `submit_task` | Submit task with explicit provider |
| `await_task` | Block until a standalone task completes or fails |
| `queue_task` | Add task to queue without starting |
| `check_status` | Check task status |
| `get_result` | Get completed task result |
| `task_info` | Get detailed information about a specific task |
| `list_tasks` | List tasks with filtering |
| `cancel_task` | Cancel a running or queued task |
| `retry_task` | Retry a failed task |
| `batch_retry` | Retry all failed tasks matching filters |
| `batch_cancel` | Cancel multiple tasks based on filters |
| `pause_task` | Pause a running task |
| `resume_task` | Resume a paused task |
| `skip_task` | Manually skip a blocked task |
| `unlock_tier` | Unlock additional tool tiers (2 for extended, 3 for all) |
| `await_restart` | Wait for TORQUE server restart to complete |

## Task Templates

| Tool | Description |
|------|-------------|
| `save_template` | Save task configuration as reusable template |
| `list_templates` | List available templates |
| `use_template` | Create task from template |
| `clone_task` | Clone existing task with optional modifications |

## Task Status & Progress

| Tool | Description |
|------|-------------|
| `check_task_progress` | Check if running tasks are producing output |
| `check_stalled_tasks` | Find tasks with no recent activity |
| `health_check` | Run provider health check |
| `stream_task_output` | Get live output from running task |
| `get_task_logs` | Get complete stdout/stderr logs |
| `list_paused_tasks` | List all paused tasks |

## Task Organization

| Tool | Description |
|------|-------------|
| `tag_task` | Add tags to a task |
| `untag_task` | Remove tags from a task |
| `list_tags` | List all tags with usage counts |
| `batch_tag` | Tag multiple tasks at once |
| `create_group` | Create task group |
| `list_groups` | List task groups |
| `group_action` | Bulk action on all tasks in group |

## Task Scheduling

| Tool | Description |
|------|-------------|
| `schedule_task` | Schedule task for future or recurring execution |
| `list_scheduled` | List scheduled tasks |
| `cancel_scheduled` | Cancel a scheduled task |
| `pause_scheduled` | Pause/resume a scheduled task |
| `create_cron_schedule` | Create cron-based recurring task |
| `list_schedules` | List all schedules with next run times |
| `toggle_schedule` | Enable/disable a schedule |

## Task Archiving

| Tool | Description |
|------|-------------|
| `archive_task` | Archive a completed task |
| `archive_tasks` | Bulk archive tasks |
| `list_archived` | List archived tasks |
| `restore_task` | Restore archived task |
| `get_archive_stats` | Archive statistics |

## Git Integration

| Tool | Description |
|------|-------------|
| `preview_diff` | Preview file changes before committing |
| `commit_task` | Commit changes to git |
| `rollback_task` | Revert task commit |
| `list_commits` | List committed tasks |
| `task_changes` | View all file changes |
| `rollback_file` | Selectively rollback specific files |
| `stash_changes` | Stash uncommitted changes |
| `list_rollback_points` | Show rollback options |

## Search & Export

| Tool | Description |
|------|-------------|
| `search_outputs` | Search across all task outputs |
| `export_data` | Export tasks, templates as JSON |
| `import_data` | Import tasks, templates from JSON |
| `export_report` | Generate report (JSON, CSV, Markdown) |
| `export_report_csv` | Export as CSV |
| `export_report_json` | Export as JSON |

## Context

| Tool | Description |
|------|-------------|
| `get_context` | Get contextual information about the current environment |

---

## Workflow & DAG

| Tool | Description |
|------|-------------|
| `create_workflow` | Create new workflow (DAG) |
| `add_workflow_task` | Add task with dependencies |
| `run_workflow` | Start workflow execution |
| `workflow_status` | Get workflow progress |
| `await_workflow` | Block until workflow completes, with heartbeat check-ins |
| `cancel_workflow` | Cancel workflow and pending tasks |
| `pause_workflow` | Pause workflow |
| `list_workflows` | List workflows with filters |
| `workflow_history` | Execution timeline |

### Workflow Analysis

| Tool | Description |
|------|-------------|
| `dependency_graph` | Visual DAG representation |
| `critical_path` | Find longest execution path |
| `what_if` | Simulate task success/failure |
| `blocked_tasks` | List tasks waiting on dependencies |

### Workflow Templates

| Tool | Description |
|------|-------------|
| `create_workflow_template` | Create reusable template |
| `list_workflow_templates` | List available templates |
| `instantiate_template` | Create workflow from template |
| `delete_workflow_template` | Delete template |

### Advanced Workflow

| Tool | Description |
|------|-------------|
| `retry_workflow_from` | Restart from specific failed task |
| `fork_workflow` | Branch into parallel paths |
| `merge_workflows` | Merge parallel branches |
| `replay_task` | Replay with modified inputs |
| `diff_task_runs` | Compare two task executions |
| `create_conditional_template` | Template with conditional logic |
| `template_loop` | Iterate template over values |

### Pipelines

| Tool | Description |
|------|-------------|
| `create_pipeline` | Create sequential pipeline |
| `run_pipeline` | Start pipeline |
| `get_pipeline_status` | Pipeline status |
| `list_pipelines` | List pipelines |
| `duplicate_pipeline` | Clone pipeline |

---

## Scouts & Diffusion

| Tool | Description |
|------|-------------|
| `submit_scout` | Deploy a scout to discover issues in a project |
| `create_diffusion_plan` | Generate a workflow from a diffusion plan |

---

## Smart Routing

| Tool | Description |
|------|-------------|
| `smart_submit_task` | Auto-routed task submission |
| `test_routing` | Preview provider selection |
| `list_routing_rules` | List routing rules |
| `add_routing_rule` | Create routing rule |
| `update_routing_rule` | Modify routing rule |
| `delete_routing_rule` | Remove routing rule |
| `analyze_task` | Analyze for cloud vs local |
| `submit_chunked_review` | Submit large file in chunks |
| `get_file_chunks` | Preview chunking |

---

## Provider Management

| Tool | Description |
|------|-------------|
| `list_providers` | List all providers |
| `configure_provider` | Update provider settings |
| `set_default_provider` | Set default provider |
| `provider_stats` | Provider usage statistics |
| `configure_fallback_chain` | Set fallback order |
| `detect_provider_degradation` | Detect underperformance |
| `approve_provider_switch` | Approve provider change |
| `reject_provider_switch` | Reject provider change |

## Ollama Host Management

| Tool | Description |
|------|-------------|
| `list_ollama_models` | List available models |
| `check_ollama_health` | Check all host health |
| `add_ollama_host` | Register remote host |
| `remove_ollama_host` | Remove host |
| `list_ollama_hosts` | List hosts with status |
| `enable_ollama_host` | Enable host |
| `disable_ollama_host` | Disable host |
| `recover_ollama_host` | Recover downed host |
| `refresh_host_models` | Refresh model list |
| `set_host_memory_limit` | Set memory limit |
| `set_host_max_concurrent` | Set concurrency limit |
| `get_host_capacity` | View all host capacity |
| `cleanup_null_id_hosts` | Clean up bad entries |

## Memory Protection

| Tool | Description |
|------|-------------|
| `configure_memory_protection` | Global memory settings |
| `get_memory_protection_status` | View protection status |

## LAN Discovery

| Tool | Description |
|------|-------------|
| `get_discovery_status` | mDNS discovery status |
| `set_discovery_config` | Configure discovery |
| `scan_network_for_ollama` | Scan LAN for Ollama |
| `configure_auto_scan` | Set up periodic scanning |

---

## LLM Tuning

| Tool | Description |
|------|-------------|
| `get_llm_tuning` | View current parameters |
| `set_llm_tuning` | Adjust parameters |
| `apply_llm_preset` | Quick-apply preset |
| `list_llm_presets` | List presets |
| `get_model_settings` | Per-model settings |
| `set_model_settings` | Configure per-model |
| `get_model_prompts` | View system prompts |
| `set_model_prompt` | Set model system prompt |
| `get_instruction_templates` | View instruction wrappers |
| `set_instruction_template` | Set instruction template |
| `toggle_instruction_wrapping` | Enable/disable wrapping |

## Hardware Tuning

| Tool | Description |
|------|-------------|
| `get_hardware_tuning` | View GPU/CPU settings |
| `set_hardware_tuning` | Configure hardware optimization |
| `get_auto_tuning` | View auto-tuning rules |
| `set_auto_tuning` | Enable/disable auto-tuning |
| `run_benchmark` | Run performance benchmark |
| `get_host_settings` | Per-host optimization |
| `set_host_settings` | Configure per-host |

---

## Validation & Safeguards

### Output Validation

| Tool | Description |
|------|-------------|
| `list_validation_rules` | List validation rules |
| `add_validation_rule` | Create rule (pattern/size/delta) |
| `update_validation_rule` | Modify rule |
| `validate_task_output` | Run rules against task |
| `get_validation_results` | Get validation results |

### File Baselines

| Tool | Description |
|------|-------------|
| `capture_file_baselines` | Snapshot files before changes |
| `compare_file_baseline` | Compare against baseline |

### Syntax & Style

| Tool | Description |
|------|-------------|
| `run_syntax_check` | Language-specific syntax check |
| `list_syntax_validators` | List available validators |
| `run_style_check` | Linting and formatting |

### Build Checks

| Tool | Description |
|------|-------------|
| `run_build_check` | Run build/compile check |
| `get_build_result` | Get build result |
| `configure_build_check` | Enable/disable auto builds |
| `analyze_build_output` | Parse build errors |
| `get_build_error_analysis` | Get error categories |

### Quality & Scoring

| Tool | Description |
|------|-------------|
| `get_quality_score` | Quality score for task |
| `get_provider_quality` | Provider quality stats |
| `get_provider_stats` | Success/failure rates |
| `get_best_provider` | Recommended provider |

### Diff & Approval

| Tool | Description |
|------|-------------|
| `preview_task_diff` | View changes before commit |
| `approve_diff` | Approve changes |
| `configure_diff_preview` | Enable/disable requirement |
| `reject_task` | Reject task output |

### Rollback

| Tool | Description |
|------|-------------|
| `list_rollbacks` | Rollback history |
| `perform_auto_rollback` | Trigger auto-rollback |
| `get_auto_rollback_history` | Auto-rollback history |
| `list_backups` | File backups for task |
| `restore_backup` | Restore from backup |

### Security

| Tool | Description |
|------|-------------|
| `run_security_scan` | Security scan on output |
| `get_security_results` | Scan results |
| `list_security_rules` | Available rules |
| `scan_vulnerabilities` | Dependency CVE scan |
| `get_vulnerability_results` | Vulnerability list |

### Code Analysis

| Tool | Description |
|------|-------------|
| `analyze_complexity` | Cyclomatic/cognitive complexity |
| `get_complexity_metrics` | Complexity results |
| `detect_dead_code` | Find unused code |
| `get_dead_code_results` | Dead code results |
| `check_test_coverage` | Test file coverage |
| `analyze_change_impact` | Downstream impact |
| `check_doc_coverage` | Documentation coverage |
| `get_doc_coverage_results` | Coverage results |

### XAML/WPF

| Tool | Description |
|------|-------------|
| `validate_xaml_semantics` | XAML semantic validation |
| `get_xaml_validation_results` | Validation results |
| `check_xaml_consistency` | XAML/code-behind check |
| `get_xaml_consistency_results` | Consistency results |
| `run_app_smoke_test` | App startup test |
| `get_smoke_test_results` | Smoke test results |

### File Location

| Tool | Description |
|------|-------------|
| `set_expected_output_path` | Set expected directory |
| `check_file_locations` | Find misplaced files |
| `check_duplicate_files` | Find duplicates |
| `get_file_location_issues` | Location issues |
| `record_file_change` | Track file change |
| `resolve_file_location_issue` | Mark issue resolved |

### Code Verification

| Tool | Description |
|------|-------------|
| `verify_type_references` | Verify types exist |
| `get_type_verification_results` | Type check results |
| `search_similar_files` | Find near-duplicates |
| `get_similar_file_results` | Similar file results |
| `calculate_task_complexity` | Task difficulty score |
| `get_task_complexity_score` | Complexity result |

### LLM Safeguards

| Tool | Description |
|------|-------------|
| `get_safeguard_tools` | List safeguard tools |
| `setup_precommit_hook` | Install git hooks |

### Failure Patterns

| Tool | Description |
|------|-------------|
| `add_failure_pattern` | Register failure signature |
| `get_failure_matches` | View matched patterns |
| `learn_failure_pattern` | Learn from failed task |
| `list_failure_patterns` | List known patterns |
| `add_retry_rule` | Create retry rule |
| `list_retry_rules` | View retry rules |

---

## Cost & Budget

| Tool | Description |
|------|-------------|
| `record_usage` | Record token usage |
| `get_task_usage` | Task usage history |
| `cost_summary` | Cost summary with filtering |
| `estimate_cost` | Pre-execution cost estimate |
| `get_budget_status` | Budget status and spending |
| `set_budget` | Create/update budget |
| `get_cost_summary` | Provider cost breakdown |
| `forecast_costs` | Predict future costs |
| `add_budget_alert` | Set cost threshold alert |
| `list_budget_alerts` | List alerts |
| `remove_budget_alert` | Delete alert |
| `get_rate_limits` | Rate limit config |
| `set_rate_limit` | Set rate limit |

---

## Approval Workflows

| Tool | Description |
|------|-------------|
| `add_approval_rule` | Create approval requirement |
| `list_approval_rules` | List rules |
| `approve_task` | Approve pending task |
| `list_pending_approvals` | List waiting tasks |

---

## Webhooks & Notifications

| Tool | Description |
|------|-------------|
| `add_webhook` | Register webhook |
| `list_webhooks` | List webhooks |
| `remove_webhook` | Remove webhook |
| `test_webhook` | Test delivery |
| `webhook_logs` | Delivery logs |
| `webhook_stats` | Delivery statistics |
| `notify_slack` | Send Slack notification |
| `notify_discord` | Send Discord notification |
| `subscribe_task_events` | Subscribe SSE session to task completion/failure events. Parameters: `task_ids` (optional array), `event_filter` (optional) |

---

## Integrations

| Tool | Description |
|------|-------------|
| `configure_integration` | Configure external service |
| `list_integrations` | List integrations |
| `integration_health` | Check integration health |
| `test_integration` | Test integration |
| `enable_integration` | Enable integration |
| `disable_integration` | Disable integration |

---

## Audit & Compliance

| Tool | Description |
|------|-------------|
| `get_audit_trail` | Query audit log |
| `get_audit_summary` | Activity summary |
| `export_audit_report` | Generate audit report |
| `configure_audit` | Audit settings |
| `get_audit_log` | Query by entity/action/date |
| `add_comment` | Add comment to task |
| `list_comments` | Get task comments |
| `task_timeline` | Full chronological history |

---

## Intelligence & Analytics

### Task Intelligence

| Tool | Description |
|------|-------------|
| `suggest_improvements` | AI suggestions for failed tasks |
| `find_similar_tasks` | Find similar task descriptions |
| `learn_defaults` | Learn optimal defaults from history |
| `apply_smart_defaults` | Apply learned defaults |
| `predict_duration` | Estimate task duration |
| `duration_insights` | Prediction accuracy |
| `calibrate_predictions` | Recalculate models |

### Failure Prediction

| Tool | Description |
|------|-------------|
| `predict_failure` | Failure probability |
| `learn_failure_pattern` | Extract failure patterns |
| `list_failure_patterns` | View patterns |
| `delete_failure_pattern` | Remove pattern |
| `suggest_intervention` | Recommend prevention |
| `apply_intervention` | Auto-modify parameters |

### Adaptive Retry

| Tool | Description |
|------|-------------|
| `analyze_retry_patterns` | Strategy effectiveness |
| `configure_adaptive_retry` | Set retry rules |
| `get_retry_recommendation` | Optimal retry strategy |
| `retry_with_adaptation` | Retry with adjustments |

### Caching

| Tool | Description |
|------|-------------|
| `cache_task_result` | Cache completed result |
| `lookup_cache` | Find cached results |
| `invalidate_cache` | Remove cache entries |
| `cache_stats` | Hit rates and usage |
| `configure_cache` | TTL, max size, threshold |
| `warm_cache` | Pre-populate from history |

### Priority

| Tool | Description |
|------|-------------|
| `compute_priority` | Calculate priority score |
| `get_priority_queue` | Ordered task queue |
| `configure_priority_weights` | Adjust scoring |
| `explain_priority` | Score breakdown |
| `boost_priority` | Manual adjustment |

### Experiments

| Tool | Description |
|------|-------------|
| `create_experiment` | Start A/B test |
| `experiment_status` | Check progress |
| `conclude_experiment` | End and declare winner |
| `intelligence_dashboard` | Overview of all metrics |
| `log_intelligence_outcome` | Record prediction accuracy |

---

## Multi-Agent Coordination

### Agent Lifecycle

| Tool | Description |
|------|-------------|
| `register_agent` | Register with capabilities |
| `unregister_agent` | Remove from registry |
| `agent_heartbeat` | Send heartbeat |
| `list_agents` | List registered agents |
| `get_agent` | Agent details |
| `update_agent` | Update configuration |

### Task Claiming

| Tool | Description |
|------|-------------|
| `claim_task` | Claim with exclusive lease |
| `renew_lease` | Extend lease |
| `release_task` | Release back to queue |
| `get_claim` | Claim details |
| `list_claims` | List claims |

### Agent Groups & Routing

| Tool | Description |
|------|-------------|
| `create_agent_group` | Create group |
| `add_to_group` | Add agent to group |
| `remove_from_group` | Remove from group |
| `create_routing_rule` | Create routing rule |
| `list_routing_rules` | List rules |
| `delete_routing_rule` | Delete rule |

### Work Stealing & Failover

| Tool | Description |
|------|-------------|
| `steal_task` | Take over from another agent |
| `trigger_failover` | Manual failover |
| `get_stealing_history` | Stealing history |
| `configure_failover` | Failover settings |

### Locks

| Tool | Description |
|------|-------------|
| `acquire_lock` | Acquire distributed lock |
| `release_lock` | Release lock |
| `coordination_dashboard` | Multi-agent overview |

---

## Task Debugger

| Tool | Description |
|------|-------------|
| `set_breakpoint` | Pause on pattern match |
| `list_breakpoints` | List breakpoints |
| `clear_breakpoint` | Remove breakpoint |
| `step_execution` | Resume with step mode |
| `inspect_state` | View captured state |
| `debug_status` | Debug session status |

---

## Task Artifacts

| Tool | Description |
|------|-------------|
| `store_artifact` | Save file as artifact |
| `list_artifacts` | List task artifacts |
| `get_artifact` | Retrieve artifact |
| `delete_artifact` | Remove artifact |
| `configure_artifact_storage` | Storage settings |
| `export_artifacts` | Export as zip |

---

## Task Review

| Tool | Description |
|------|-------------|
| `set_task_review_status` | Set review status |
| `list_pending_reviews` | Tasks pending review |
| `list_tasks_needing_correction` | Tasks needing fixes |
| `set_task_complexity` | Set complexity level |
| `get_complexity_routing` | Routing for complexity |
| `set_host_priority` | Host selection priority |
| `configure_review_workflow` | Review workflow settings |
| `get_review_workflow_config` | Current review config |

---

## Plan Projects

| Tool | Description |
|------|-------------|
| `import_plan` | Import from markdown plan |
| `list_plan_projects` | List plan projects |
| `get_plan_project` | Project details |
| `pause_plan_project` | Pause all project tasks |
| `resume_plan_project` | Resume project |
| `retry_plan_project` | Retry failed tasks |

---

## Project Management

| Tool | Description |
|------|-------------|
| `list_projects` | List projects with stats |
| `project_stats` | Detailed project statistics |
| `current_project` | Current project name |
| `configure_project` | Project-specific config |
| `get_project_config` | Project configuration |
| `list_project_configs` | All project configs |

---

## Resource & Performance

| Tool | Description |
|------|-------------|
| `get_resource_usage` | CPU, memory, disk metrics |
| `set_resource_limits` | Resource limits |
| `resource_report` | Usage report |
| `estimate_resources` | Resource prediction |
| `get_timeout_alerts` | Tasks exceeding duration |
| `configure_output_limits` | Output size limits |
| `success_rates` | Success rates by project |
| `compare_performance` | Period comparison |
| `view_dependencies` | Mermaid diagram |

---

## Database & Monitoring

| Tool | Description |
|------|-------------|
| `analyze_query_performance` | Query performance analysis |
| `optimize_database` | VACUUM, ANALYZE |
| `clear_cache` | Clear cache entries |
| `query_plan` | SELECT execution plan |
| `database_stats` | Comprehensive DB stats |
| `export_metrics_prometheus` | Prometheus metrics |
| `start_dashboard` | Start web dashboard |
| `stop_dashboard` | Stop dashboard |
| `run_maintenance` | Manual maintenance run |
| `configure_auto_cleanup` | Auto cleanup settings |

---

## Miscellaneous

| Tool | Description |
|------|-------------|
| `configure` | Set any config key-value |
| `configure_retries` | Configure retry policy |
| `set_default_limits` | Default limits for projects |
| `rate_limit_tasks` | Rate limiting config |
| `task_quotas` | Usage quotas |
| `bulk_import_tasks` | Import from JSON/YAML |
| `validate_import` | Dry-run import |
| `list_bulk_operations` | Recent bulk operations |
| `bulk_operation_status` | Bulk operation result |
| `dry_run_bulk` | Preview bulk action |
| `poll_task_events` | Poll for events |
| `list_report_exports` | Previous exports |

---

## System

| Tool | Description |
|------|-------------|
| `unlock_all_tools` | Enable all ~600 tools (default: ~30 core tools) |
