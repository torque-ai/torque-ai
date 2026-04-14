/**
 * Tests for server/db/schema.js — applySchema()
 *
 * Validates table creation, index creation, config seeding,
 * migration safety (idempotency), column constraints, and defaults.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

let testDir;
let db;
let rawDb;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-schema-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  rawDb = new Database(':memory:');
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');

  // Provide helpers expected by applySchema
  const helpers = {
    safeAddColumn: (table, colDef) => {
      try {
        rawDb.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch (e) {
        if (!e.message.includes('duplicate column')) {
          // ignore
        }
      }
    },
    getConfig: (key) => {
      try {
        const row = rawDb.prepare('SELECT value FROM config WHERE key = ?').get(key);
        return row ? row.value : null;
      } catch { return null; }
    },
    setConfig: (key, value) => {
      try {
        rawDb.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
      } catch { /* ignore */ }
    },
    setConfigDefault: (key, value) => {
      try {
        rawDb.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
      } catch { /* ignore */ }
    },
    DATA_DIR: testDir,
  };

  const { applySchema } = require('../db/schema');
  applySchema(rawDb, helpers);

  db = rawDb;
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

function tableExists(name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

function indexExists(name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
  return !!row;
}

function getTableColumns(tableName) {
  return db.prepare(`PRAGMA table_info("${tableName}")`).all();
}

function getColumnByName(tableName, colName) {
  return getTableColumns(tableName).find(c => c.name === colName);
}

function getTableNames() {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name);
}

function getIndexNames() {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name);
}

