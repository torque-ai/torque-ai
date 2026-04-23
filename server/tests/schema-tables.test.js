const Database = require('better-sqlite3');
const { createTables, ensureAuditLogChainColumns, ensureTableColumns } = require('../db/schema-tables');

const EXPECTED_TABLES = [
  "tasks",
  "plan_projects",
  "plan_project_tasks",
  "templates",
  "analytics",
  "pipelines",
  "pipeline_steps",
  "health_status",
  "scheduled_tasks",
  "config",
  "distributed_locks",
  "archived_tasks",
  "token_usage",
  "project_config",
  "project_metadata",
  "policy_profiles",
  "policy_rules",
  "policy_bindings",
  "policy_evaluations",
  "policy_overrides",
  "webhooks",
  "webhook_logs",
  "inbound_webhooks",
  "webhook_deliveries",
  "retry_history",
  "budget_alerts",
  "maintenance_schedule",
  "task_file_changes",
  "task_file_writes",
  "success_metrics",
  "format_success_rates",
  "task_groups",
  "task_streams",
  "stream_chunks",
  "task_checkpoints",
  "task_event_subscriptions",
  "task_events",
  "task_suggestions",
  "similar_tasks",
  "task_patterns",
  "approval_rules",
  "approval_requests",
  "task_comments",
  "audit_log",
  "audit_config",
  "resource_usage",
  "resource_limits",
  "bulk_operations",
  "duration_predictions",
  "prediction_models",
  "task_artifacts",
  "artifact_config",
  "run_artifacts",
  "factory_projects",
  "factory_work_items",
  "factory_loop_instances",
  "task_breakpoints",
  "debug_sessions",
  "debug_captures",
  "workflows",
  "workflow_checkpoints",
  "task_dependencies",
  "workflow_templates",
  "task_cache",
  "task_priority_scores",
  "failure_patterns",
  "intelligence_log",
  "strategy_experiments",
  "cache_config",
  "priority_config",
  "adaptive_retry_rules",
  "agents",
  "agent_groups",
  "agent_group_members",
  "task_claims",
  "task_routing_rules",
  "agent_metrics",
  "work_stealing_log",
  "coordination_events",
  "failover_config",
  "failover_events",
  "template_conditions",
  "task_replays",
  "rate_limits",
  "task_quotas",
  "integration_config",
  "notification_templates",
  "workflow_forks",
  "query_stats",
  "cache_stats",
  "optimization_history",
  "performance_alerts",
  "report_exports",
  "integration_health",
  "integration_tests",
  "github_issues",
  "email_notifications",
  "provider_config",
  "provider_scores",
  "provider_usage",
  "routing_rules",
  "ollama_hosts",
  "validation_rules",
  "validation_results",
  "pending_approvals",
  "failure_matches",
  "retry_rules",
  "retry_attempts",
  "file_baselines",
  "syntax_validators",
  "diff_previews",
  "quality_scores",
  "provider_task_stats",
  "task_rollbacks",
  "build_checks",
  "rate_limit_events",
  "cost_tracking",
  "cost_budgets",
  "task_fingerprints",
  "file_locks",
  "file_backups",
  "security_scans",
  "security_rules",
  "test_coverage",
  "style_checks",
  "linter_configs",
  "change_impacts",
  "timeout_alerts",
  "output_limits",
  "output_violations",
  "audit_trail",
  "vulnerability_scans",
  "complexity_metrics",
  "dead_code_results",
  "api_contract_results",
  "doc_coverage_results",
  "regression_results",
  "config_drift_results",
  "config_baselines",
  "resource_estimates",
  "i18n_results",
  "a11y_results",
  "expected_output_paths",
  "file_location_anomalies",
  "duplicate_file_detections",
  "type_verification_results",
  "build_error_analysis",
  "similar_file_search",
  "task_complexity_scores",
  "auto_rollbacks",
  "xaml_validation_results",
  "xaml_consistency_results",
  "smoke_test_results",
  "safeguard_tool_config",
  "complexity_routing",
  "model_capabilities",
  "model_task_outcomes",
  "remote_agents",
  "provider_rate_limits",
  "policy_proof_audit",
  "peek_fixture_catalog",
  "pack_registry",
  "recovery_metrics"
];

