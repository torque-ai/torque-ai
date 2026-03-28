const VALID_TABLE_NAMES = new Set([
  'a11y_results',
  'adaptive_retry_rules',
  'adversarial_reviews',
  'agent_group_members',
  'agent_groups',
  'agent_metrics',
  'agentic_model_probes',
  'agents',
  'api_keys',
  'analytics',
  'api_contract_results',
  'approval_requests',
  'approval_rules',
  'architecture_boundaries',
  'architecture_violations',
  'archived_tasks',
  'artifact_config',
  'audit_config',
  'audit_findings',
  'audit_log',
  'audit_runs',
  'audit_trail',
  'auto_rollbacks',
  'benchmark_results',
  'budget_alerts',
  'build_checks',
  'build_error_analysis',
  'bulk_operations',
  'cache_config',
  'cache_stats',
  'change_impacts',
  'ci_run_cache',
  'ci_watches',
  'complexity_metrics',
  'complexity_routing',
  'config',
  'config_baselines',
  'config_drift_results',
  'coordination_events',
  'cost_budgets',
  'cost_tracking',
  'dead_code_results',
  'debug_captures',
  'debug_sessions',
  'diff_previews',
  'distributed_locks',
  'doc_coverage_results',
  'duplicate_file_detections',
  'duration_predictions',
  'email_notifications',
  'expected_output_paths',
  'failover_config',
  'failover_events',
  'failure_matches',
  'failure_patterns',
  'feature_flag_evidence',
  'file_backups',
  'file_baselines',
  'file_risk_scores',
  'file_location_anomalies',
  'file_locks',
  'format_success_rates',
  'quota_daily_usage',
  'github_issues',
  'health_status',
  'host_credentials',
  'i18n_results',
  'inbound_webhooks',
  'integration_config',
  'integration_health',
  'integration_tests',
  'intelligence_log',
  'linter_configs',
  'maintenance_schedule',
  'model_capabilities',
  'model_family_templates',
  'model_registry',
  'model_task_outcomes',
  'notification_templates',
  'ollama_hosts',
  'optimization_history',
  'output_limits',
  'output_violations',
  'pack_registry',
  'peek_fixture_catalog',
  'peek_hosts',
  'peek_recovery_approvals',
  'pending_approvals',
  'performance_alerts',
  'pipeline_steps',
  'pipelines',
  'plan_project_tasks',
  'plan_projects',
  'policy_bindings',
  'policy_evaluations',
  'policy_overrides',
  'policy_profiles',
  'policy_proof_audit',
  'policy_rules',
  'prediction_models',
  'priority_config',
  'project_config',
  'project_metadata',
  'project_tuning',
  'provider_config',
  'provider_health_history',
  'provider_performance',
  'provider_rate_limits',
  'provider_scores',
  'provider_task_stats',
  'provider_usage',
  'quality_scores',
  'query_stats',
  'rate_limit_events',
  'rate_limits',
  'recovery_metrics',
  'refactor_backlog_items',
  'refactor_hotspots',
  'regression_results',
  'release_gates',
  'releases',
  'remote_agents',
  'report_exports',
  'resource_estimates',
  'resource_limits',
  'resource_usage',
  'retry_attempts',
  'retry_history',
  'retry_rules',
  'routing_rules',
  'routing_templates',
  'safeguard_tool_config',
  'scheduled_tasks',
  'schema_migrations',
  'security_rules',
  'security_scans',
  'similar_file_search',
  'similar_tasks',
  'smoke_test_results',
  'strategy_experiments',
  'stream_chunks',
  'style_checks',
  'success_metrics',
  'syntax_validators',
  'task_artifacts',
  'task_breakpoints',
  'task_cache',
  'task_checkpoints',
  'task_claims',
  'task_comments',
  'task_complexity_scores',
  'task_dependencies',
  'task_event_subscriptions',
  'task_events',
  'task_file_changes',
  'task_file_writes',
  'task_fingerprints',
  'task_groups',
  'task_patterns',
  'task_priority_scores',
  'task_quotas',
  'task_replays',
  'task_rollbacks',
  'task_routing_rules',
  'task_streams',
  'task_suggestions',
  'tasks',
  'template_conditions',
  'templates',
  'test_coverage',
  'timeout_alerts',
  'token_usage',
  'type_verification_results',
  'validation_results',
  'validation_rules',
  'verification_checks',
  'vulnerability_scans',
  'webhook_deliveries',
  'webhook_logs',
  'webhooks',
  'work_stealing_log',
  'workflow_forks',
  'workflow_templates',
  'workflows',
  'workstations',
  'xaml_consistency_results',
  'xaml_validation_results',
]);