describe('db/schema.js — applySchema', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  // ====================================================
  // Table creation verification
  // ====================================================
  describe('table creation', () => {
    const expectedTables = [
      'tasks', 'plan_projects', 'plan_project_tasks', 'templates',
      'analytics', 'pipelines', 'pipeline_steps', 'health_status',
      'scheduled_tasks', 'config', 'distributed_locks', 'archived_tasks',
      'token_usage', 'project_config', 'project_metadata',
      'policy_profiles', 'policy_rules', 'policy_bindings', 'policy_evaluations', 'policy_overrides',
      'auth_configs', 'connected_accounts',
      'webhooks',
      'webhook_logs', 'retry_history', 'budget_alerts', 'maintenance_schedule',
      'task_file_changes', 'task_file_writes', 'success_metrics', 'format_success_rates',
      'task_groups', 'task_streams', 'stream_chunks', 'task_checkpoints',
      'task_event_subscriptions', 'task_events', 'task_suggestions',
      'similar_tasks', 'task_patterns', 'approval_rules', 'approval_requests',
      'task_comments', 'audit_log', 'audit_config', 'resource_usage',
      'resource_limits', 'bulk_operations', 'duration_predictions',
      'prediction_models', 'task_artifacts', 'artifact_config', 'run_artifacts',
      'task_breakpoints', 'debug_sessions', 'debug_captures',
      'workflows', 'task_dependencies', 'workflow_templates',
      'task_cache', 'task_priority_scores', 'failure_patterns',
      'intelligence_log', 'strategy_experiments', 'cache_config',
      'priority_config', 'adaptive_retry_rules', 'agents', 'agent_groups',
      'agent_group_members', 'task_claims', 'task_routing_rules',
      'agent_metrics', 'work_stealing_log', 'coordination_events',
      'failover_config', 'template_conditions', 'task_replays',
      'rate_limits', 'task_quotas', 'integration_config',
      'notification_templates', 'workflow_forks', 'query_stats',
      'cache_stats', 'optimization_history', 'performance_alerts',
      'validation_rules', 'validation_results', 'pending_approvals',
      'failure_matches', 'retry_rules', 'retry_attempts',
      'file_baselines', 'syntax_validators', 'diff_previews',
      'quality_scores', 'provider_task_stats', 'task_rollbacks',
      'build_checks', 'rate_limit_events', 'cost_tracking',
      'cost_budgets', 'task_fingerprints', 'file_locks', 'file_backups',
      'security_scans', 'security_rules', 'test_coverage', 'style_checks',
      'linter_configs', 'change_impacts', 'timeout_alerts', 'output_limits',
      'output_violations', 'report_exports', 'integration_health',
      'integration_tests', 'github_issues', 'email_notifications',
      'provider_config', 'provider_usage', 'routing_rules', 'ollama_hosts',
      'factory_loop_instances',
      'complexity_routing',
    ];

    it.each(expectedTables)('creates table "%s"', (tableName) => {
      expect(tableExists(tableName)).toBe(true);
    });

    it('creates a duplicate-free table set', () => {
      const tables = getTableNames();
      expect(new Set(tables).size).toBe(tables.length);
    });
  });

  // ====================================================
  // Index creation verification
  // ====================================================
  describe('index creation', () => {
    const expectedIndexes = [
      'idx_tasks_status', 'idx_tasks_created', 'idx_tasks_priority',
      'idx_tasks_status_priority', 'idx_analytics_event', 'idx_analytics_timestamp',
      'idx_analytics_task', 'idx_pipeline_steps', 'idx_tasks_tags',
      'idx_plan_projects_status', 'idx_plan_projects_created_at',
      'idx_plan_project_tasks_project', 'idx_plan_project_tasks_task',
      'idx_health_status_type', 'idx_health_checked_at',
      'idx_scheduled_next_run', 'idx_scheduled_status',
      'idx_token_task', 'idx_token_recorded',
      'idx_conn_accounts_user_toolkit', 'idx_conn_accounts_status',
      'idx_tasks_project', 'idx_budget_alerts_project',
      'idx_file_changes_task', 'idx_task_file_writes_task', 'idx_task_file_writes_workflow_file', 'idx_retry_history_task',
      'idx_policy_profiles_project', 'idx_policy_rules_stage', 'idx_policy_bindings_profile',
      'idx_policy_bindings_policy', 'idx_policy_evals_target', 'idx_policy_evals_policy',
      'idx_policy_evals_scope', 'idx_policy_overrides_eval', 'idx_policy_overrides_policy',
      'idx_policy_overrides_policy_id', 'idx_policy_overrides_created',
      'idx_webhook_logs_webhook', 'idx_webhook_logs_event',
      'idx_success_metrics_period', 'idx_format_success_model',
      'idx_task_groups_project', 'idx_tasks_group',
      'idx_task_streams_task', 'idx_stream_chunks_stream',
      'idx_task_event_subs_task', 'idx_task_events_task',
      'idx_task_suggestions_task', 'idx_similar_tasks_source',
      'idx_approval_rules_project', 'idx_approval_requests_task',
      'idx_task_comments_task', 'idx_audit_log_entity',
      'idx_audit_log_action', 'idx_audit_log_timestamp',
      'idx_resource_usage_task', 'idx_resource_limits_project',
      'idx_bulk_operations_type', 'idx_duration_predictions_task',
      'idx_task_artifacts_task', 'idx_run_artifacts_task', 'idx_task_breakpoints_task',
      'idx_debug_sessions_task', 'idx_debug_captures_session',
      'idx_workflows_status', 'idx_task_deps_workflow',
      'idx_cache_hash', 'idx_cache_expires',
      'idx_priority_combined', 'idx_patterns_type',
      'idx_intel_task', 'idx_intel_type',
      'idx_experiments_status', 'idx_retry_rules_pattern',
      'idx_agents_status', 'idx_claims_agent',
      'idx_routing_priority', 'idx_agent_metrics_agent',
      'idx_stealing_victim', 'idx_coord_events_type',
      'idx_template_conditions_template', 'idx_task_replays_original',
      'idx_rate_limits_project', 'idx_task_quotas_project',
      'idx_workflow_forks_workflow', 'idx_query_stats_hash',
      'idx_perf_alerts_type', 'idx_perf_alerts_severity',
      'idx_validation_rules_type', 'idx_validation_results_task',
      'idx_pending_approvals_task', 'idx_failure_matches_task',
      'idx_retry_rules_trigger', 'idx_retry_attempts_task',
      'idx_file_baselines_path', 'idx_syntax_validators_enabled',
      'idx_diff_previews_task', 'idx_quality_scores_task',
      'idx_rollbacks_task', 'idx_build_checks_task',
      'idx_security_scans_task', 'idx_coverage_task',
      'idx_style_checks_task', 'idx_impacts_task',
      'idx_ollama_hosts_enabled', 'idx_provider_usage_provider',
      'idx_provider_usage_transport', 'idx_provider_usage_failure_reason',
      'idx_cost_tracking_provider', 'idx_fingerprints_hash',
      'idx_file_locks_path', 'idx_backups_task',
      'idx_factory_loop_instances_stage_occupancy',
      'idx_factory_loop_instances_project_active',
    ];

    it.each(expectedIndexes)('creates index "%s"', (indexName) => {
      expect(indexExists(indexName)).toBe(true);
    });

    it('creates a duplicate-free index set', () => {
      const indexes = getIndexNames();
      expect(new Set(indexes).size).toBe(indexes.length);
    });
  });

  // ====================================================
  // Config seeding
  // ====================================================
  describe('config seeding', () => {
    it('seeds default cache_config entries', () => {
      const row = db.prepare("SELECT value FROM cache_config WHERE key='ttl_hours'").get();
      expect(row).toBeTruthy();
      expect(row.value).toBe('24');
    });

    it('seeds similarity_threshold cache config', () => {
      const row = db.prepare("SELECT value FROM cache_config WHERE key='similarity_threshold'").get();
      expect(row).toBeTruthy();
      expect(row.value).toBe('0.85');
    });

    it('seeds auto_cache cache config', () => {
      const row = db.prepare("SELECT value FROM cache_config WHERE key='auto_cache'").get();
      expect(row).toBeTruthy();
      expect(row.value).toBe('true');
    });

    it('seeds priority_config entries', () => {
      const row = db.prepare("SELECT value FROM priority_config WHERE key='resource_weight'").get();
      expect(row).toBeTruthy();
      expect(row.value).toBe('0.3');
    });

    it('seeds dependency_weight priority config', () => {
      const row = db.prepare("SELECT value FROM priority_config WHERE key='dependency_weight'").get();
      expect(row).toBeTruthy();
      expect(row.value).toBe('0.4');
    });

    it('seeds artifact_config defaults', () => {
      const storage = db.prepare("SELECT value FROM artifact_config WHERE key='storage_path'").get();
      const maxSize = db.prepare("SELECT value FROM artifact_config WHERE key='max_size_mb'").get();
      const retention = db.prepare("SELECT value FROM artifact_config WHERE key='retention_days'").get();
      expect(storage).toBeTruthy();
      expect(maxSize.value).toBe('50');
      expect(retention.value).toBe('30');
    });

    it('seeds default security rules', () => {
      const rules = db.prepare("SELECT * FROM security_rules").all();
      expect(rules.length).toBeGreaterThanOrEqual(5);
      const sqlConcat = rules.find(r => r.id === 'sec-sql-concat');
      expect(sqlConcat).toBeTruthy();
      expect(sqlConcat.severity).toBe('critical');
    });

    it('seeds default linter configurations', () => {
      const linters = db.prepare("SELECT * FROM linter_configs").all();
      expect(linters.length).toBeGreaterThanOrEqual(3);
      const eslint = linters.find(l => l.id === 'lint-eslint');
      expect(eslint).toBeTruthy();
    });

    it('seeds default output limits', () => {
      const limits = db.prepare("SELECT * FROM output_limits").all();
      expect(limits.length).toBeGreaterThanOrEqual(2);
      const defaultLimit = limits.find(l => l.id === 'limit-default');
      expect(defaultLimit).toBeTruthy();
      expect(defaultLimit.max_output_bytes).toBe(1048576);
    });

    it('seeds default complexity routing rules', () => {
      const rules = db.prepare("SELECT * FROM complexity_routing").all();
      expect(rules.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ====================================================
  // Migration safety (idempotency)
  // ====================================================
  describe('migration safety', () => {
    it('running applySchema twice does not throw', () => {
      const { applySchema } = require('../db/schema');
      const helpers = {
        safeAddColumn: (table, colDef) => {
          try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch {}
        },
        getConfig: (key) => {
          try {
            const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
            return row ? row.value : null;
          } catch { return null; }
        },
        setConfig: (key, value) => {
          try {
            db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
          } catch {}
        },
        setConfigDefault: (key, value) => {
          try {
            db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
          } catch {}
        },
        DATA_DIR: testDir,
      };

      expect(() => applySchema(db, helpers)).not.toThrow();
    });

    it('table and index names remain duplicate-free after second applySchema run', () => {
      const tableNames = getTableNames();
      const indexNames = getIndexNames();
      expect(new Set(tableNames).size).toBe(tableNames.length);
      expect(new Set(indexNames).size).toBe(indexNames.length);
    });

    it('seeded config entries are not duplicated after re-run', () => {
      const cacheConfigs = db.prepare("SELECT * FROM cache_config WHERE key='ttl_hours'").all();
      expect(cacheConfigs.length).toBe(1);
    });

    it('seeded security rules are not duplicated after re-run', () => {
      const count = db.prepare("SELECT COUNT(*) as cnt FROM security_rules WHERE id='sec-sql-concat'").get().cnt;
      expect(count).toBe(1);
    });
  });

  // ====================================================
  // Column constraints (NOT NULL, DEFAULT values, UNIQUE)
  // ====================================================
  describe('column constraints and defaults', () => {
    it('tasks.status has NOT NULL constraint and default "pending"', () => {
      const col = getColumnByName('tasks', 'status');
      expect(col).toBeTruthy();
      expect(col.notnull).toBe(1);
      expect(col.dflt_value).toBe("'pending'");
    });

    it('tasks.task_description has NOT NULL constraint', () => {
      const col = getColumnByName('tasks', 'task_description');
      expect(col).toBeTruthy();
      expect(col.notnull).toBe(1);
    });

    it('tasks.timeout_minutes defaults to 30', () => {
      const col = getColumnByName('tasks', 'timeout_minutes');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe('30');
    });

    it('tasks.priority defaults to 0', () => {
      const col = getColumnByName('tasks', 'priority');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe('0');
    });

    it('tasks.auto_approve defaults to 0', () => {
      const col = getColumnByName('tasks', 'auto_approve');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe('0');
    });

    it('tasks.retry_count defaults to 0', () => {
      const col = getColumnByName('tasks', 'retry_count');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe('0');
    });

    it('pipelines.status defaults to "pending"', () => {
      const col = getColumnByName('pipelines', 'status');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe("'pending'");
    });

    it('pipeline_steps.timeout_minutes defaults to 30', () => {
      const col = getColumnByName('pipeline_steps', 'timeout_minutes');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe('30');
    });

    it('pipeline_steps.status defaults to "pending"', () => {
      const col = getColumnByName('pipeline_steps', 'status');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe("'pending'");
    });

    it('agents.max_concurrent defaults to 1', () => {
      const col = getColumnByName('agents', 'max_concurrent');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe('1');
    });

    it('agents.status defaults to "offline"', () => {
      const col = getColumnByName('agents', 'status');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe("'offline'");
    });

    it('factory_work_items.claimed_by_instance_id is nullable for terminated instance cleanup', () => {
      const col = getColumnByName('factory_work_items', 'claimed_by_instance_id');
      expect(col).toBeTruthy();
      expect(col.type).toBe('TEXT');
      expect(col.notnull).toBe(0);
    });

    it('factory_loop_instances.loop_state defaults to IDLE', () => {
      const col = getColumnByName('factory_loop_instances', 'loop_state');
      expect(col).toBeTruthy();
      expect(col.notnull).toBe(1);
      expect(col.dflt_value).toBe("'IDLE'");
    });

    it('validation_rules.name has NOT NULL constraint', () => {
      const col = getColumnByName('validation_rules', 'name');
      expect(col).toBeTruthy();
      expect(col.notnull).toBe(1);
    });

    it('validation_rules.severity defaults to "warning"', () => {
      const col = getColumnByName('validation_rules', 'severity');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe("'warning'");
    });

    it('webhooks.enabled defaults to 1', () => {
      const col = getColumnByName('webhooks', 'enabled');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe('1');
    });

    it('retry_rules.max_retries defaults to 1', () => {
      const col = getColumnByName('retry_rules', 'max_retries');
      expect(col).toBeTruthy();
      expect(col.dflt_value).toBe('1');
    });
  });

  // ====================================================
  // Foreign key relationships
  // ====================================================
  describe('foreign key relationships', () => {
    it('pipeline_steps references pipelines(id)', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('pipeline_steps')").all();
      const ref = fks.find(fk => fk.table === 'pipelines');
      expect(ref).toBeTruthy();
      expect(ref.from).toBe('pipeline_id');
      expect(ref.to).toBe('id');
    });

    it('token_usage references tasks(id)', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('token_usage')").all();
      const ref = fks.find(fk => fk.table === 'tasks');
      expect(ref).toBeTruthy();
      expect(ref.from).toBe('task_id');
    });

    it('webhook_logs references webhooks(id)', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('webhook_logs')").all();
      const ref = fks.find(fk => fk.table === 'webhooks');
      expect(ref).toBeTruthy();
    });

    it('task_claims references both tasks(id) and agents(id)', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('task_claims')").all();
      const taskRef = fks.find(fk => fk.table === 'tasks');
      const agentRef = fks.find(fk => fk.table === 'agents');
      expect(taskRef).toBeTruthy();
      expect(agentRef).toBeTruthy();
    });

    it('connected_accounts references auth_configs(id)', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('connected_accounts')").all();
      const ref = fks.find(fk => fk.table === 'auth_configs');
      expect(ref).toBeTruthy();
      expect(ref.from).toBe('auth_config_id');
      expect(ref.to).toBe('id');
    });

    it('validation_results references tasks(id) and validation_rules(id)', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('validation_results')").all();
      expect(fks.find(fk => fk.table === 'tasks')).toBeTruthy();
      expect(fks.find(fk => fk.table === 'validation_rules')).toBeTruthy();
    });

    it('retry_attempts references tasks(id)', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('retry_attempts')").all();
      expect(fks.find(fk => fk.table === 'tasks')).toBeTruthy();
    });

    it('workflow_forks references workflows(id)', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('workflow_forks')").all();
      expect(fks.find(fk => fk.table === 'workflows')).toBeTruthy();
    });
  });

  // ====================================================
  // safeAddColumn migrations (spot checks)
  // ====================================================
  describe('safeAddColumn migrations', () => {
    it('tasks has git_before_sha column', () => {
      expect(getColumnByName('tasks', 'git_before_sha')).toBeTruthy();
    });

    it('tasks has tags column', () => {
      expect(getColumnByName('tasks', 'tags')).toBeTruthy();
    });

    it('tasks has project column', () => {
      expect(getColumnByName('tasks', 'project')).toBeTruthy();
    });

    it('tasks has provider column', () => {
      expect(getColumnByName('tasks', 'provider')).toBeTruthy();
    });

    it('tasks has workflow_id column', () => {
      expect(getColumnByName('tasks', 'workflow_id')).toBeTruthy();
    });

    it('tasks has complexity column', () => {
      expect(getColumnByName('tasks', 'complexity')).toBeTruthy();
    });

    it('tasks has metadata column', () => {
      expect(getColumnByName('tasks', 'metadata')).toBeTruthy();
    });

    it('pipeline_steps has parallel_group column', () => {
      expect(getColumnByName('pipeline_steps', 'parallel_group')).toBeTruthy();
    });

    it('ollama_hosts has memory_limit_mb column', () => {
      expect(getColumnByName('ollama_hosts', 'memory_limit_mb')).toBeTruthy();
    });

    it('ollama_hosts has priority column', () => {
      expect(getColumnByName('ollama_hosts', 'priority')).toBeTruthy();
    });

    it('project_config has verify_command column', () => {
      expect(getColumnByName('project_config', 'verify_command')).toBeTruthy();
    });

    it('policy_overrides has task_id column', () => {
      expect(getColumnByName('policy_overrides', 'task_id')).toBeTruthy();
    });

    it('policy_overrides has reason column', () => {
      expect(getColumnByName('policy_overrides', 'reason')).toBeTruthy();
    });

    it('policy_overrides has overridden_by column', () => {
      expect(getColumnByName('policy_overrides', 'overridden_by')).toBeTruthy();
    });
  });
});