const EXPECTED_INDEXES = [
  "idx_plan_projects_status",
  "idx_plan_projects_created_at",
  "idx_plan_project_tasks_project",
  "idx_plan_project_tasks_task",
  "idx_analytics_event",
  "idx_analytics_timestamp",
  "idx_analytics_task",
  "idx_tasks_status",
  "idx_tasks_created",
  "idx_tasks_priority",
  "idx_tasks_status_priority",
  "idx_tasks_status_provider",
  "idx_tasks_status_created",
  "idx_tasks_provider_completed",
  "idx_tasks_status_completed",
  "idx_policy_profiles_project",
  "idx_policy_rules_stage",
  "idx_policy_bindings_profile",
  "idx_policy_bindings_policy",
  "idx_policy_evals_target",
  "idx_policy_evals_policy",
  "idx_policy_evals_scope",
  "idx_policy_overrides_eval",
  "idx_policy_overrides_policy",
  "idx_policy_overrides_policy_id",
  "idx_policy_overrides_created",
  "idx_pipeline_steps",
  "idx_health_status_type",
  "idx_health_checked_at",
  "idx_scheduled_next_run",
  "idx_scheduled_status",
  "idx_scheduled_tasks_enabled",
  "idx_archived_at",
  "idx_token_task",
  "idx_token_recorded",
  "idx_webhook_logs_webhook",
  "idx_webhook_logs_event",
  "idx_webhook_logs_triggered",
  "idx_webhook_logs_success",
  "idx_inbound_webhooks_name",
  "idx_inbound_webhooks_enabled",
  "idx_webhook_deliveries_received",
  "idx_retry_history_task",
  "idx_budget_alerts_project",
  "idx_budget_alerts_type",
  "idx_file_changes_task",
  "idx_task_file_writes_task",
  "idx_task_file_writes_workflow_file",
  "idx_success_metrics_period",
  "idx_success_metrics_project",
  "idx_success_metrics_upsert",
  "idx_format_success_model",
  "idx_task_groups_project",
  "idx_task_streams_task",
  "idx_stream_chunks_stream",
  "idx_stream_chunks_timestamp",
  "idx_stream_chunks_sequence",
  "idx_task_checkpoints_task",
  "idx_task_event_subs_task",
  "idx_task_event_subs_expires",
  "idx_task_events_task",
  "idx_task_events_created",
  "idx_task_suggestions_task",
  "idx_task_suggestions_type",
  "idx_similar_tasks_source",
  "idx_similar_tasks_similar",
  "idx_task_patterns_type",
  "idx_task_patterns_value",
  "idx_approval_rules_project",
  "idx_approval_rules_type",
  "idx_approval_requests_task",
  "idx_approval_requests_status",
  "idx_approval_requests_rule",
  "idx_approval_task_rule",
  "idx_task_comments_task",
  "idx_task_comments_type",
  "idx_audit_log_entity",
  "idx_audit_log_action",
  "idx_audit_log_timestamp",
  "idx_audit_log_actor",
  "idx_audit_log_chain_hash",
  "idx_audit_log_previous_hash",
  "idx_resource_usage_task",
  "idx_resource_usage_timestamp",
  "idx_resource_limits_project",
  "idx_bulk_operations_type",
  "idx_bulk_operations_status",
  "idx_bulk_operations_created",
  "idx_duration_predictions_task",
  "idx_duration_predictions_created",
  "idx_prediction_models_type",
  "idx_task_artifacts_task",
  "idx_task_artifacts_name",
  "idx_task_artifacts_expires",
  "idx_run_artifacts_task",
  "idx_factory_loop_instances_stage_occupancy",
  "idx_factory_loop_instances_project_active",
  "idx_task_breakpoints_task",
  "idx_task_breakpoints_pattern",
  "idx_debug_sessions_task",
  "idx_debug_sessions_status",
  "idx_debug_captures_session",
  "idx_workflows_status",
  "idx_workflow_checkpoints_wf_time",
  "idx_workflow_checkpoints_step",
  "idx_workflows_template",
  "idx_task_deps_workflow",
  "idx_task_deps_task",
  "idx_task_deps_depends_on",
  "idx_templates_name",
  "idx_cache_hash",
  "idx_cache_expires",
  "idx_priority_combined",
  "idx_patterns_type",
  "idx_patterns_confidence",
  "idx_intel_task",
  "idx_intel_type",
  "idx_intel_outcome",
  "idx_experiments_status",
  "idx_experiments_type",
  "idx_retry_rules_pattern",
  "idx_failover_events_task",
  "idx_failover_events_time",
  "idx_agents_status",
  "idx_agents_capabilities",
  "idx_agents_heartbeat",
  "idx_claims_agent",
  "idx_claims_status",
  "idx_claims_expires",
  "idx_routing_priority",
  "idx_routing_enabled",
  "idx_agent_metrics_agent",
  "idx_agent_metrics_period",
  "idx_agent_metrics_type",
  "idx_stealing_victim",
  "idx_stealing_time",
  "idx_coord_events_type",
  "idx_coord_events_time",
  "idx_coord_events_agent",
  "idx_template_conditions_template",
  "idx_task_replays_original",
  "idx_task_replays_replay",
  "idx_rate_limits_project",
  "idx_rate_limits_type",
  "idx_rate_limits_project_type",
  "idx_task_quotas_project",
  "idx_task_quotas_type",
  "idx_integration_config_type",
  "idx_notification_templates_type",
  "idx_workflow_forks_workflow",
  "idx_query_stats_hash",
  "idx_query_stats_avg",
  "idx_query_stats_count",
  "idx_optimization_history_type",
  "idx_optimization_history_time",
  "idx_perf_alerts_type",
  "idx_perf_alerts_severity",
  "idx_perf_alerts_ack",
  "idx_report_exports_type",
  "idx_report_exports_status",
  "idx_report_exports_created",
  "idx_integration_health_type",
  "idx_integration_health_checked",
  "idx_integration_tests_type",
  "idx_integration_tests_status",
  "idx_github_issues_task",
  "idx_github_issues_repo",
  "idx_email_notifications_task",
  "idx_email_notifications_status",
  "idx_provider_usage_provider",
  "idx_provider_usage_task",
  "idx_provider_usage_recorded",
  "idx_routing_rules_type",
  "idx_routing_rules_priority",
  "idx_ollama_hosts_enabled",
  "idx_ollama_hosts_status",
  "idx_validation_rules_type",
  "idx_validation_rules_enabled",
  "idx_validation_results_task",
  "idx_validation_results_status",
  "idx_pending_approvals_task",
  "idx_pending_approvals_status",
  "idx_failure_matches_task",
  "idx_failure_matches_pattern",
  "idx_retry_rules_trigger",
  "idx_retry_rules_enabled",
  "idx_retry_attempts_task",
  "idx_retry_attempts_outcome",
  "idx_file_baselines_path",
  "idx_file_baselines_dir",
  "idx_syntax_validators_enabled",
  "idx_diff_previews_task",
  "idx_diff_previews_status",
  "idx_quality_scores_task",
  "idx_quality_scores_provider",
  "idx_provider_stats_provider",
  "idx_provider_stats_type",
  "idx_rollbacks_task",
  "idx_rollbacks_status",
  "idx_build_checks_task",
  "idx_build_checks_status",
  "idx_rate_events_provider",
  "idx_cost_tracking_provider",
  "idx_cost_tracking_task",
  "idx_fingerprints_hash",
  "idx_file_locks_path",
  "idx_file_locks_task",
  "idx_backups_task",
  "idx_backups_file",
  "idx_security_scans_task",
  "idx_security_scans_severity",
  "idx_coverage_task",
  "idx_style_checks_task",
  "idx_impacts_task",
  "idx_impacts_file",
  "idx_timeout_alerts_task",
  "idx_violations_task",
  "idx_audit_event",
  "idx_audit_entity",
  "idx_audit_time",
  "idx_vuln_task",
  "idx_complexity_task",
  "idx_deadcode_task",
  "idx_api_task",
  "idx_doc_task",
  "idx_regression_task",
  "idx_drift_task",
  "idx_resource_task",
  "idx_i18n_task",
  "idx_a11y_task",
  "idx_expected_paths_task",
  "idx_location_anomaly_task",
  "idx_location_anomaly_type",
  "idx_duplicate_task",
  "idx_duplicate_filename",
  "idx_type_verify_task",
  "idx_type_verify_exists",
  "idx_build_error_task",
  "idx_build_error_code",
  "idx_similar_search_task",
  "idx_complexity_score_task",
  "idx_rollback_task",
  "idx_xaml_valid_task",
  "idx_xaml_valid_type",
  "idx_xaml_consist_task",
  "idx_smoke_test_task",
  "idx_provider_usage_transport",
  "idx_provider_usage_failure_reason",
  "idx_model_outcomes_model_type",
  "idx_remote_agents_status",
  "idx_remote_agents_enabled",
  "idx_peek_fixture_catalog_app_type",
  "idx_peek_fixture_catalog_name",
  "idx_peek_fixture_catalog_parent_fixture_id",
  "idx_pack_registry_name",
  "idx_pack_registry_app_type",
  "idx_pack_registry_name_version",
  "idx_pack_registry_deprecated",
  "idx_task_claims_task_status",
  "idx_task_claims_claimed_at",
  "idx_cost_budgets_provider",
  "idx_agent_group_members_group",
  "idx_rate_limits_provider",
  "idx_coordination_events_lock",
  "idx_task_cache_expires",
  "idx_query_stats_pattern",
  "idx_policy_proof_audit_surface",
  "idx_policy_proof_audit_task",
  "idx_policy_proof_audit_created",
  "idx_recovery_metrics_action",
  "idx_recovery_metrics_success",
  "idx_recovery_metrics_created",
  "idx_recovery_metrics_risk"
];