const VALID_COLUMN_DEF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)(?:\s+NOT\s+NULL)?(?:\s+DEFAULT\s+(?:[+-]?\d+(?:\.\d+)?|NULL|[A-Za-z_][A-Za-z0-9_]*|'[^']*'|"[^"]*"))?(?:\s+REFERENCES\s+[A-Za-z_][A-Za-z0-9_]*\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\))?$/i;

function ensureAuditLogChainColumns(db) {
  const pragmaResult = db.prepare('PRAGMA table_info(audit_log)').all();
  const columns = new Set(pragmaResult.map((column) => column.name));

  if (!columns.has('previous_hash')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN previous_hash TEXT');
    columns.add('previous_hash');
  }

  if (!columns.has('chain_hash')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN chain_hash TEXT');
  }
}

function ensureTableColumns(db, tableName, columnDefs = []) {
  if (!VALID_TABLE_NAMES.has(tableName)) {
    throw new Error('Invalid table name: ' + tableName);
  }

  let columns = new Set();
  try {
    columns = new Set(
      db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name),
    );
  } catch {
    return;
  }

  for (const columnDef of columnDefs) {
    const trimmed = String(columnDef || '').trim();
    if (!trimmed) continue;
    if (!VALID_COLUMN_DEF_PATTERN.test(trimmed)) {
      throw new Error('Invalid column definition: ' + columnDef);
    }
    const columnName = trimmed.split(/\s+/)[0];
    if (columns.has(columnName)) continue;
    try {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${trimmed}`);
      columns.add(columnName);
    } catch {
      // Ignore compatibility failures and leave the existing schema intact.
    }
  }
}

// ============================================================
// Timestamp convention — ALL timestamp columns MUST use UTC ISO 8601 strings.
//
// Standard: new Date().toISOString()  →  "2026-03-19T12:34:56.789Z"
//
// NEVER use:
//   - datetime('now')        — SQLite returns local time on some platforms
//   - CURRENT_TIMESTAMP      — same issue; timezone depends on OS locale
//   - Date.now()             — returns a number, not a readable string
//
// Rationale: SQLite has no native TIMESTAMP type; all times are stored as TEXT.
// Using ISO 8601 UTC strings ensures correct lexicographic sort order and
// prevents subtle off-by-hours bugs when servers are in non-UTC timezones.
//
// For schema DEFAULT clauses that need a server-side default, prefer leaving
// the column nullable and setting the value from JS, or use:
//   DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
// which explicitly forces UTC (SQLite's 'now' in strftime is always UTC).
//
// Existing DEFAULT (datetime('now')) and DEFAULT CURRENT_TIMESTAMP in legacy
// table definitions are kept for backwards compatibility (column already exists),
// but new columns must follow the ISO 8601 UTC convention above.
// ============================================================

function createTables(db, logger) {
  const rawDb = db;
  db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        task_description TEXT NOT NULL,
        working_directory TEXT,
        timeout_minutes INTEGER DEFAULT 30,
        auto_approve INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0,
        context TEXT,
        output TEXT,
        error_output TEXT,
        exit_code INTEGER,
        pid INTEGER,
        progress_percent INTEGER DEFAULT 0,
        files_modified TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        -- Retry support
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 0,
        -- Dependencies
        depends_on TEXT,
        -- Template reference
        template_name TEXT,
        -- Workspace isolation
        isolated_workspace TEXT,
        -- Provider support (codex, claude-cli)
        provider TEXT DEFAULT 'codex',
        original_provider TEXT,
        provider_switched_at TEXT,
        -- Heartbeat: partial output from streaming providers
        partial_output TEXT,
        -- Columns added via migrations (synced to base schema)
        tags TEXT,
        project TEXT,
        model TEXT,
        complexity TEXT DEFAULT 'normal',
        review_status TEXT,
        ollama_host_id TEXT,
        metadata TEXT,
        workflow_id TEXT,
        workflow_node_id TEXT,
        stall_timeout_seconds INTEGER,
        mcp_instance_id TEXT,
        retry_strategy TEXT DEFAULT 'same_provider',
        retry_delay_seconds INTEGER DEFAULT 30,
        last_retry_at TEXT,
        group_id TEXT,
        paused_at TEXT,
        pause_reason TEXT,
        approval_status TEXT DEFAULT 'not_required',
        claimed_by_agent TEXT,
        required_capabilities TEXT,
        git_before_sha TEXT,
        git_after_sha TEXT,
        git_stash_ref TEXT,
        resume_context TEXT
      )
    `);
  try {
    rawDb.exec('ALTER TABLE tasks ADD COLUMN resume_context TEXT');
  } catch {
    // Column already exists — safe to ignore
  }
  db.exec(`
      CREATE TABLE IF NOT EXISTS plan_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        source_file TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        total_tasks INTEGER DEFAULT 0,
        completed_tasks INTEGER DEFAULT 0,
        failed_tasks INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_projects_status ON plan_projects(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_projects_created_at ON plan_projects(created_at)`);
  db.exec(`
      CREATE TABLE IF NOT EXISTS plan_project_tasks (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        sequence_number INTEGER,
        depends_on TEXT,
        PRIMARY KEY (project_id, task_id)
      )
    `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_project_tasks_project ON plan_project_tasks(project_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_project_tasks_task ON plan_project_tasks(task_id)`);
  db.exec(`
      CREATE TABLE IF NOT EXISTS templates (
        name TEXT PRIMARY KEY,
        description TEXT,
        task_template TEXT NOT NULL,
        default_timeout INTEGER DEFAULT 30,
        default_priority INTEGER DEFAULT 0,
        auto_approve INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        usage_count INTEGER DEFAULT 0
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        task_id TEXT,
        data TEXT,
        timestamp TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics(event_type);
      CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_analytics_task ON analytics(task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_provider ON tasks(status, provider, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_provider_completed ON tasks(provider, completed_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_completed ON tasks(status, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        current_step INTEGER DEFAULT 0,
        working_directory TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        name TEXT NOT NULL,
        task_template TEXT NOT NULL,
        condition TEXT,
        timeout_minutes INTEGER DEFAULT 30,
        task_id TEXT,
        status TEXT DEFAULT 'pending',
        output_vars TEXT,
        FOREIGN KEY (pipeline_id) REFERENCES pipelines(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_steps ON pipeline_steps(pipeline_id, step_order);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS health_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_type TEXT NOT NULL,
        status TEXT NOT NULL,
        response_time_ms INTEGER,
        error_message TEXT,
        details TEXT,
        checked_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_health_status_type ON health_status(check_type);
      CREATE INDEX IF NOT EXISTS idx_health_checked_at ON health_status(checked_at);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        task_description TEXT NOT NULL,
        working_directory TEXT,
        timeout_minutes INTEGER DEFAULT 30,
        auto_approve INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0,
        tags TEXT,
        schedule_type TEXT NOT NULL,
        cron_expression TEXT,
        scheduled_time TEXT,
        repeat_interval_minutes INTEGER,
        next_run_at TEXT,
        last_run_at TEXT,
        run_count INTEGER DEFAULT 0,
        max_runs INTEGER,
        status TEXT DEFAULT 'active',
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_next_run ON scheduled_tasks(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS distributed_locks (
        lock_name TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        holder_info TEXT,
        last_heartbeat TEXT
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS archived_tasks (
        id TEXT PRIMARY KEY,
        original_data TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        archive_reason TEXT
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_archived_at ON archived_tasks(archived_at);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        estimated_cost_usd REAL DEFAULT 0,
        model TEXT,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_token_task ON token_usage(task_id);
      CREATE INDEX IF NOT EXISTS idx_token_recorded ON token_usage(recorded_at);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS project_config (
        project TEXT PRIMARY KEY,
        max_concurrent INTEGER DEFAULT 0,
        max_daily_cost REAL DEFAULT 0,
        max_daily_tokens INTEGER DEFAULT 0,
        default_timeout INTEGER DEFAULT 30,
        default_priority INTEGER DEFAULT 0,
        auto_approve INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS project_metadata (
        project TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, key)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS policy_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project TEXT,
        description TEXT,
        defaults_json TEXT,
        profile_json TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS policy_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        stage TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'advisory',
        priority INTEGER DEFAULT 100,
        enabled INTEGER DEFAULT 1,
        matcher_json TEXT,
        required_evidence_json TEXT,
        actions_json TEXT,
        override_policy_json TEXT,
        tags_json TEXT,
        version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS policy_bindings (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        mode_override TEXT,
        binding_json TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(profile_id, policy_id),
        FOREIGN KEY (profile_id) REFERENCES policy_profiles(id),
        FOREIGN KEY (policy_id) REFERENCES policy_rules(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS policy_evaluations (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        profile_id TEXT,
        stage TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        project TEXT,
        mode TEXT NOT NULL,
        outcome TEXT NOT NULL,
        severity TEXT,
        message TEXT,
        evidence_json TEXT,
        evaluation_json TEXT,
        override_allowed INTEGER DEFAULT 0,
        scope_fingerprint TEXT,
        replay_of_evaluation_id TEXT,
        suppressed INTEGER DEFAULT 0,
        suppression_reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (policy_id) REFERENCES policy_rules(id),
        FOREIGN KEY (profile_id) REFERENCES policy_profiles(id),
        FOREIGN KEY (replay_of_evaluation_id) REFERENCES policy_evaluations(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS policy_overrides (
        id TEXT PRIMARY KEY,
        evaluation_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        task_id TEXT,
        reason TEXT,
        overridden_by TEXT DEFAULT 'operator',
        decision TEXT NOT NULL DEFAULT 'override',
        reason_code TEXT NOT NULL,
        notes TEXT,
        actor TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (evaluation_id) REFERENCES policy_evaluations(id),
        FOREIGN KEY (policy_id) REFERENCES policy_rules(id)
      )
    `);
  ensureTableColumns(db, 'policy_profiles', [
    'defaults_json TEXT',
    'profile_json TEXT',
    'enabled INTEGER DEFAULT 1',
    'created_at TEXT',
    'updated_at TEXT',
  ]);
  ensureTableColumns(db, 'policy_rules', [
    'mode TEXT DEFAULT \'advisory\'',
    'priority INTEGER DEFAULT 100',
    'enabled INTEGER DEFAULT 1',
    'matcher_json TEXT',
    'required_evidence_json TEXT',
    'actions_json TEXT',
    'override_policy_json TEXT',
    'tags_json TEXT',
    'version TEXT',
    'created_at TEXT',
    'updated_at TEXT',
  ]);
  ensureTableColumns(db, 'policy_bindings', [
    'mode_override TEXT',
    'binding_json TEXT',
    'enabled INTEGER DEFAULT 1',
    'created_at TEXT',
    'updated_at TEXT',
  ]);
  ensureTableColumns(db, 'policy_evaluations', [
    'evidence_json TEXT',
    'evaluation_json TEXT',
    'override_allowed INTEGER DEFAULT 0',
    'scope_fingerprint TEXT',
    'replay_of_evaluation_id TEXT',
    'suppressed INTEGER DEFAULT 0',
    'suppression_reason TEXT',
    'created_at TEXT',
  ]);
  ensureTableColumns(db, 'policy_overrides', [
    'task_id TEXT',
    'reason TEXT',
    'overridden_by TEXT DEFAULT \'operator\'',
    'decision TEXT DEFAULT \'override\'',
    "reason_code TEXT NOT NULL DEFAULT 'unknown'",
    'notes TEXT',
    'actor TEXT',
    'expires_at TEXT',
    'created_at TEXT',
  ]);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_policy_profiles_project ON policy_profiles(project, enabled);
      CREATE INDEX IF NOT EXISTS idx_policy_rules_stage ON policy_rules(stage, enabled, priority);
      CREATE INDEX IF NOT EXISTS idx_policy_bindings_profile ON policy_bindings(profile_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_policy_bindings_policy ON policy_bindings(policy_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_policy_evals_target ON policy_evaluations(target_type, target_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_policy_evals_policy ON policy_evaluations(policy_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_policy_evals_scope ON policy_evaluations(policy_id, target_type, target_id, stage, scope_fingerprint, created_at);
      CREATE INDEX IF NOT EXISTS idx_policy_overrides_eval ON policy_overrides(evaluation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_policy_overrides_policy ON policy_overrides(policy_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_policy_overrides_policy_id ON policy_overrides(policy_id);
      CREATE INDEX IF NOT EXISTS idx_policy_overrides_created ON policy_overrides(created_at);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'http',
        events TEXT NOT NULL,
        project TEXT,
        headers TEXT,
        secret TEXT,
        enabled INTEGER DEFAULT 1,
        retry_count INTEGER DEFAULT 3,
        created_at TEXT NOT NULL,
        last_triggered_at TEXT,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT NOT NULL,
        event TEXT NOT NULL,
        task_id TEXT,
        payload TEXT,
        response_status INTEGER,
        response_body TEXT,
        success INTEGER,
        error TEXT,
        triggered_at TEXT NOT NULL,
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook ON webhook_logs(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_event ON webhook_logs(event);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_triggered ON webhook_logs(triggered_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_success ON webhook_logs(success);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL DEFAULT 'generic',
        secret TEXT NOT NULL,
        action_config TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_triggered_at TEXT,
        trigger_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        webhook_name TEXT NOT NULL,
        task_id TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (webhook_name) REFERENCES inbound_webhooks(name) ON DELETE CASCADE
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbound_webhooks_name ON inbound_webhooks(name);
      CREATE INDEX IF NOT EXISTS idx_inbound_webhooks_enabled ON inbound_webhooks(enabled);
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received ON webhook_deliveries(received_at);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS retry_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        delay_used INTEGER DEFAULT 0,
        error_message TEXT,
        prompt_modification TEXT,
        retried_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_retry_history_task ON retry_history(task_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS budget_alerts (
        id TEXT PRIMARY KEY,
        project TEXT,
        alert_type TEXT NOT NULL,
        threshold_percent INTEGER NOT NULL,
        threshold_value REAL,
        webhook_id TEXT,
        cooldown_minutes INTEGER DEFAULT 60,
        last_triggered_at TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_budget_alerts_project ON budget_alerts(project);
      CREATE INDEX IF NOT EXISTS idx_budget_alerts_type ON budget_alerts(alert_type);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_schedule (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        interval_minutes INTEGER,
        cron_expression TEXT,
        last_run_at TEXT,
        next_run_at TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        file_size_bytes INTEGER,
        working_directory TEXT,
        relative_path TEXT,
        is_outside_workdir INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_file_changes_task ON task_file_changes(task_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_file_writes (
        task_id TEXT,
        workflow_id TEXT,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        written_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_file_writes_task ON task_file_writes(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_file_writes_workflow_file ON task_file_writes(workflow_id, file_path);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS success_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_start TEXT NOT NULL,
        period_type TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        template TEXT,
        total_tasks INTEGER DEFAULT 0,
        successful_tasks INTEGER DEFAULT 0,
        failed_tasks INTEGER DEFAULT 0,
        cancelled_tasks INTEGER DEFAULT 0,
        avg_duration_seconds REAL,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_success_metrics_period ON success_metrics(period_start, period_type);
      CREATE INDEX IF NOT EXISTS idx_success_metrics_project ON success_metrics(project);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_success_metrics_upsert ON success_metrics(period_type, period_start, project);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS format_success_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        edit_format TEXT NOT NULL,
        success INTEGER NOT NULL,
        failure_reason TEXT,
        duration_seconds INTEGER,
        recorded_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_format_success_model ON format_success_rates(model, edit_format);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project TEXT,
        description TEXT,
        default_priority INTEGER DEFAULT 0,
        default_timeout INTEGER DEFAULT 30,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_groups_project ON task_groups(project);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_streams (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        stream_type TEXT NOT NULL DEFAULT 'output',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS stream_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        chunk_data TEXT NOT NULL,
        chunk_type TEXT NOT NULL DEFAULT 'stdout',
        sequence_num INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (stream_id) REFERENCES task_streams(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_streams_task ON task_streams(task_id);
      CREATE INDEX IF NOT EXISTS idx_stream_chunks_stream ON stream_chunks(stream_id);
      CREATE INDEX IF NOT EXISTS idx_stream_chunks_timestamp ON stream_chunks(timestamp);
      CREATE INDEX IF NOT EXISTS idx_stream_chunks_sequence ON stream_chunks(stream_id, sequence_num);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        checkpoint_data TEXT NOT NULL,
        checkpoint_type TEXT DEFAULT 'pause',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task ON task_checkpoints(task_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_event_subscriptions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        event_types TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_poll_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        event_data TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_event_subs_task ON task_event_subscriptions(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_event_subs_expires ON task_event_subscriptions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_events_created ON task_events(created_at);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        suggestion_type TEXT NOT NULL,
        suggestion_text TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        applied INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS similar_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_task_id TEXT NOT NULL,
        similar_task_id TEXT NOT NULL,
        similarity_score REAL NOT NULL,
        similarity_type TEXT DEFAULT 'description',
        created_at TEXT NOT NULL,
        FOREIGN KEY (source_task_id) REFERENCES tasks(id),
        FOREIGN KEY (similar_task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_type TEXT NOT NULL,
        pattern_value TEXT NOT NULL,
        suggested_config TEXT NOT NULL,
        hit_count INTEGER DEFAULT 1,
        success_rate REAL DEFAULT 0,
        avg_duration_seconds REAL,
        last_matched_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_suggestions_task ON task_suggestions(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_suggestions_type ON task_suggestions(suggestion_type);
      CREATE INDEX IF NOT EXISTS idx_similar_tasks_source ON similar_tasks(source_task_id);
      CREATE INDEX IF NOT EXISTS idx_similar_tasks_similar ON similar_tasks(similar_task_id);
      CREATE INDEX IF NOT EXISTS idx_task_patterns_type ON task_patterns(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_task_patterns_value ON task_patterns(pattern_value);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS approval_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project TEXT,
        rule_type TEXT NOT NULL,
        condition TEXT NOT NULL,
        required_approvers INTEGER DEFAULT 1,
        auto_approve_after_minutes INTEGER,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL,
        approved_at TEXT,
        approved_by TEXT,
        comment TEXT,
        auto_approved INTEGER DEFAULT 0,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (rule_id) REFERENCES approval_rules(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_approval_rules_project ON approval_rules(project);
      CREATE INDEX IF NOT EXISTS idx_approval_rules_type ON approval_rules(rule_type);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_rule ON approval_requests(rule_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_task_rule ON approval_requests(task_id, rule_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'user',
        comment_text TEXT NOT NULL,
        comment_type TEXT NOT NULL DEFAULT 'note',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
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
  db.exec(`
      CREATE TABLE IF NOT EXISTS audit_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_comments_type ON task_comments(comment_type);
      CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_log_chain_hash ON audit_log(chain_hash);
      CREATE INDEX IF NOT EXISTS idx_audit_log_previous_hash ON audit_log(previous_hash);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS resource_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        cpu_percent REAL,
        memory_mb REAL,
        disk_io_mb REAL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS resource_limits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL UNIQUE,
        max_cpu_percent REAL,
        max_memory_mb REAL,
        max_concurrent INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_resource_usage_task ON resource_usage(task_id);
      CREATE INDEX IF NOT EXISTS idx_resource_usage_timestamp ON resource_usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_resource_limits_project ON resource_limits(project);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS bulk_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        filter_criteria TEXT NOT NULL,
        affected_task_ids TEXT,
        total_tasks INTEGER DEFAULT 0,
        succeeded_tasks INTEGER DEFAULT 0,
        failed_tasks INTEGER DEFAULT 0,
        dry_run INTEGER DEFAULT 0,
        results TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bulk_operations_type ON bulk_operations(operation_type);
      CREATE INDEX IF NOT EXISTS idx_bulk_operations_status ON bulk_operations(status);
      CREATE INDEX IF NOT EXISTS idx_bulk_operations_created ON bulk_operations(created_at);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS duration_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        predicted_seconds REAL NOT NULL,
        confidence REAL DEFAULT 0.5,
        factors TEXT NOT NULL,
        actual_seconds REAL,
        error_percent REAL,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS prediction_models (
        id TEXT PRIMARY KEY,
        model_type TEXT NOT NULL,
        model_key TEXT,
        sample_count INTEGER DEFAULT 0,
        avg_seconds REAL,
        std_deviation REAL,
        last_calibrated_at TEXT
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_duration_predictions_task ON duration_predictions(task_id);
      CREATE INDEX IF NOT EXISTS idx_duration_predictions_created ON duration_predictions(created_at);
      CREATE INDEX IF NOT EXISTS idx_prediction_models_type ON prediction_models(model_type);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER,
        checksum TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_artifacts_name ON task_artifacts(name);
      CREATE INDEX IF NOT EXISTS idx_task_artifacts_expires ON task_artifacts(expires_at);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_breakpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        pattern TEXT NOT NULL,
        pattern_type TEXT DEFAULT 'output',
        action TEXT DEFAULT 'pause',
        enabled INTEGER DEFAULT 1,
        hit_count INTEGER DEFAULT 0,
        max_hits INTEGER,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS debug_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        current_breakpoint_id TEXT,
        paused_at_sequence INTEGER,
        captured_state TEXT,
        step_mode TEXT,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS debug_captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        breakpoint_id TEXT,
        output_snapshot TEXT,
        error_snapshot TEXT,
        progress_percent INTEGER,
        elapsed_seconds INTEGER,
        captured_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_breakpoints_task ON task_breakpoints(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_breakpoints_pattern ON task_breakpoints(pattern);
      CREATE INDEX IF NOT EXISTS idx_debug_sessions_task ON debug_sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_debug_sessions_status ON debug_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_debug_captures_session ON debug_captures(session_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        working_directory TEXT,
        status TEXT DEFAULT 'pending',
        template_id TEXT,
        total_tasks INTEGER DEFAULT 0,
        completed_tasks INTEGER DEFAULT 0,
        failed_tasks INTEGER DEFAULT 0,
        skipped_tasks INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        context TEXT,
        priority INTEGER DEFAULT 0
      )
    `);
  ensureTableColumns(db, 'workflows', [
    'priority INTEGER DEFAULT 0',
  ]);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        condition_expr TEXT,
        on_fail TEXT DEFAULT 'skip',
        alternate_task_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        task_definitions TEXT NOT NULL,
        dependency_graph TEXT NOT NULL,
        default_conditions TEXT,
        variables TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
      CREATE INDEX IF NOT EXISTS idx_workflows_priority ON workflows(priority);
      CREATE INDEX IF NOT EXISTS idx_workflows_status_priority ON workflows(status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_workflows_template ON workflows(template_id);
      CREATE INDEX IF NOT EXISTS idx_task_deps_workflow ON task_dependencies(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_task_id);
      CREATE INDEX IF NOT EXISTS idx_templates_name ON workflow_templates(name);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_cache (
        id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        embedding_vector TEXT,
        task_description TEXT NOT NULL,
        working_directory TEXT,
        result_output TEXT,
        result_exit_code INTEGER,
        result_files_modified TEXT,
        hit_count INTEGER DEFAULT 0,
        last_hit_at TEXT,
        confidence_score REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        expires_at TEXT
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_priority_scores (
        task_id TEXT PRIMARY KEY,
        resource_score REAL DEFAULT 0.5,
        success_score REAL DEFAULT 0.5,
        dependency_score REAL DEFAULT 0.5,
        combined_score REAL DEFAULT 0.5,
        factors TEXT,
        computed_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS failure_patterns (
        id TEXT PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        pattern_definition TEXT NOT NULL,
        failure_count INTEGER DEFAULT 0,
        total_matches INTEGER DEFAULT 0,
        failure_rate REAL,
        suggested_intervention TEXT,
        confidence REAL DEFAULT 0.5,
        last_updated_at TEXT,
        created_at TEXT NOT NULL,
        -- Columns added via migrations (synced to base schema)
        name TEXT,
        description TEXT,
        signature TEXT,
        task_types TEXT,
        provider TEXT,
        occurrence_count INTEGER DEFAULT 0,
        recommended_action TEXT,
        auto_learned INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        updated_at TEXT
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS intelligence_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        action_details TEXT NOT NULL,
        confidence REAL,
        outcome TEXT,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        strategy_type TEXT NOT NULL,
        variant_a TEXT NOT NULL,
        variant_b TEXT NOT NULL,
        status TEXT DEFAULT 'running',
        sample_size_target INTEGER,
        results_a TEXT,
        results_b TEXT,
        winner TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS cache_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS priority_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS adaptive_retry_rules (
        id TEXT PRIMARY KEY,
        error_pattern TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        adjustment TEXT NOT NULL,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_hash ON task_cache(content_hash);
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON task_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_priority_combined ON task_priority_scores(combined_score DESC);
      CREATE INDEX IF NOT EXISTS idx_patterns_type ON failure_patterns(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON failure_patterns(confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_intel_task ON intelligence_log(task_id);
      CREATE INDEX IF NOT EXISTS idx_intel_type ON intelligence_log(action_type);
      CREATE INDEX IF NOT EXISTS idx_intel_outcome ON intelligence_log(outcome);
      CREATE INDEX IF NOT EXISTS idx_experiments_status ON strategy_experiments(status);
      CREATE INDEX IF NOT EXISTS idx_experiments_type ON strategy_experiments(strategy_type);
      CREATE INDEX IF NOT EXISTS idx_retry_rules_pattern ON adaptive_retry_rules(error_pattern);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_type TEXT DEFAULT 'worker',
        status TEXT DEFAULT 'offline',
        capabilities TEXT,
        max_concurrent INTEGER DEFAULT 1,
        current_load INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0,
        metadata TEXT,
        last_heartbeat_at TEXT,
        registered_at TEXT NOT NULL,
        disconnected_at TEXT
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        routing_strategy TEXT DEFAULT 'round_robin',
        max_agents INTEGER,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_group_members (
        agent_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, group_id),
        FOREIGN KEY (agent_id) REFERENCES agents(id),
        FOREIGN KEY (group_id) REFERENCES agent_groups(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_claims (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        lease_expires_at TEXT NOT NULL,
        lease_duration_seconds INTEGER DEFAULT 300,
        renewals INTEGER DEFAULT 0,
        claimed_at TEXT NOT NULL,
        released_at TEXT,
        release_reason TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_routing_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        condition_type TEXT NOT NULL,
        condition_value TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_value TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        metric_value REAL NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS work_stealing_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        victim_agent_id TEXT NOT NULL,
        thief_agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        reason TEXT,
        stolen_at TEXT NOT NULL,
        FOREIGN KEY (victim_agent_id) REFERENCES agents(id),
        FOREIGN KEY (thief_agent_id) REFERENCES agents(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS coordination_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        agent_id TEXT,
        task_id TEXT,
        lock_key TEXT,
        heartbeat_at TEXT,
        details TEXT,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS failover_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS failover_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        from_provider TEXT,
        to_provider TEXT,
        from_model TEXT,
        to_model TEXT,
        from_host TEXT,
        to_host TEXT,
        reason TEXT NOT NULL,
        failover_type TEXT NOT NULL DEFAULT 'provider',
        attempt_num INTEGER DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_failover_events_task ON failover_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_failover_events_time ON failover_events(created_at);
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_agents_capabilities ON agents(capabilities);
      CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(last_heartbeat_at);
      CREATE INDEX IF NOT EXISTS idx_claims_agent ON task_claims(agent_id);
      CREATE INDEX IF NOT EXISTS idx_claims_status ON task_claims(status);
      CREATE INDEX IF NOT EXISTS idx_claims_expires ON task_claims(lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_routing_priority ON task_routing_rules(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_routing_enabled ON task_routing_rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent ON agent_metrics(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_metrics_period ON agent_metrics(period_start);
      CREATE INDEX IF NOT EXISTS idx_agent_metrics_type ON agent_metrics(metric_type);
      CREATE INDEX IF NOT EXISTS idx_stealing_victim ON work_stealing_log(victim_agent_id);
      CREATE INDEX IF NOT EXISTS idx_stealing_time ON work_stealing_log(stolen_at);
      CREATE INDEX IF NOT EXISTS idx_coord_events_type ON coordination_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_coord_events_time ON coordination_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_coord_events_agent ON coordination_events(agent_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS template_conditions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        condition_type TEXT NOT NULL,
        condition_expr TEXT NOT NULL,
        then_block TEXT,
        else_block TEXT,
        order_index INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_replays (
        id TEXT PRIMARY KEY,
        original_task_id TEXT NOT NULL,
        replay_task_id TEXT NOT NULL,
        modified_inputs TEXT,
        diff_summary TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (original_task_id) REFERENCES tasks(id),
        FOREIGN KEY (replay_task_id) REFERENCES tasks(id)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        provider TEXT,
        limit_type TEXT NOT NULL,
        max_value INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        current_value INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        window_start TEXT,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_quotas (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        quota_type TEXT NOT NULL,
        max_value INTEGER NOT NULL,
        current_value INTEGER DEFAULT 0,
        reset_period TEXT,
        last_reset TEXT,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS integration_config (
        id TEXT PRIMARY KEY,
        integration_type TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS notification_templates (
        id TEXT PRIMARY KEY,
        integration_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
        template TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_forks (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        fork_point_task_id TEXT,
        branch_count INTEGER DEFAULT 2,
        branches TEXT NOT NULL,
        merge_strategy TEXT DEFAULT 'all',
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id)
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_template_conditions_template ON template_conditions(template_id);
      CREATE INDEX IF NOT EXISTS idx_task_replays_original ON task_replays(original_task_id);
      CREATE INDEX IF NOT EXISTS idx_task_replays_replay ON task_replays(replay_task_id);
      CREATE INDEX IF NOT EXISTS idx_rate_limits_project ON rate_limits(project_id);
      CREATE INDEX IF NOT EXISTS idx_rate_limits_type ON rate_limits(limit_type);
      CREATE INDEX IF NOT EXISTS idx_rate_limits_project_type ON rate_limits(project_id, limit_type) WHERE project_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_task_quotas_project ON task_quotas(project_id);
      CREATE INDEX IF NOT EXISTS idx_task_quotas_type ON task_quotas(quota_type);
      CREATE INDEX IF NOT EXISTS idx_integration_config_type ON integration_config(integration_type);
      CREATE INDEX IF NOT EXISTS idx_notification_templates_type ON notification_templates(integration_type);
      CREATE INDEX IF NOT EXISTS idx_workflow_forks_workflow ON workflow_forks(workflow_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS query_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_hash TEXT NOT NULL,
        query_pattern TEXT NOT NULL,
        execution_count INTEGER DEFAULT 1,
        total_time_ms REAL DEFAULT 0,
        avg_time_ms REAL DEFAULT 0,
        max_time_ms REAL DEFAULT 0,
        min_time_ms REAL DEFAULT 0,
        last_executed_at TEXT NOT NULL,
        first_executed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_query_stats_hash ON query_stats(query_hash);
      CREATE INDEX IF NOT EXISTS idx_query_stats_avg ON query_stats(avg_time_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_query_stats_count ON query_stats(execution_count DESC);
    
      -- Cache statistics
      CREATE TABLE IF NOT EXISTS cache_stats (
        cache_name TEXT PRIMARY KEY,
        hits INTEGER DEFAULT 0,
        misses INTEGER DEFAULT 0,
        evictions INTEGER DEFAULT 0,
        total_entries INTEGER DEFAULT 0,
        max_entries INTEGER DEFAULT 1000,
        last_hit_at TEXT,
        last_miss_at TEXT,
        created_at TEXT NOT NULL
      );
    
      -- Database optimization history
      CREATE TABLE IF NOT EXISTS optimization_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_type TEXT NOT NULL,
        table_name TEXT,
        details TEXT,
        duration_ms INTEGER,
        size_before_bytes INTEGER,
        size_after_bytes INTEGER,
        executed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_optimization_history_type ON optimization_history(operation_type);
      CREATE INDEX IF NOT EXISTS idx_optimization_history_time ON optimization_history(executed_at DESC);
    
      -- Performance alerts
      CREATE TABLE IF NOT EXISTS performance_alerts (
        id TEXT PRIMARY KEY,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning',
        message TEXT NOT NULL,
        details TEXT,
        query_hash TEXT,
        acknowledged INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_perf_alerts_type ON performance_alerts(alert_type);
      CREATE INDEX IF NOT EXISTS idx_perf_alerts_severity ON performance_alerts(severity);
      CREATE INDEX IF NOT EXISTS idx_perf_alerts_ack ON performance_alerts(acknowledged);
    `);
  db.exec(`
      -- Report exports
      CREATE TABLE IF NOT EXISTS report_exports (
        id TEXT PRIMARY KEY,
        report_type TEXT NOT NULL,
        format TEXT NOT NULL,
        filters TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        file_path TEXT,
        file_size_bytes INTEGER,
        row_count INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_report_exports_type ON report_exports(report_type);
      CREATE INDEX IF NOT EXISTS idx_report_exports_status ON report_exports(status);
      CREATE INDEX IF NOT EXISTS idx_report_exports_created ON report_exports(created_at DESC);
    
      -- Integration health checks
      CREATE TABLE IF NOT EXISTS integration_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        integration_type TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER,
        error_message TEXT,
        checked_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_integration_health_type ON integration_health(integration_type);
      CREATE INDEX IF NOT EXISTS idx_integration_health_checked ON integration_health(checked_at DESC);
    
      -- Integration test results
      CREATE TABLE IF NOT EXISTS integration_tests (
        id TEXT PRIMARY KEY,
        integration_type TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        test_type TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload TEXT,
        response_data TEXT,
        error TEXT,
        latency_ms INTEGER,
        tested_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_integration_tests_type ON integration_tests(integration_type);
      CREATE INDEX IF NOT EXISTS idx_integration_tests_status ON integration_tests(status);
    
      -- GitHub issue links
      CREATE TABLE IF NOT EXISTS github_issues (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_url TEXT,
        title TEXT,
        state TEXT DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_github_issues_task ON github_issues(task_id);
      CREATE INDEX IF NOT EXISTS idx_github_issues_repo ON github_issues(repo);
    
      -- Email notifications log
      CREATE TABLE IF NOT EXISTS email_notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_notifications_task ON email_notifications(task_id);
      CREATE INDEX IF NOT EXISTS idx_email_notifications_status ON email_notifications(status);
    
      -- Provider configuration for multi-provider support
      CREATE TABLE IF NOT EXISTS provider_config (
        provider TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        cli_path TEXT,
        transport TEXT DEFAULT 'api',
        cli_args TEXT,
        quota_error_patterns TEXT,
        max_concurrent INTEGER DEFAULT 3,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        capability_tags TEXT DEFAULT '[]',
        quality_band TEXT DEFAULT 'C',
        max_retries INTEGER DEFAULT 2
      );
    `);
  try { rawDb.prepare("ALTER TABLE provider_config ADD COLUMN capability_tags TEXT DEFAULT '[]'").run(); } catch { /* column already exists */ }
  try { rawDb.prepare("ALTER TABLE provider_config ADD COLUMN quality_band TEXT DEFAULT 'C'").run(); } catch { /* column already exists */ }
  try { rawDb.prepare("ALTER TABLE provider_config ADD COLUMN max_retries INTEGER DEFAULT 2").run(); } catch { /* column already exists */ }
  db.exec(`

      -- Provider usage tracking
      CREATE TABLE IF NOT EXISTS provider_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        task_id TEXT,
        tokens_used INTEGER,
        cost_estimate REAL,
        duration_seconds INTEGER,
        elapsed_ms INTEGER,
        transport TEXT,
        retry_count INTEGER,
        failure_reason TEXT,
        success INTEGER,
        error_type TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_usage_provider ON provider_usage(provider);
      CREATE INDEX IF NOT EXISTS idx_provider_usage_task ON provider_usage(task_id);
      CREATE INDEX IF NOT EXISTS idx_provider_usage_recorded ON provider_usage(recorded_at);
    
      -- Smart routing rules for automatic provider selection
      CREATE TABLE IF NOT EXISTS routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        rule_type TEXT NOT NULL DEFAULT 'keyword',
        pattern TEXT NOT NULL,
        target_provider TEXT NOT NULL,
        priority INTEGER DEFAULT 50,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_routing_rules_type ON routing_rules(rule_type);
      CREATE INDEX IF NOT EXISTS idx_routing_rules_priority ON routing_rules(priority);

      -- Routing templates for provider selection strategies
      CREATE TABLE IF NOT EXISTS routing_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        rules_json TEXT NOT NULL,
        complexity_overrides_json TEXT,
        preset INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- ============================================
      -- Multi-Host Ollama Load Balancing
      -- ============================================
    
      -- Ollama host pool for load balancing
      CREATE TABLE IF NOT EXISTS ollama_hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 1,
        status TEXT DEFAULT 'unknown',
        consecutive_failures INTEGER DEFAULT 0,
        last_health_check TEXT,
        last_healthy TEXT,
        running_tasks INTEGER DEFAULT 0,
        models_cache TEXT,
        models_updated_at TEXT,
        default_model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ollama_hosts_enabled ON ollama_hosts(enabled);
      CREATE INDEX IF NOT EXISTS idx_ollama_hosts_status ON ollama_hosts(status);
    
      -- ============================================
      -- Output Quality Safeguards (LLM Quality Report)
      -- ============================================
    
      -- Validation rules for post-task output checking
      CREATE TABLE IF NOT EXISTS validation_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        rule_type TEXT NOT NULL DEFAULT 'pattern',
        pattern TEXT,
        condition TEXT,
        severity TEXT DEFAULT 'warning',
        enabled INTEGER DEFAULT 1,
        auto_fail INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_validation_rules_type ON validation_rules(rule_type);
      CREATE INDEX IF NOT EXISTS idx_validation_rules_enabled ON validation_rules(enabled);
    
      -- Validation results per task
      CREATE TABLE IF NOT EXISTS validation_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT,
        details TEXT,
        file_path TEXT,
        line_number INTEGER,
        validated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (rule_id) REFERENCES validation_rules(id)
      );
      CREATE INDEX IF NOT EXISTS idx_validation_results_task ON validation_results(task_id);
      CREATE INDEX IF NOT EXISTS idx_validation_results_status ON validation_results(status);
    
      -- Pending approvals queue
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_notes TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (rule_id) REFERENCES approval_rules(id)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_task ON pending_approvals(task_id);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status);
    
      -- Failure pattern matches (links failures to patterns)
      CREATE TABLE IF NOT EXISTS failure_matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        pattern_id TEXT NOT NULL,
        match_details TEXT,
        matched_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (pattern_id) REFERENCES failure_patterns(id)
      );
      CREATE INDEX IF NOT EXISTS idx_failure_matches_task ON failure_matches(task_id);
      CREATE INDEX IF NOT EXISTS idx_failure_matches_pattern ON failure_matches(pattern_id);
    
      -- Adaptive retry rules
      CREATE TABLE IF NOT EXISTS retry_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        trigger_type TEXT NOT NULL DEFAULT 'pattern',
        trigger_condition TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'retry_with_cloud',
        fallback_provider TEXT,
        max_retries INTEGER DEFAULT 1,
        retry_delay_seconds INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_retry_rules_trigger ON retry_rules(trigger_type);
      CREATE INDEX IF NOT EXISTS idx_retry_rules_enabled ON retry_rules(enabled);
    
      -- Retry attempts log
      CREATE TABLE IF NOT EXISTS retry_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        original_provider TEXT NOT NULL,
        retry_provider TEXT NOT NULL,
        rule_id TEXT,
        attempt_number INTEGER DEFAULT 1,
        trigger_reason TEXT,
        outcome TEXT,
        attempted_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (rule_id) REFERENCES retry_rules(id)
      );
      CREATE INDEX IF NOT EXISTS idx_retry_attempts_task ON retry_attempts(task_id);
      CREATE INDEX IF NOT EXISTS idx_retry_attempts_outcome ON retry_attempts(outcome);
    
      -- ============================================
      -- Advanced Safeguards
      -- ============================================
    
      -- File size baselines for truncation detection
      CREATE TABLE IF NOT EXISTS file_baselines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        line_count INTEGER,
        checksum TEXT,
        captured_at TEXT NOT NULL,
        task_id TEXT,
        UNIQUE(file_path, working_directory)
      );
      CREATE INDEX IF NOT EXISTS idx_file_baselines_path ON file_baselines(file_path);
      CREATE INDEX IF NOT EXISTS idx_file_baselines_dir ON file_baselines(working_directory);
    
      -- Syntax validators configuration
      CREATE TABLE IF NOT EXISTS syntax_validators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        file_extensions TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT,
        success_exit_codes TEXT DEFAULT '0',
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_syntax_validators_enabled ON syntax_validators(enabled);
    
      -- Diff preview requirements
      CREATE TABLE IF NOT EXISTS diff_previews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        diff_content TEXT NOT NULL,
        files_changed INTEGER DEFAULT 0,
        lines_added INTEGER DEFAULT 0,
        lines_removed INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        reviewed_at TEXT,
        reviewed_by TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_diff_previews_task ON diff_previews(task_id);
      CREATE INDEX IF NOT EXISTS idx_diff_previews_status ON diff_previews(status);
    
      -- Quality scores per task
      CREATE TABLE IF NOT EXISTS quality_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        task_type TEXT,
        overall_score REAL NOT NULL,
        validation_score REAL,
        syntax_score REAL,
        completeness_score REAL,
        metrics TEXT,
        scored_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_quality_scores_task ON quality_scores(task_id);
      CREATE INDEX IF NOT EXISTS idx_quality_scores_provider ON quality_scores(provider);
    
      -- Provider success statistics per task type
      CREATE TABLE IF NOT EXISTS provider_task_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        task_type TEXT NOT NULL,
        total_tasks INTEGER DEFAULT 0,
        successful_tasks INTEGER DEFAULT 0,
        failed_tasks INTEGER DEFAULT 0,
        avg_quality_score REAL,
        avg_duration_seconds REAL,
        last_updated TEXT NOT NULL,
        UNIQUE(provider, task_type)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_stats_provider ON provider_task_stats(provider);
      CREATE INDEX IF NOT EXISTS idx_provider_stats_type ON provider_task_stats(task_type);

      CREATE TABLE IF NOT EXISTS provider_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        task_type TEXT NOT NULL,
        window_start TEXT NOT NULL,
        total_tasks INTEGER DEFAULT 0,
        successful_tasks INTEGER DEFAULT 0,
        failed_tasks INTEGER DEFAULT 0,
        resubmitted_tasks INTEGER DEFAULT 0,
        avg_duration_seconds REAL DEFAULT 0,
        auto_check_pass_rate REAL DEFAULT 0,
        updated_at TEXT,
        UNIQUE(provider, task_type, window_start)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_performance_provider ON provider_performance(provider);
      CREATE INDEX IF NOT EXISTS idx_provider_performance_window ON provider_performance(window_start);
    
      -- Task rollback history
      CREATE TABLE IF NOT EXISTS task_rollbacks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        rollback_type TEXT NOT NULL DEFAULT 'git',
        files_affected TEXT,
        commit_before TEXT,
        commit_after TEXT,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        initiated_at TEXT NOT NULL,
        completed_at TEXT,
        initiated_by TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_rollbacks_task ON task_rollbacks(task_id);
      CREATE INDEX IF NOT EXISTS idx_rollbacks_status ON task_rollbacks(status);
    
      -- Build/compile check results
      CREATE TABLE IF NOT EXISTS build_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        build_command TEXT NOT NULL,
        working_directory TEXT,
        exit_code INTEGER,
        output TEXT,
        error_output TEXT,
        duration_seconds REAL,
        status TEXT DEFAULT 'pending',
        checked_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_build_checks_task ON build_checks(task_id);
      CREATE INDEX IF NOT EXISTS idx_build_checks_status ON build_checks(status);
    
      -- ============================================
      -- Extended Safeguards
      -- ============================================
    
      -- Rate limit events log
      CREATE TABLE IF NOT EXISTS rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        task_id TEXT,
        event_type TEXT NOT NULL,
        current_value INTEGER,
        max_value INTEGER,
        event_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_events_provider ON rate_limit_events(provider);
    
      -- Cost tracking per provider
      CREATE TABLE IF NOT EXISTS cost_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        task_id TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        model TEXT,
        tracked_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_cost_tracking_provider ON cost_tracking(provider);
      CREATE INDEX IF NOT EXISTS idx_cost_tracking_task ON cost_tracking(task_id);
      CREATE INDEX IF NOT EXISTS idx_cost_tracking_tracked ON cost_tracking(provider, tracked_at);

      CREATE TABLE IF NOT EXISTS provider_scores (
        provider TEXT PRIMARY KEY,
        cost_efficiency REAL DEFAULT 0,
        speed_score REAL DEFAULT 0,
        reliability_score REAL DEFAULT 0,
        quality_score REAL DEFAULT 0,
        composite_score REAL DEFAULT 0,
        sample_count INTEGER DEFAULT 0,
        total_tasks INTEGER DEFAULT 0,
        total_successes INTEGER DEFAULT 0,
        total_failures INTEGER DEFAULT 0,
        avg_duration_ms REAL DEFAULT 0,
        avg_cost_usd REAL DEFAULT 0,
        last_updated TEXT,
        trusted INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_provider_scores_composite ON provider_scores(composite_score DESC);
      CREATE INDEX IF NOT EXISTS idx_provider_scores_trusted ON provider_scores(trusted, composite_score DESC);
    
      -- Cost budgets and alerts
      CREATE TABLE IF NOT EXISTS cost_budgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider TEXT,
        budget_usd REAL NOT NULL,
        period TEXT NOT NULL DEFAULT 'monthly',
        current_spend REAL DEFAULT 0,
        alert_threshold_percent INTEGER DEFAULT 80,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        reset_at TEXT
      );
    
      -- Task fingerprints for duplicate detection
      CREATE TABLE IF NOT EXISTS task_fingerprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        task_description TEXT NOT NULL,
        working_directory TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_fingerprints_hash ON task_fingerprints(fingerprint);
    
      -- File locks for concurrent modification protection
      CREATE TABLE IF NOT EXISTS file_locks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lock_type TEXT NOT NULL DEFAULT 'exclusive',
        acquired_at TEXT NOT NULL,
        expires_at TEXT,
        released_at TEXT,
        UNIQUE(file_path, working_directory, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_file_locks_path ON file_locks(file_path, working_directory);
      CREATE INDEX IF NOT EXISTS idx_file_locks_task ON file_locks(task_id);
    
      -- File backups before modification
      CREATE TABLE IF NOT EXISTS file_backups (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        original_content TEXT,
        original_size INTEGER,
        backup_path TEXT,
        created_at TEXT NOT NULL,
        restored_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_backups_task ON file_backups(task_id);
      CREATE INDEX IF NOT EXISTS idx_backups_file ON file_backups(file_path);
    
      -- Security scan results
      CREATE TABLE IF NOT EXISTS security_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT,
        scan_type TEXT NOT NULL DEFAULT 'static',
        severity TEXT,
        issue_type TEXT,
        description TEXT,
        line_number INTEGER,
        code_snippet TEXT,
        recommendation TEXT,
        scanned_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_security_scans_task ON security_scans(task_id);
      CREATE INDEX IF NOT EXISTS idx_security_scans_severity ON security_scans(severity);
    
      -- Security rules/patterns
      CREATE TABLE IF NOT EXISTS security_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        pattern TEXT NOT NULL,
        file_extensions TEXT,
        severity TEXT DEFAULT 'warning',
        category TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
    
      -- Test coverage tracking
      CREATE TABLE IF NOT EXISTS test_coverage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        has_test_file INTEGER DEFAULT 0,
        test_file_path TEXT,
        coverage_percent REAL,
        lines_covered INTEGER,
        lines_total INTEGER,
        checked_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_coverage_task ON test_coverage(task_id);
    
      -- Code style check results
      CREATE TABLE IF NOT EXISTS style_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        linter TEXT NOT NULL,
        issue_count INTEGER DEFAULT 0,
        issues TEXT,
        auto_fixed INTEGER DEFAULT 0,
        checked_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_style_checks_task ON style_checks(task_id);
    
      -- Linter configurations
      CREATE TABLE IF NOT EXISTS linter_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        file_extensions TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT,
        fix_args TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
    
      -- Change impact analysis
      CREATE TABLE IF NOT EXISTS change_impacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        changed_file TEXT NOT NULL,
        impacted_file TEXT NOT NULL,
        impact_type TEXT NOT NULL,
        confidence REAL,
        details TEXT,
        analyzed_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_impacts_task ON change_impacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_impacts_file ON change_impacts(changed_file);
    
      -- Task timeout alerts
      CREATE TABLE IF NOT EXISTS timeout_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        expected_duration_seconds INTEGER,
        actual_duration_seconds INTEGER,
        alert_type TEXT NOT NULL DEFAULT 'warning',
        notified INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_timeout_alerts_task ON timeout_alerts(task_id);
    
      -- Output size tracking
      CREATE TABLE IF NOT EXISTS output_limits (
        id TEXT PRIMARY KEY,
        provider TEXT,
        task_type TEXT,
        max_output_bytes INTEGER NOT NULL DEFAULT 1048576,
        max_file_size_bytes INTEGER NOT NULL DEFAULT 524288,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
    
      -- Output size violations
      CREATE TABLE IF NOT EXISTS output_violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        violation_type TEXT NOT NULL,
        actual_size INTEGER,
        max_allowed INTEGER,
        file_path TEXT,
        action_taken TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_violations_task ON output_violations(task_id);
    
      -- Comprehensive audit trail
      CREATE TABLE IF NOT EXISTS audit_trail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT,
        old_value TEXT,
        new_value TEXT,
        metadata TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_trail(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_trail(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_trail(created_at);
    `);
  db.prepare(`
      CREATE TABLE IF NOT EXISTS vulnerability_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        package_manager TEXT NOT NULL,
        scan_output TEXT,
        vulnerabilities_found INTEGER DEFAULT 0,
        critical_count INTEGER DEFAULT 0,
        high_count INTEGER DEFAULT 0,
        medium_count INTEGER DEFAULT 0,
        low_count INTEGER DEFAULT 0,
        scanned_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_vuln_task ON vulnerability_scans(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS complexity_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        cyclomatic_complexity INTEGER,
        cognitive_complexity INTEGER,
        lines_of_code INTEGER,
        function_count INTEGER,
        max_nesting_depth INTEGER,
        maintainability_index REAL,
        analyzed_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_complexity_task ON complexity_metrics(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS dead_code_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        dead_code_type TEXT NOT NULL,
        identifier TEXT NOT NULL,
        line_number INTEGER,
        confidence REAL DEFAULT 1.0,
        detected_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_deadcode_task ON dead_code_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS api_contract_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        contract_file TEXT NOT NULL,
        validation_type TEXT NOT NULL,
        is_valid INTEGER DEFAULT 1,
        breaking_changes TEXT,
        warnings TEXT,
        validated_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_task ON api_contract_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS doc_coverage_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        total_public_items INTEGER DEFAULT 0,
        documented_items INTEGER DEFAULT 0,
        coverage_percent REAL DEFAULT 0,
        missing_docs TEXT,
        analyzed_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_task ON doc_coverage_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS regression_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        test_command TEXT,
        tests_before INTEGER,
        tests_after INTEGER,
        passed_before INTEGER,
        passed_after INTEGER,
        failed_before INTEGER,
        failed_after INTEGER,
        new_failures TEXT,
        detected_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_regression_task ON regression_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS config_drift_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        drift_type TEXT NOT NULL,
        old_hash TEXT,
        new_hash TEXT,
        changes_summary TEXT,
        detected_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_drift_task ON config_drift_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS config_baselines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        working_directory TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        content TEXT,
        captured_at TEXT NOT NULL,
        UNIQUE(working_directory, file_path)
      )
    `).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS resource_estimates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        estimated_memory_mb REAL,
        estimated_cpu_score REAL,
        has_infinite_loop_risk INTEGER DEFAULT 0,
        has_memory_leak_risk INTEGER DEFAULT 0,
        has_blocking_io INTEGER DEFAULT 0,
        risk_factors TEXT,
        estimated_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_resource_task ON resource_estimates(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS i18n_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hardcoded_strings_count INTEGER DEFAULT 0,
        hardcoded_strings TEXT,
        missing_translations TEXT,
        checked_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_i18n_task ON i18n_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS a11y_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        violations_count INTEGER DEFAULT 0,
        violations TEXT,
        wcag_level TEXT,
        checked_at TEXT NOT NULL
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_a11y_task ON a11y_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS expected_output_paths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        expected_directory TEXT NOT NULL,
        allow_subdirs INTEGER DEFAULT 1,
        file_patterns TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_expected_paths_task ON expected_output_paths(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS file_location_anomalies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        anomaly_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        expected_directory TEXT,
        actual_directory TEXT,
        severity TEXT DEFAULT 'warning',
        details TEXT,
        resolved INTEGER DEFAULT 0,
        detected_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_location_anomaly_task ON file_location_anomalies(task_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_location_anomaly_type ON file_location_anomalies(anomaly_type)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS duplicate_file_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        locations TEXT NOT NULL,
        location_count INTEGER NOT NULL,
        severity TEXT DEFAULT 'warning',
        likely_correct_path TEXT,
        details TEXT,
        resolved INTEGER DEFAULT 0,
        detected_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_duplicate_task ON duplicate_file_detections(task_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_duplicate_filename ON duplicate_file_detections(file_name)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS type_verification_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        type_name TEXT NOT NULL,
        type_kind TEXT NOT NULL,
        exists_in_codebase INTEGER DEFAULT 0,
        found_in_file TEXT,
        severity TEXT DEFAULT 'error',
        details TEXT,
        verified_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_type_verify_task ON type_verification_results(task_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_type_verify_exists ON type_verification_results(exists_in_codebase)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS build_error_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        error_code TEXT NOT NULL,
        error_type TEXT NOT NULL,
        file_path TEXT,
        line_number INTEGER,
        message TEXT NOT NULL,
        suggested_fix TEXT,
        auto_fixable INTEGER DEFAULT 0,
        fixed INTEGER DEFAULT 0,
        analyzed_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_build_error_task ON build_error_analysis(task_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_build_error_code ON build_error_analysis(error_code)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS similar_file_search (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        search_term TEXT NOT NULL,
        search_type TEXT NOT NULL,
        matches_found INTEGER DEFAULT 0,
        match_files TEXT,
        recommendation TEXT,
        searched_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_similar_search_task ON similar_file_search(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS task_complexity_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        creates_file INTEGER DEFAULT 0,
        implements_interface INTEGER DEFAULT 0,
        method_count INTEGER DEFAULT 0,
        involves_xaml INTEGER DEFAULT 0,
        modifies_lines INTEGER DEFAULT 0,
        total_score INTEGER DEFAULT 0,
        recommended_provider TEXT,
        scored_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_complexity_score_task ON task_complexity_scores(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS auto_rollbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        trigger_reason TEXT NOT NULL,
        files_rolled_back TEXT NOT NULL,
        rollback_commit TEXT,
        success INTEGER DEFAULT 0,
        error_message TEXT,
        rolled_back_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_rollback_task ON auto_rollbacks(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS xaml_validation_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        issue_type TEXT NOT NULL,
        severity TEXT DEFAULT 'error',
        line_number INTEGER,
        column_number INTEGER,
        code_snippet TEXT,
        message TEXT NOT NULL,
        suggested_fix TEXT,
        validated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_xaml_valid_task ON xaml_validation_results(task_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_xaml_valid_type ON xaml_validation_results(issue_type)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS xaml_consistency_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        xaml_file TEXT NOT NULL,
        codebehind_file TEXT NOT NULL,
        issue_type TEXT NOT NULL,
        element_name TEXT,
        severity TEXT DEFAULT 'error',
        message TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_xaml_consist_task ON xaml_consistency_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS smoke_test_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        test_type TEXT NOT NULL,
        working_directory TEXT,
        command TEXT,
        exit_code INTEGER,
        startup_time_ms INTEGER,
        passed INTEGER DEFAULT 0,
        error_output TEXT,
        tested_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_smoke_test_task ON smoke_test_results(task_id)`).run();
  db.prepare(`
      CREATE TABLE IF NOT EXISTS safeguard_tool_config (
        id TEXT PRIMARY KEY,
        safeguard_type TEXT NOT NULL,
        language TEXT,
        tool_name TEXT NOT NULL,
        tool_command TEXT NOT NULL,
        tool_args TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `).run();
  try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_provider_usage_transport ON provider_usage(transport);
        CREATE INDEX IF NOT EXISTS idx_provider_usage_failure_reason ON provider_usage(failure_reason);
      `);
    } catch {
      // Ignore transient compatibility issues when upgrading very old schema variants.
    }
  db.exec(`
      CREATE TABLE IF NOT EXISTS complexity_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        complexity TEXT NOT NULL UNIQUE,
        target_provider TEXT NOT NULL,
        target_host TEXT,
        model TEXT,
        priority INTEGER DEFAULT 10,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
  db.exec(`CREATE TABLE IF NOT EXISTS model_capabilities (
      model_name TEXT PRIMARY KEY,
      score_code_gen REAL DEFAULT 0.5,
      score_refactoring REAL DEFAULT 0.5,
      score_testing REAL DEFAULT 0.5,
      score_reasoning REAL DEFAULT 0.5,
      score_docs REAL DEFAULT 0.5,
      lang_typescript REAL DEFAULT 0.5,
      lang_javascript REAL DEFAULT 0.5,
      lang_python REAL DEFAULT 0.5,
      lang_csharp REAL DEFAULT 0.5,
      lang_go REAL DEFAULT 0.5,
      lang_rust REAL DEFAULT 0.5,
      lang_general REAL DEFAULT 0.5,
      context_window INTEGER DEFAULT 8192,
      param_size_b REAL DEFAULT 0,
      is_thinking_model INTEGER DEFAULT 0,
      source TEXT DEFAULT 'benchmark',
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`
      CREATE TABLE IF NOT EXISTS model_task_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT NOT NULL,
        task_type TEXT NOT NULL,
        language TEXT,
        success INTEGER NOT NULL DEFAULT 0,
        duration_s REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_model_outcomes_model_type
        ON model_task_outcomes(model_name, task_type, created_at)`);
    } catch (e) { logger.debug(`Schema migration (model outcomes index): ${e.message}`); }
  db.exec(`
      CREATE TABLE IF NOT EXISTS remote_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 3460,
        secret TEXT NOT NULL,
        status TEXT DEFAULT 'unknown',
        consecutive_failures INTEGER DEFAULT 0,
        max_concurrent INTEGER DEFAULT 3,
        last_health_check TEXT,
        last_healthy TEXT,
        metrics TEXT,
        tls INTEGER DEFAULT 0,
        rejectUnauthorized INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        enabled INTEGER DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_remote_agents_status ON remote_agents(status);
      CREATE INDEX IF NOT EXISTS idx_remote_agents_enabled ON remote_agents(enabled);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS provider_rate_limits (
        provider TEXT PRIMARY KEY,
        is_free_tier INTEGER DEFAULT 1,
        rpm_limit INTEGER,
        rpd_limit INTEGER,
        tpm_limit INTEGER,
        tpd_limit INTEGER,
        daily_reset_hour INTEGER DEFAULT 0,
        daily_reset_tz TEXT DEFAULT 'UTC',
        retry_after_until TEXT,
        last_updated TEXT,
        created_at TEXT NOT NULL
      )
    `);
  try {
    db.exec(`ALTER TABLE coordination_events ADD COLUMN lock_key TEXT`);
  } catch (e) {
    if (!e.message || !e.message.includes('duplicate column')) {
      logger.debug(`Schema migration (coordination_events lock_key): ${e.message}`);
    }
  }
  try {
    db.exec(`ALTER TABLE coordination_events ADD COLUMN heartbeat_at TEXT`);
  } catch (e) {
    if (!e.message || !e.message.includes('duplicate column')) {
      logger.debug(`Schema migration (coordination_events heartbeat_at): ${e.message}`);
    }
  }
  try {
    db.exec(`ALTER TABLE rate_limits ADD COLUMN provider TEXT`);
  } catch (e) {
    if (!e.message || !e.message.includes('duplicate column')) {
      logger.debug(`Schema migration (rate_limits provider): ${e.message}`);
    }
  }
  try {
    db.exec(`ALTER TABLE rate_limits ADD COLUMN enabled INTEGER DEFAULT 1`);
  } catch (e) {
    if (!e.message || !e.message.includes('duplicate column')) {
      logger.debug(`Schema migration (rate_limits enabled): ${e.message}`);
    }
  }
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_claims_task_status ON task_claims(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_claims_claimed_at ON task_claims(claimed_at);
      CREATE INDEX IF NOT EXISTS idx_cost_budgets_provider ON cost_budgets(provider, enabled);
      CREATE INDEX IF NOT EXISTS idx_agent_group_members_group ON agent_group_members(group_id);
      CREATE INDEX IF NOT EXISTS idx_rate_limits_provider ON rate_limits(provider);
      CREATE INDEX IF NOT EXISTS idx_coordination_events_lock ON coordination_events(lock_key, heartbeat_at);
      CREATE INDEX IF NOT EXISTS idx_task_cache_expires ON task_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_query_stats_pattern ON query_stats(query_pattern);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS refactor_hotspots (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        complexity_score REAL DEFAULT 0,
        change_frequency INTEGER DEFAULT 0,
        last_worsened_at TEXT,
        trend TEXT DEFAULT 'stable' CHECK(trend IN ('improving', 'stable', 'worsening')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_refactor_hotspots_project ON refactor_hotspots(project);
      CREATE INDEX IF NOT EXISTS idx_refactor_hotspots_trend ON refactor_hotspots(trend);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS refactor_backlog_items (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hotspot_id TEXT,
        description TEXT,
        status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'deferred')),
        priority INTEGER DEFAULT 0,
        task_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (hotspot_id) REFERENCES refactor_hotspots(id)
      );
      CREATE INDEX IF NOT EXISTS idx_refactor_backlog_project ON refactor_backlog_items(project);
      CREATE INDEX IF NOT EXISTS idx_refactor_backlog_status ON refactor_backlog_items(status);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS architecture_boundaries (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        name TEXT NOT NULL,
        boundary_type TEXT NOT NULL CHECK(boundary_type IN ('layer', 'module', 'package')),
        source_patterns TEXT NOT NULL DEFAULT '[]',
        allowed_dependencies TEXT NOT NULL DEFAULT '[]',
        forbidden_dependencies TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_arch_boundaries_project ON architecture_boundaries(project);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS architecture_violations (
        id TEXT PRIMARY KEY,
        evaluation_id TEXT,
        boundary_id TEXT,
        source_file TEXT NOT NULL,
        imported_file TEXT NOT NULL,
        violation_type TEXT DEFAULT 'forbidden_import',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (boundary_id) REFERENCES architecture_boundaries(id),
        FOREIGN KEY (evaluation_id) REFERENCES policy_evaluations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_arch_violations_evaluation ON architecture_violations(evaluation_id);
      CREATE INDEX IF NOT EXISTS idx_arch_violations_boundary ON architecture_violations(boundary_id);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        version TEXT,
        status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'gating', 'released', 'rolled_back')),
        policy_summary TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_releases_project ON releases(project);
      CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS release_gates (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        release_id TEXT,
        name TEXT NOT NULL,
        gate_type TEXT NOT NULL CHECK(gate_type IN ('policy_aggregate', 'test_coverage', 'approval_count', 'manual_sign_off')),
        threshold TEXT DEFAULT '{}',
        status TEXT DEFAULT 'open' CHECK(status IN ('open', 'passed', 'failed', 'bypassed')),
        evaluated_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id)
      );
      CREATE INDEX IF NOT EXISTS idx_release_gates_release ON release_gates(release_id);
      CREATE INDEX IF NOT EXISTS idx_release_gates_status ON release_gates(status);
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS feature_flag_evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        file_path TEXT NOT NULL,
        flag_name TEXT,
        flag_type TEXT DEFAULT 'unknown',
        detected_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_feature_flags_task ON feature_flag_evidence(task_id);
    `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_proof_audit (
      id INTEGER PRIMARY KEY,
      surface TEXT NOT NULL,
      proof_hash TEXT,
      policy_family TEXT,
      decision TEXT CHECK(decision IN ('allow', 'deny', 'warn')),
      context_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_policy_proof_audit_surface ON policy_proof_audit(surface);
    CREATE INDEX IF NOT EXISTS idx_policy_proof_audit_task ON policy_proof_audit(policy_family);
    CREATE INDEX IF NOT EXISTS idx_policy_proof_audit_created ON policy_proof_audit(created_at);
  `);
  ensureTableColumns(db, 'policy_proof_audit', [
    'proof_hash TEXT',
    'policy_family TEXT',
    'decision TEXT',
    'context_json TEXT',
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP',
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS peek_fixture_catalog (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      app_type TEXT NOT NULL,
      fixture_data TEXT NOT NULL,
      frozen INTEGER DEFAULT 0,
      parent_fixture_id INTEGER NULL REFERENCES peek_fixture_catalog(id),
      version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_peek_fixture_catalog_app_type ON peek_fixture_catalog(app_type);
    CREATE INDEX IF NOT EXISTS idx_peek_fixture_catalog_name ON peek_fixture_catalog(name);
    CREATE INDEX IF NOT EXISTS idx_peek_fixture_catalog_parent_fixture_id ON peek_fixture_catalog(parent_fixture_id);
  `);
  const packRegistryExists = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'pack_registry'
  `).get();
  if (!packRegistryExists) {
    db.exec(`
      CREATE TABLE pack_registry (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        app_type TEXT,
        author TEXT,
        signature TEXT,
        signature_verified INTEGER DEFAULT 0,
        deprecated INTEGER DEFAULT 0,
        deprecation_reason TEXT,
        sunset_date TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pack_registry_name ON pack_registry(name);
    CREATE INDEX IF NOT EXISTS idx_pack_registry_app_type ON pack_registry(app_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_registry_name_version ON pack_registry(name, version);
    CREATE INDEX IF NOT EXISTS idx_pack_registry_deprecated ON pack_registry(deprecated);
  `);
  ensureTableColumns(db, 'pack_registry', [
    'signature_verified INTEGER DEFAULT 0',
    'description TEXT',
    'metadata_json TEXT',
    "signature_algorithm TEXT DEFAULT 'sha256'",
    'maintainer TEXT',
    'owner TEXT',
    'successor_pack_id INTEGER REFERENCES pack_registry(id)',
    "version_history_json TEXT DEFAULT '[]'",
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS peek_recovery_approvals (
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      task_id TEXT,
      requested_by TEXT,
      approved_by TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
      requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_peek_recovery_approvals_action_task
      ON peek_recovery_approvals(action, task_id);
    CREATE INDEX IF NOT EXISTS idx_peek_recovery_approvals_status
      ON peek_recovery_approvals(status);
    CREATE INDEX IF NOT EXISTS idx_peek_recovery_approvals_requested_at
      ON peek_recovery_approvals(requested_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_metrics (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      app_type TEXT,
      risk_level TEXT,
      mode TEXT NOT NULL,
      success INTEGER NOT NULL,
      duration_ms INTEGER,
      attempts INTEGER DEFAULT 1,
      error TEXT,
      host TEXT,
      policy_blocked INTEGER DEFAULT 0,
      approval_required INTEGER DEFAULT 0,
      approval_granted INTEGER DEFAULT 0,
      evidence_quality_score INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_metrics_action ON recovery_metrics(action);
      CREATE INDEX IF NOT EXISTS idx_recovery_metrics_success ON recovery_metrics(success);
      CREATE INDEX IF NOT EXISTS idx_recovery_metrics_created ON recovery_metrics(created_at);
      CREATE INDEX IF NOT EXISTS idx_recovery_metrics_risk ON recovery_metrics(risk_level);
    `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_runs (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      categories TEXT NOT NULL,
      provider TEXT,
      workflow_id TEXT,
      total_files INTEGER DEFAULT 0,
      files_scanned INTEGER DEFAULT 0,
      files_skipped INTEGER DEFAULT 0,
      total_findings INTEGER DEFAULT 0,
      parse_failures INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_runs_project_path ON audit_runs(project_path);
    CREATE INDEX IF NOT EXISTS idx_audit_runs_status ON audit_runs(status);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_findings (
      id TEXT PRIMARY KEY,
      audit_run_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      category TEXT NOT NULL,
      subcategory TEXT,
      severity TEXT NOT NULL,
      confidence TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      suggestion TEXT,
      snippet TEXT,
      snippet_hash TEXT,
      provider TEXT,
      model TEXT,
      task_id TEXT,
      verified INTEGER DEFAULT 0,
      false_positive INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_findings_audit_run_id ON audit_findings(audit_run_id);
    CREATE INDEX IF NOT EXISTS idx_audit_findings_category ON audit_findings(category);
    CREATE INDEX IF NOT EXISTS idx_audit_findings_severity ON audit_findings(severity);
    CREATE INDEX IF NOT EXISTS idx_audit_findings_file_path ON audit_findings(file_path);
  `);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ci_watches (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'github-actions',
        branch TEXT,
        poll_interval_ms INTEGER DEFAULT 30000,
        last_checked_at TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(repo, provider)
      );
    `);
  } catch (e) {
    logger.debug(`Schema migration (ci_watches): ${e.message}`);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ci_run_cache (
        run_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'github-actions',
        status TEXT,
        conclusion TEXT,
        commit_sha TEXT,
        branch TEXT,
        jobs_json TEXT,
        failures_json TEXT,
        triage_json TEXT,
        diagnosed_at TEXT,
        duration_ms INTEGER,
        url TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, provider)
      );
    `);
  } catch (e) {
    logger.debug(`Schema migration (ci_run_cache table): ${e.message}`);
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_run_cache_branch ON ci_run_cache(repo, branch)`);
  } catch (e) {
    logger.debug(`Schema migration (idx_ci_run_cache_branch): ${e.message}`);
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_run_cache_sha ON ci_run_cache(commit_sha)`);
  } catch (e) {
    logger.debug(`Schema migration (idx_ci_run_cache_sha): ${e.message}`);
  }

  // Auth: API keys table for HMAC-hashed key storage
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)');
  } catch (e) {
    logger.debug(`Schema migration (api_keys table): ${e.message}`);
  }

  // Users table (username/password auth)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      last_login_at TEXT
    )
  `);

  // Verification checks table for storing verification stage outcomes
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        workflow_id TEXT,
        phase TEXT NOT NULL,
        check_name TEXT NOT NULL,
        tool TEXT,
        command TEXT,
        exit_code INTEGER,
        output_snippet TEXT,
        passed INTEGER NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_verif_checks_task ON verification_checks(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_verif_checks_phase ON verification_checks(phase)');
  } catch (e) {
    logger.debug(`Schema migration (verification_checks): ${e.message}`);
  }

  // Adversarial review table for secondary provider review outcomes
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS adversarial_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        review_task_id TEXT,
        reviewer_provider TEXT NOT NULL,
        reviewer_model TEXT,
        verdict TEXT,
        confidence TEXT,
        issues TEXT,
        diff_snippet TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_adv_reviews_task ON adversarial_reviews(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_adv_reviews_verdict ON adversarial_reviews(verdict)');
  } catch (e) {
    logger.debug(`Schema migration (adversarial_reviews): ${e.message}`);
  }

  // File risk scoring table for file-level evidence scoring
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_reasons TEXT NOT NULL,
        auto_scored INTEGER NOT NULL DEFAULT 1,
        scored_at TEXT NOT NULL,
        scored_by TEXT,
        UNIQUE(file_path, working_directory)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_risk_scores_level ON file_risk_scores(risk_level)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_risk_scores_path ON file_risk_scores(file_path)');
  } catch (e) {
    logger.debug(`Schema migration (file_risk_scores): ${e.message}`);
  }

  // Add user ownership to API keys (nullable FK)
  try {
    db.exec('ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id)');
  } catch {
    // Column already exists — ignore
  }

  // Cascade-delete user's API keys when user is deleted
  // (SQLite doesn't enforce ON DELETE CASCADE for ALTER TABLE columns)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_user_delete_keys
    AFTER DELETE ON users
    FOR EACH ROW
    BEGIN
      DELETE FROM api_keys WHERE user_id = OLD.id;
    END
  `);

  const peekFixtureCatalog = require('./peek-fixture-catalog');
  peekFixtureCatalog.setDb(db);
  peekFixtureCatalog.seedDefaultFixtures();
}

const ensureAllTables = createTables;

module.exports = { createTables, ensureAllTables, ensureAuditLogChainColumns, ensureTableColumns };
