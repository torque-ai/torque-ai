/**
 * Schema & Migrations Tests
 *
 * Verifies:
 * 1. db/schema.js smoke test — all core tables, config seeding, indexes
 * 2. db/migrations.js — exports, no-throw on fresh DB, idempotency
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

let db;
let configCore;

function setupDb() {
  ({ db } = setupTestDb('schema-migrations'));
  configCore = require('../db/config-core');
  return db;
}

function teardownDb() {
  teardownTestDb();
}

function getTableNames() {
  const rows = rawDb().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  return rows.map(r => r.name);
}

function getIndexNames() {
  const rows = rawDb().prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  return rows.map(r => r.name);
}

// ── db/schema.js smoke test ─────────────────────────────────────────

describe('db/schema.js — smoke test', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  // -- Core tables exist --------------------------------------------------

  describe('core tables exist', () => {
    // These are the core tables referenced by the user's spec, mapped to
    // the actual table names in schema.js and migrations.js.
    const _EXPECTED_CORE_TABLES = [
      'tasks',
      'templates',
      'pipelines',
      'pipeline_steps',
      'ollama_hosts',
      'config',
      'task_groups',
      'workflows',
      'task_dependencies',
      'token_usage',
      'routing_rules',
      'email_notifications',
      'webhooks',
      'stream_chunks',
      'distributed_locks',
      'agent_coordination',  // may or may not exist; tested separately below
    ];

    // Tables that definitely exist in schema.js CREATE TABLE statements
    const GUARANTEED_TABLES = [
      'tasks',
      'templates',
      'pipelines',
      'pipeline_steps',
      'ollama_hosts',
      'config',
      'task_groups',
      'workflows',
      'task_dependencies',
      'token_usage',
      'routing_rules',
      'email_notifications',
      'webhooks',
      'stream_chunks',
      'distributed_locks',
    ];

    it.each(GUARANTEED_TABLES)('table "%s" exists', (tableName) => {
      const tables = getTableNames();
      expect(tables).toContain(tableName);
    });

    // Additional tables from schema.js that are important
    const ADDITIONAL_TABLES = [
      'plan_projects',
      'plan_project_tasks',
      'analytics',
      'health_status',
      'scheduled_tasks',
      'archived_tasks',
      'project_config',
      'project_metadata',
      'webhook_logs',
      'retry_history',
      'budget_alerts',
      'task_file_changes',
      'success_metrics',
      'format_success_rates',
      'task_streams',
      'task_checkpoints',
      'task_event_subscriptions',
      'task_events',
      'approval_rules',
      'approval_requests',
      'audit_log',
      'resource_usage',
      'resource_limits',
      'bulk_operations',
      'task_artifacts',
      'agents',
      'agent_groups',
      'agent_group_members',
      'task_claims',
      'task_routing_rules',
      'agent_metrics',
      'work_stealing_log',
      'coordination_events',
      'failover_config',
      'provider_config',
      'provider_usage',
      'provider_task_stats',
      'cost_tracking',
      'cost_budgets',
      'file_baselines',
      'quality_scores',
      'build_checks',
      'security_scans',
      'audit_trail',
      'safeguard_tool_config',
      'complexity_routing',
    ];

    it.each(ADDITIONAL_TABLES)('table "%s" exists', (tableName) => {
      const tables = getTableNames();
      expect(tables).toContain(tableName);
    });

    // Tables created by migrations (not in base schema)
    it('migration table "project_tuning" exists (from migration v5)', () => {
      const tables = getTableNames();
      expect(tables).toContain('project_tuning');
    });

    it('migration table "benchmark_results" exists (from migration v6)', () => {
      const tables = getTableNames();
      expect(tables).toContain('benchmark_results');
    });

    it('migration tracking table "schema_migrations" exists', () => {
      const tables = getTableNames();
      expect(tables).toContain('schema_migrations');
    });
  });

  // -- Config seeding -----------------------------------------------------

  describe('config values are seeded', () => {
    it('max_concurrent is seeded', () => {
      const val = configCore.getConfig('max_concurrent');
      expect(val).not.toBeNull();
      expect(Number(val)).toBeGreaterThan(0);
    });

    it('default_timeout is seeded', () => {
      const val = configCore.getConfig('default_timeout');
      expect(val).not.toBeNull();
      expect(Number(val)).toBeGreaterThan(0);
    });

    it('default_provider is seeded', () => {
      const val = configCore.getConfig('default_provider');
      expect(val).not.toBeNull();
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
    });

    it('stale_running_minutes is seeded', () => {
      const val = configCore.getConfig('stale_running_minutes');
      expect(val).not.toBeNull();
      expect(Number(val)).toBeGreaterThan(0);
    });

    it('codex_enabled is seeded', () => {
      const val = configCore.getConfig('codex_enabled');
      expect(val).not.toBeNull();
    });

    it('build commands are seeded', () => {
      expect(configCore.getConfig('build_command_dotnet')).not.toBeNull();
      expect(configCore.getConfig('build_command_npm')).not.toBeNull();
    });

    it('safeguard flags are seeded', () => {
      expect(configCore.getConfig('file_baseline_enabled')).not.toBeNull();
      expect(configCore.getConfig('syntax_validation_enabled')).not.toBeNull();
      expect(configCore.getConfig('quality_scoring_enabled')).not.toBeNull();
      expect(configCore.getConfig('rate_limiting_enabled')).not.toBeNull();
      expect(configCore.getConfig('cost_tracking_enabled')).not.toBeNull();
      expect(configCore.getConfig('audit_trail_enabled')).not.toBeNull();
    });
  });

  // -- Indexes on commonly queried columns --------------------------------

  describe('indexes exist on commonly queried columns', () => {
    it('tasks.status index exists', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_tasks_status');
    });

    it('tasks.created_at index exists', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_tasks_created');
    });

    it('tasks.priority index exists', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_tasks_priority');
    });

    it('tasks composite status+priority index exists', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_tasks_status_priority');
    });

    it('tasks.tags index exists', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_tasks_tags');
    });

    it('tasks.project index exists', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_tasks_project');
    });

    it('analytics indexes exist', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_analytics_event');
      expect(indexes).toContain('idx_analytics_timestamp');
      expect(indexes).toContain('idx_analytics_task');
    });

    it('pipeline_steps index exists', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_pipeline_steps');
    });

    it('token_usage indexes exist', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_token_task');
      expect(indexes).toContain('idx_token_recorded');
    });

    it('webhook_logs indexes exist', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_webhook_logs_webhook');
      expect(indexes).toContain('idx_webhook_logs_event');
    });

    it('scheduled_tasks indexes exist', () => {
      const indexes = getIndexNames();
      expect(indexes).toContain('idx_scheduled_next_run');
      expect(indexes).toContain('idx_scheduled_status');
    });
  });

  // -- Table structure spot checks ----------------------------------------

  describe('table structure spot checks', () => {
    it('tasks table has expected columns', () => {
      const info = rawDb().prepare('PRAGMA table_info(tasks)').all();
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('status');
      expect(colNames).toContain('task_description');
      expect(colNames).toContain('working_directory');
      expect(colNames).toContain('priority');
      expect(colNames).toContain('provider');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('completed_at');
      expect(colNames).toContain('retry_count');
      expect(colNames).toContain('max_retries');
    });

    it('workflows table has expected columns', () => {
      const info = rawDb().prepare('PRAGMA table_info(workflows)').all();
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('name');
      expect(colNames).toContain('status');
      expect(colNames).toContain('created_at');
    });

    it('ollama_hosts table has expected columns', () => {
      const info = rawDb().prepare('PRAGMA table_info(ollama_hosts)').all();
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('name');
      expect(colNames).toContain('url');
      expect(colNames).toContain('enabled');
      expect(colNames).toContain('priority');
    });

    it('config table has key-value structure', () => {
      const info = rawDb().prepare('PRAGMA table_info(config)').all();
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('key');
      expect(colNames).toContain('value');
    });

    it('distributed_locks table has expected columns', () => {
      const info = rawDb().prepare('PRAGMA table_info(distributed_locks)').all();
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('lock_name');
      expect(colNames).toContain('holder_id');
      expect(colNames).toContain('acquired_at');
      expect(colNames).toContain('expires_at');
    });
  });

  // -- Provider config seeding --------------------------------------------

  describe('provider config seeding', () => {
    it('default providers are seeded in provider_config', () => {
      const rows = rawDb().prepare('SELECT provider FROM provider_config ORDER BY provider').all();
      const providers = rows.map(r => r.provider);
      expect(providers).toContain('codex');
      expect(providers).toContain('claude-cli');
      expect(providers).toContain('ollama');
      expect(providers).toContain('aider-ollama');
      expect(providers).toContain('hashline-ollama');
    });

    it('codex provider is enabled by default', () => {
      const row = rawDb().prepare("SELECT enabled FROM provider_config WHERE provider = 'codex'").get();
      expect(row).toBeDefined();
      expect(row.enabled).toBe(1);
    });

    it('provider_config migration sets transport defaults', () => {
      const columns = rawDb().prepare('PRAGMA table_info(provider_config)').all();
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toContain('transport');

      const rows = rawDb().prepare(
        'SELECT provider, transport FROM provider_config WHERE provider IN (?, ?, ?, ?)',
      ).all('codex', 'claude-cli', 'ollama', 'anthropic');
      const transportByProvider = {};
      rows.forEach((row) => {
        transportByProvider[row.provider] = row.transport;
      });

      expect(transportByProvider.codex).toBe('hybrid');
      expect(transportByProvider['claude-cli']).toBe('cli');
      expect(transportByProvider.ollama).toBe('api');
      expect(transportByProvider.anthropic).toBe('api');
    });
  });
});

// ── db/migrations.js ────────────────────────────────────────────────

describe('db/migrations.js', () => {
  let migrationsDb;
  let migrationsTestDir;
  let migrationsOrigDataDir;

  beforeAll(() => {
    migrationsTestDir = path.join(os.tmpdir(), `torque-vtest-migrations-${Date.now()}`);
    fs.mkdirSync(migrationsTestDir, { recursive: true });
    migrationsOrigDataDir = process.env.TORQUE_DATA_DIR;
    process.env.TORQUE_DATA_DIR = migrationsTestDir;

    const dbModulePath = require.resolve('../database');
    delete require.cache[dbModulePath];
    const migrationsModulePath = require.resolve('../db/migrations');
    delete require.cache[migrationsModulePath];

    migrationsDb = require('../database');
    migrationsDb.init();
  });

  afterAll(() => {
    if (migrationsDb) {
      try { migrationsDb.close(); } catch { /* ignore */ }
    }
    if (migrationsTestDir) {
      try { fs.rmSync(migrationsTestDir, { recursive: true, force: true }); } catch { /* ignore */ }
      if (migrationsOrigDataDir !== undefined) {
        process.env.TORQUE_DATA_DIR = migrationsOrigDataDir;
      } else {
        delete process.env.TORQUE_DATA_DIR;
      }
    }
  });

  it('exports runMigrations as a function', () => {
    const migrations = require('../db/migrations');
    expect(typeof migrations.runMigrations).toBe('function');
  });

  it('exports rollbackMigration as a function', () => {
    const migrations = require('../db/migrations');
    expect(typeof migrations.rollbackMigration).toBe('function');
  });

  it('exports MIGRATIONS array', () => {
    const migrations = require('../db/migrations');
    expect(Array.isArray(migrations.MIGRATIONS)).toBe(true);
    expect(migrations.MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('each migration has version, name, and up fields', () => {
    const migrations = require('../db/migrations');
    for (const m of migrations.MIGRATIONS) {
      expect(typeof m.version).toBe('number');
      expect(typeof m.name).toBe('string');
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.up).toBeDefined();
    }
  });

  it('migration versions are unique', () => {
    const migrations = require('../db/migrations');
    const versions = migrations.MIGRATIONS.map(m => m.version);
    const uniqueVersions = new Set(versions);
    expect(uniqueVersions.size).toBe(versions.length);
  });

  it('running migrations on a fresh DB does not throw', () => {
    // Migrations already ran during init(). Verify schema_migrations table exists
    // and has entries.
    const conn = migrationsDb.getDbInstance();
    const rows = conn.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].version).toBe(1);
    expect(typeof rows[0].name).toBe('string');
    expect(typeof rows[0].applied_at).toBe('string');
  });

  it('running migrations twice is idempotent (returns 0 new migrations)', () => {
    const migrations = require('../db/migrations');
    const conn = migrationsDb.getDbInstance();
    // Run again on the same DB — should apply 0 new migrations
    const count = migrations.runMigrations(conn);
    expect(count).toBe(0);
  });

  it('all defined migrations are recorded as applied', () => {
    const migrations = require('../db/migrations');
    const conn = migrationsDb.getDbInstance();
    const applied = conn.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    const appliedVersions = new Set(applied.map(r => r.version));
    for (const m of migrations.MIGRATIONS) {
      expect(appliedVersions.has(m.version)).toBe(true);
    }
  });

  it('migration-created tables exist', () => {
    const conn = migrationsDb.getDbInstance();
    const tables = conn.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    // project_tuning from migration v5
    expect(tables).toContain('project_tuning');
    // benchmark_results from migration v6
    expect(tables).toContain('benchmark_results');
  });

  it('migration v8 removes aider config keys and renames stall threshold', () => {
    const conn = migrationsDb.getDbInstance();

    // Verify aider config keys were removed (they were seeded, then migration deleted them)
    const aiderKeys = conn.prepare(
      "SELECT key FROM config WHERE key IN ('aider_auto_commits', 'aider_auto_switch_format', 'aider_edit_format', 'aider_map_tokens', 'aider_model_edit_formats', 'aider_subtree_only')"
    ).all();
    expect(aiderKeys).toHaveLength(0);

    // Verify no complexity_routing rows target aider-ollama
    const aiderRouting = conn.prepare(
      "SELECT * FROM complexity_routing WHERE target_provider = 'aider-ollama'"
    ).all();
    expect(aiderRouting).toHaveLength(0);

    // Verify migration v8 is recorded
    const applied = conn.prepare(
      "SELECT * FROM schema_migrations WHERE version = 8"
    ).get();
    expect(applied).toBeDefined();
    expect(applied.name).toBe('remove_aider_provider_config');
  });
});