describe('db/schema-tables', () => {
  let db;
  let logger;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  });

  function getTableNames() {
    return db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((row) => row.name);
  }

  function getIndexNames() {
    return db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((row) => row.name);
  }

  function getColumns(tableName) {
    return db.prepare(`PRAGMA table_info("${tableName}")`).all();
  }

  function getColumn(tableName, columnName) {
    return getColumns(tableName).find((column) => column.name === columnName);
  }

  function getIndexSql(indexName) {
    return db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
    ).get(indexName)?.sql;
  }

  function getIndexColumns(indexName) {
    return db.prepare(`PRAGMA index_info("${indexName}")`).all()
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.name);
  }

  function getForeignKeys(tableName) {
    return db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all();
  }

  it('createTables creates all core tables', () => {
    createTables(db, logger);

    const actualTables = getTableNames();
    const expectedTables = [...EXPECTED_TABLES].sort();

    // Verify all expected tables exist (superset check — new tables don't break this)
    for (const table of expectedTables) {
      expect(actualTables).toContain(table);
    }
    expect(new Set(actualTables).size).toBe(actualTables.length);
  });

  it('createTables creates expected indexes', () => {
    createTables(db, logger);

    const actualIndexes = getIndexNames();
    const expectedIndexes = [...EXPECTED_INDEXES].sort();

    // Verify all expected indexes exist (superset check — new indexes don't break this)
    for (const idx of expectedIndexes) {
      expect(actualIndexes).toContain(idx);
    }
    expect(new Set(actualIndexes).size).toBe(actualIndexes.length);

    expect(getIndexColumns('idx_tasks_status_priority')).toEqual(['status', 'priority']);
    expect(getIndexSql('idx_tasks_status_priority')).toContain('priority DESC');
    expect(getIndexColumns('idx_coordination_events_lock')).toEqual(['lock_key', 'heartbeat_at']);
    expect(getIndexColumns('idx_task_claims_task_status')).toEqual(['task_id', 'status']);
    expect(getIndexSql('idx_rate_limits_project_type')).toContain('WHERE project_id IS NOT NULL');

    const approvalRuleIndex = db.prepare('PRAGMA index_list("approval_requests")')
      .all()
      .find((index) => index.name === 'idx_approval_task_rule');
    expect(approvalRuleIndex?.unique).toBe(1);
  });

  it('createTables is idempotent', () => {
    createTables(db, logger);
    const firstTables = getTableNames();
    const firstIndexes = getIndexNames();

    expect(() => createTables(db, logger)).not.toThrow();
    expect(getTableNames()).toEqual(firstTables);
    expect(getIndexNames()).toEqual(firstIndexes);
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('provider_config table has capability_tags and quality_band columns', () => {
    createTables(db, logger);

    const columns = getColumns('provider_config').map((column) => column.name);

    expect(columns).toContain('capability_tags');
    expect(columns).toContain('quality_band');
  });

  it('provider_performance table exists with expected columns', () => {
    createTables(db, logger);

    const columns = getColumns('provider_performance').map((column) => column.name);

    expect(columns).toContain('provider');
    expect(columns).toContain('task_type');
    expect(columns).toContain('window_start');
    expect(columns).toContain('total_tasks');
    expect(columns).toContain('successful_tasks');
    expect(columns).toContain('failed_tasks');
    expect(columns).toContain('resubmitted_tasks');
    expect(columns).toContain('avg_duration_seconds');
    expect(columns).toContain('auto_check_pass_rate');
  });

  it('provider_scores table exists with expected indexes', () => {
    createTables(db, logger);

    const columns = getColumns('provider_scores').map((column) => column.name);
    const indexes = getIndexNames();

    expect(columns).toContain('provider');
    expect(columns).toContain('composite_score');
    expect(columns).toContain('trusted');
    expect(indexes).toContain('idx_provider_scores_composite');
    expect(indexes).toContain('idx_provider_scores_trusted');
  });

  it('ensureAuditLogChainColumns adds columns to audit_log table', () => {
    db.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT DEFAULT 'system',
        old_value TEXT,
        new_value TEXT,
        metadata TEXT,
        timestamp TEXT NOT NULL
      )
    `);

    ensureAuditLogChainColumns(db);

    const auditColumns = getColumns('audit_log').map((column) => column.name);

    expect(auditColumns).toEqual([
      'id',
      'entity_type',
      'entity_id',
      'action',
      'actor',
      'old_value',
      'new_value',
      'metadata',
      'timestamp',
      'previous_hash',
      'chain_hash',
    ]);
  });

  it('ensureAuditLogChainColumns is idempotent', () => {
    db.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT DEFAULT 'system',
        old_value TEXT,
        new_value TEXT,
        metadata TEXT,
        timestamp TEXT NOT NULL,
        previous_hash TEXT
      )
    `);

    ensureAuditLogChainColumns(db);
    const columnsAfterFirstRun = getColumns('audit_log').map((column) => column.name);

    expect(() => ensureAuditLogChainColumns(db)).not.toThrow();
    expect(getColumns('audit_log').map((column) => column.name)).toEqual(columnsAfterFirstRun);
    expect(columnsAfterFirstRun.filter((name) => name === 'previous_hash')).toHaveLength(1);
    expect(columnsAfterFirstRun.filter((name) => name === 'chain_hash')).toHaveLength(1);
  });

  it('ensureTableColumns rejects invalid table names', () => {
    expect(() => ensureTableColumns(db, 'tasks; DROP TABLE tasks; --', ['safe_col TEXT'])).toThrow(
      'Invalid table name: tasks; DROP TABLE tasks; --'
    );
  });

  it('ensureTableColumns rejects invalid column definitions', () => {
    createTables(db, logger);

    expect(() => ensureTableColumns(db, 'pack_registry', ['oops TEXT; DROP TABLE tasks; --'])).toThrow(
      'Invalid column definition: oops TEXT; DROP TABLE tasks; --'
    );
  });

  it('table column constraints match the schema contract', () => {
    createTables(db, logger);

    expect(getColumn('tasks', 'id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(getColumn('tasks', 'status')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'pending'" });
    expect(getColumn('tasks', 'task_description')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('tasks', 'timeout_minutes')).toMatchObject({ type: 'INTEGER', dflt_value: '30' });
    expect(getColumn('tasks', 'auto_approve')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('tasks', 'priority')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('tasks', 'progress_percent')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('tasks', 'retry_count')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('tasks', 'max_retries')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('tasks', 'provider')).toMatchObject({ type: 'TEXT', dflt_value: "'codex'" });

    expect(getColumn('audit_log', 'actor')).toMatchObject({ type: 'TEXT', dflt_value: "'system'" });
    expect(getColumn('audit_log', 'previous_hash')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('audit_log', 'chain_hash')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('task_claims', 'task_id')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('task_claims', 'status')).toMatchObject({ type: 'TEXT', dflt_value: "'active'" });
    expect(getColumn('task_claims', 'lease_duration_seconds')).toMatchObject({ type: 'INTEGER', dflt_value: '300' });
    expect(getColumn('coordination_events', 'lock_key')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('coordination_events', 'heartbeat_at')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('rate_limits', 'provider')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('rate_limits', 'enabled')).toMatchObject({ type: 'INTEGER', dflt_value: '1' });
    expect(getColumn('policy_overrides', 'task_id')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('policy_overrides', 'reason')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('policy_overrides', 'overridden_by')).toMatchObject({ type: 'TEXT', dflt_value: "'operator'" });
    expect(getColumn('remote_agents', 'port')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '3460' });
    expect(getColumn('remote_agents', 'max_concurrent')).toMatchObject({ type: 'INTEGER', dflt_value: '3' });
    expect(getColumn('remote_agents', 'tls')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('remote_agents', 'rejectUnauthorized')).toMatchObject({ type: 'INTEGER', dflt_value: '1' });
    expect(getColumn('peek_fixture_catalog', 'id')).toMatchObject({ type: 'INTEGER', pk: 1 });
    expect(getColumn('peek_fixture_catalog', 'app_type')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('peek_fixture_catalog', 'name')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('peek_fixture_catalog', 'version')).toMatchObject({ type: 'INTEGER', dflt_value: '1' });
    expect(getColumn('peek_fixture_catalog', 'frozen')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('peek_fixture_catalog', 'fixture_data')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('pack_registry', 'id')).toMatchObject({ type: 'INTEGER', pk: 1 });
    expect(getColumn('pack_registry', 'name')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('pack_registry', 'version')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('pack_registry', 'app_type')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('pack_registry', 'signature')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('pack_registry', 'signature_verified')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('pack_registry', 'signature_algorithm')).toMatchObject({ type: 'TEXT', dflt_value: "'sha256'" });
    expect(getColumn('pack_registry', 'deprecated')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('pack_registry', 'deprecation_reason')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('pack_registry', 'sunset_date')).toMatchObject({ type: 'TEXT' });
    expect(String(getColumn('pack_registry', 'created_at').dflt_value)).toContain('CURRENT_TIMESTAMP');
    expect(String(getColumn('pack_registry', 'updated_at').dflt_value)).toContain('CURRENT_TIMESTAMP');
    expect(getColumn('pack_registry', 'metadata_json')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('pack_registry', 'maintainer')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('pack_registry', 'owner')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('pack_registry', 'successor_pack_id')).toMatchObject({ type: 'INTEGER' });
    expect(getColumn('pack_registry', 'version_history_json')).toMatchObject({ type: 'TEXT' });
    expect(getColumn('pack_registry', 'version_history_json').dflt_value).toMatch(/\[\]/);
    expect(db.prepare('PRAGMA foreign_key_list(pack_registry)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'pack_registry',
          from: 'successor_pack_id',
          to: 'id',
        }),
      ]),
    );
    expect(getColumn('recovery_metrics', 'id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(getColumn('recovery_metrics', 'action')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('recovery_metrics', 'mode')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('recovery_metrics', 'success')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(getColumn('recovery_metrics', 'attempts')).toMatchObject({ type: 'INTEGER', dflt_value: '1' });
    expect(getColumn('recovery_metrics', 'policy_blocked')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('recovery_metrics', 'approval_required')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('recovery_metrics', 'approval_granted')).toMatchObject({ type: 'INTEGER', dflt_value: '0' });
    expect(getColumn('recovery_metrics', 'created_at')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('factory_work_items', 'claimed_by_instance_id')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(getColumn('factory_loop_instances', 'id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(getColumn('factory_loop_instances', 'project_id')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('factory_loop_instances', 'work_item_id')).toMatchObject({ type: 'INTEGER', notnull: 0 });
    expect(getColumn('factory_loop_instances', 'loop_state')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'IDLE'" });
    expect(getColumn('factory_loop_instances', 'paused_at_stage')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(getColumn('factory_loop_instances', 'terminated_at')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(getIndexSql('idx_factory_loop_instances_stage_occupancy')).toContain("loop_state NOT IN ('IDLE')");
    expect(getIndexSql('idx_factory_loop_instances_project_active')).toContain('terminated_at IS NULL');
    expect(getColumn('ollama_hosts', 'url')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(getColumn('ollama_hosts', 'enabled')).toMatchObject({ type: 'INTEGER', dflt_value: '1' });
    expect(getColumn('ollama_hosts', 'status')).toMatchObject({ type: 'TEXT', dflt_value: "'unknown'" });

    db.prepare(`
      INSERT INTO tasks (id, task_description, created_at)
      VALUES (?, ?, ?)
    `).run('task-1', 'schema smoke task', '2026-03-09T00:00:00Z');

    expect(db.prepare(`
      SELECT status, timeout_minutes, auto_approve, priority, progress_percent, retry_count, max_retries, provider
      FROM tasks
      WHERE id = ?
    `).get('task-1')).toEqual({
      status: 'pending',
      timeout_minutes: 30,
      auto_approve: 0,
      priority: 0,
      progress_percent: 0,
      retry_count: 0,
      max_retries: 0,
      provider: 'codex',
    });

    db.prepare(`
      INSERT INTO agents (id, name, registered_at)
      VALUES (?, ?, ?)
    `).run('agent-1', 'worker-1', '2026-03-09T00:00:00Z');

    db.prepare(`
      INSERT INTO task_claims (id, task_id, agent_id, lease_expires_at, claimed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('claim-1', 'task-1', 'agent-1', '2026-03-09T00:05:00Z', '2026-03-09T00:00:00Z');

    expect(() => db.prepare(`
      INSERT INTO task_claims (id, task_id, agent_id, lease_expires_at, claimed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('claim-2', 'task-1', 'agent-1', '2026-03-09T00:10:00Z', '2026-03-09T00:01:00Z')).toThrow(
      /UNIQUE constraint failed: task_claims\.task_id/
    );

    db.prepare(`
      INSERT INTO ollama_hosts (id, name, url, created_at)
      VALUES (?, ?, ?, ?)
    `).run('host-1', 'Primary host', 'http://localhost:11434', '2026-03-09T00:00:00Z');

    expect(() => db.prepare(`
      INSERT INTO ollama_hosts (id, name, url, created_at)
      VALUES (?, ?, ?, ?)
    `).run('host-2', 'Duplicate host', 'http://localhost:11434', '2026-03-09T00:01:00Z')).toThrow(
      /UNIQUE constraint failed: ollama_hosts\.url/
    );

    const taskClaimForeignKeys = getForeignKeys('task_claims');
    expect(taskClaimForeignKeys.some((foreignKey) => foreignKey.table === 'tasks' && foreignKey.from === 'task_id')).toBe(true);
    expect(taskClaimForeignKeys.some((foreignKey) => foreignKey.table === 'agents' && foreignKey.from === 'agent_id')).toBe(true);

    const fixtureCatalogForeignKeys = getForeignKeys('peek_fixture_catalog');
    expect(fixtureCatalogForeignKeys.some((foreignKey) => foreignKey.table === 'peek_fixture_catalog' && foreignKey.from === 'parent_fixture_id')).toBe(true);
  });

  test('tasks table has partial_output column', () => {
    createTables(db, logger);
    const info = db.pragma('table_info(tasks)');
    const col = info.find(c => c.name === 'partial_output');
    expect(col).toBeDefined();
    expect(col.type).toBe('TEXT');
    expect(col.dflt_value).toBeNull();
  });

  test('tasks table has resume_context column', () => {
    createTables(db, logger);
    const info = db.pragma('table_info(tasks)');
    const col = info.find(c => c.name === 'resume_context');
    expect(col).toBeDefined();
    expect(col.type).toBe('TEXT');
    expect(col.dflt_value).toBeNull();
  });
});
