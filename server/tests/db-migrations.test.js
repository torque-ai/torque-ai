'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const Database = require('better-sqlite3');

const SUBJECT_PATH = '../db/migrations';

let db;
let subject;

function loadSubject() {
  delete require.cache[require.resolve(SUBJECT_PATH)];
  return require(SUBJECT_PATH);
}

function createDb() {
  const conn = new Database(':memory:');
  conn.pragma('foreign_keys = ON');
  return conn;
}

function createBaseSchema(conn, options = {}) {
  const {
    includeNotificationTemplates = true,
    includeProviderTaskStats = true,
    includeProviderConfig = true,
    includeOllamaHosts = true,
    includeDistributedLocks = true,
    includeConfig = true,
    includeComplexityRouting = true,
    existingModelAffinityColumns = false,
    includeModelFamilyTemplates = true,
    includeModelRegistry = true,
  } = options;

  if (includeNotificationTemplates) {
    conn.exec(`
      CREATE TABLE notification_templates (
        id TEXT PRIMARY KEY,
        integration_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
        template TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
    `);
  }

  if (includeProviderTaskStats) {
    conn.exec(`
      CREATE TABLE provider_task_stats (
        provider TEXT NOT NULL,
        task_type TEXT NOT NULL,
        total_tasks INTEGER DEFAULT 0
      );
    `);
  }

  if (includeProviderConfig) {
    conn.exec(`
      CREATE TABLE provider_config (
        provider TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 1
      );
    `);
    conn.exec(`
      INSERT INTO provider_config (provider, enabled) VALUES
        ('hashline-ollama', 1),
        ('hashline-openai', 1),
        ('aider-ollama', 1),
        ('ollama', 1),
        ('codex', 1);
    `);
  }

  if (includeOllamaHosts) {
    conn.exec(`
      CREATE TABLE ollama_hosts (
        id TEXT PRIMARY KEY,
        name TEXT
      );
    `);

    if (existingModelAffinityColumns) {
      conn.exec(`
        ALTER TABLE ollama_hosts ADD COLUMN last_model_used TEXT;
        ALTER TABLE ollama_hosts ADD COLUMN model_loaded_at TEXT;
      `);
    }
  }

  if (includeDistributedLocks) {
    conn.exec(`
      CREATE TABLE distributed_locks (
        lock_name TEXT PRIMARY KEY,
        holder_id TEXT,
        acquired_at TEXT,
        expires_at TEXT
      );
    `);
  }

  if (includeConfig) {
    conn.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    conn.exec(`
      INSERT INTO config (key, value) VALUES
        ('aider_auto_commits', '1'),
        ('stall_threshold_aider', '60');
    `);
  }

  if (includeComplexityRouting) {
    conn.exec(`
      CREATE TABLE complexity_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_provider TEXT
      );
    `);
  }

  if (includeModelFamilyTemplates) {
    conn.prepare(`
      CREATE TABLE IF NOT EXISTS model_family_templates (
        family TEXT PRIMARY KEY,
        tuning_json TEXT NOT NULL DEFAULT '{}',
        description TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  }

  if (includeModelRegistry) {
    conn.prepare(`
      CREATE TABLE IF NOT EXISTS model_registry (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        host_id TEXT,
        model_name TEXT NOT NULL,
        size_bytes INTEGER,
        status TEXT DEFAULT 'pending',
        first_seen_at TEXT,
        last_seen_at TEXT,
        approved_at TEXT,
        approved_by TEXT,
        UNIQUE(provider, host_id, model_name)
      )
    `).run();
  }
}

function ensureSchemaMigrationsTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function seedAppliedVersions(conn, migrations, appliedAt = '2020-01-01T00:00:00.000Z') {
  ensureSchemaMigrationsTable(conn);

  const insert = conn.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  migrations.forEach((migration) => {
    insert.run(migration.version, migration.name, appliedAt);
  });
}

function getAppliedRows(conn) {
  return conn.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
}

function getAppliedVersions(conn) {
  return getAppliedRows(conn).map((row) => row.version);
}

function tableExists(conn, tableName) {
  const row = conn.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
  ).get(tableName);

  return Boolean(row);
}

function indexExists(conn, indexName) {
  const row = conn.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
  ).get(indexName);

  return Boolean(row);
}

function getColumnNames(conn, tableName) {
  return conn.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function addTemporaryMigration(migration) {
  subject.MIGRATIONS.push(migration);
  return migration.version;
}

beforeEach(() => {
  db = createDb();
  subject = loadSubject();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();

  if (db) {
    db.close();
    db = null;
  }

  delete require.cache[require.resolve(SUBJECT_PATH)];
});

describe('db/migrations', () => {
  describe('module shape', () => {
    it('exports runMigrations and rollbackMigration functions', () => {
      expect(typeof subject.runMigrations).toBe('function');
      expect(typeof subject.rollbackMigration).toBe('function');
    });

    it('exports a non-empty MIGRATIONS array', () => {
      expect(Array.isArray(subject.MIGRATIONS)).toBe(true);
      expect(subject.MIGRATIONS.length).toBeGreaterThan(0);
    });

    it('defines unique migration versions in ascending order', () => {
      const versions = subject.MIGRATIONS.map((migration) => migration.version);
      const sorted = [...versions].sort((left, right) => left - right);

      expect(new Set(versions).size).toBe(versions.length);
      expect(versions).toEqual(sorted);
    });

    it('defines each migration with a numeric version, name, and up SQL', () => {
      subject.MIGRATIONS.forEach((migration) => {
        expect(Number.isInteger(migration.version)).toBe(true);
        expect(migration.version).toBeGreaterThan(0);
        expect(typeof migration.name).toBe('string');
        expect(migration.name.length).toBeGreaterThan(0);
        expect(['string', 'function']).toContain(typeof migration.up);
        if (typeof migration.up === 'string') {
          expect(migration.up.length).toBeGreaterThan(0);
        }
      });
    });
  });

  describe('runMigrations', () => {
    it('creates schema_migrations and applies all pending migrations on a fresh base schema', () => {
      createBaseSchema(db);

      const count = subject.runMigrations(db);

      expect(count).toBe(subject.MIGRATIONS.length);
      expect(tableExists(db, 'schema_migrations')).toBe(true);
      expect(getAppliedRows(db)).toHaveLength(subject.MIGRATIONS.length);
    });

    it('records applied versions and names in ascending order', () => {
      createBaseSchema(db);

      subject.runMigrations(db);

      const rows = getAppliedRows(db);
      expect(rows.map((row) => row.version)).toEqual(
        subject.MIGRATIONS.map((migration) => migration.version),
      );
      expect(rows.map((row) => row.name)).toEqual(
        subject.MIGRATIONS.map((migration) => migration.name),
      );
    });

    it('stores ISO timestamps for applied migrations', () => {
      createBaseSchema(db);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-04-05T06:07:08.999Z'));

      subject.runMigrations(db);

      const rows = getAppliedRows(db);
      expect(rows.every((row) => row.applied_at === '2025-04-05T06:07:08.999Z')).toBe(true);
    });

    it('drops notification_templates during migration v1', () => {
      createBaseSchema(db);
      expect(tableExists(db, 'notification_templates')).toBe(true);

      subject.runMigrations(db);

      expect(tableExists(db, 'notification_templates')).toBe(false);
    });

    it('allows migration v1 to succeed when notification_templates is already absent', () => {
      createBaseSchema(db, { includeNotificationTemplates: false });

      expect(() => subject.runMigrations(db)).not.toThrow();
      expect(getAppliedVersions(db)).toContain(1);
    });

    it('creates the provider composite index during migration v2', () => {
      createBaseSchema(db);

      subject.runMigrations(db);

      expect(indexExists(db, 'idx_provider_stats_composite')).toBe(true);
    });

    it('adds model affinity columns during migration v3', () => {
      createBaseSchema(db);

      subject.runMigrations(db);

      expect(getColumnNames(db, 'ollama_hosts')).toEqual(
        expect.arrayContaining(['last_model_used', 'model_loaded_at']),
      );
    });

    it('tolerates pre-existing duplicate v3 columns and still records the migration', () => {
      createBaseSchema(db, { existingModelAffinityColumns: true });
      seedAppliedVersions(db, subject.MIGRATIONS.filter((migration) => migration.version < 3));

      const count = subject.runMigrations(db);

      expect(count).toBe(subject.MIGRATIONS.length - 2);
      expect(getAppliedVersions(db)).toEqual(subject.MIGRATIONS.map((migration) => migration.version));
      expect(getColumnNames(db, 'ollama_hosts')).toEqual(
        expect.arrayContaining(['last_model_used', 'model_loaded_at']),
      );
    });

    it('adds last_heartbeat during migration v4', () => {
      createBaseSchema(db);

      subject.runMigrations(db);

      expect(getColumnNames(db, 'distributed_locks')).toContain('last_heartbeat');
    });

    it('creates project_tuning during migration v5 with the expected columns', () => {
      createBaseSchema(db);

      subject.runMigrations(db);

      expect(tableExists(db, 'project_tuning')).toBe(true);
      expect(getColumnNames(db, 'project_tuning')).toEqual(
        expect.arrayContaining(['id', 'project_path', 'settings_json', 'description', 'created_at', 'updated_at']),
      );
    });

    it('creates benchmark_results during migration v6 with the expected columns', () => {
      createBaseSchema(db);

      subject.runMigrations(db);

      expect(tableExists(db, 'benchmark_results')).toBe(true);
      expect(getColumnNames(db, 'benchmark_results')).toEqual(
        expect.arrayContaining([
          'id',
          'host_id',
          'model',
          'test_type',
          'tokens_per_second',
          'success',
          'benchmarked_at',
        ]),
      );
    });

    it('creates run_artifacts during migration v23 with the expected columns', () => {
      createBaseSchema(db);

      subject.runMigrations(db);

      expect(tableExists(db, 'run_artifacts')).toBe(true);
      expect(indexExists(db, 'idx_run_artifacts_task')).toBe(true);
      expect(getColumnNames(db, 'run_artifacts')).toEqual(
        expect.arrayContaining([
          'artifact_id',
          'task_id',
          'workflow_id',
          'relative_path',
          'absolute_path',
          'size_bytes',
          'mime_type',
          'promoted',
          'created_at',
        ]),
      );
    });

    it('creates managed OAuth tables during migration v24 with the expected columns and indexes', () => {
      createBaseSchema(db);

      subject.runMigrations(db);

      expect(tableExists(db, 'auth_configs')).toBe(true);
      expect(tableExists(db, 'connected_accounts')).toBe(true);
      expect(indexExists(db, 'idx_conn_accounts_user_toolkit')).toBe(true);
      expect(indexExists(db, 'idx_conn_accounts_status')).toBe(true);
      expect(getColumnNames(db, 'auth_configs')).toEqual(
        expect.arrayContaining([
          'id',
          'toolkit',
          'auth_type',
          'client_id',
          'client_secret_enc',
          'authorize_url',
          'token_url',
          'scopes',
          'redirect_uri',
          'created_at',
        ]),
      );
      expect(getColumnNames(db, 'connected_accounts')).toEqual(
        expect.arrayContaining([
          'id',
          'user_id',
          'toolkit',
          'auth_config_id',
          'access_token_enc',
          'refresh_token_enc',
          'expires_at',
          'status',
          'metadata_json',
          'created_at',
          'updated_at',
        ]),
      );
    });

    it('is idempotent when rerun after all migrations have already been applied', () => {
      createBaseSchema(db);

      subject.runMigrations(db);
      const count = subject.runMigrations(db);

      expect(count).toBe(0);
      expect(getAppliedRows(db)).toHaveLength(subject.MIGRATIONS.length);
    });

    it('applies only the remaining migrations when earlier versions are already recorded', () => {
      createBaseSchema(db);
      seedAppliedVersions(db, subject.MIGRATIONS.filter((migration) => migration.version <= 3));

      const count = subject.runMigrations(db);

      expect(count).toBe(subject.MIGRATIONS.length - 3);
      expect(getAppliedVersions(db)).toEqual(subject.MIGRATIONS.map((migration) => migration.version));
      expect(tableExists(db, 'project_tuning')).toBe(true);
      expect(tableExists(db, 'benchmark_results')).toBe(true);
    });

    it('trusts recorded versions when deciding what to skip', () => {
      seedAppliedVersions(db, subject.MIGRATIONS);

      const count = subject.runMigrations(db);

      expect(count).toBe(0);
      expect(tableExists(db, 'project_tuning')).toBe(false);
      expect(tableExists(db, 'benchmark_results')).toBe(false);
    });

    it('throws and logs when a migration fails, leaving only earlier versions recorded', () => {
      createBaseSchema(db, { includeProviderTaskStats: false });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => subject.runMigrations(db)).toThrow(/provider_task_stats|no such table/i);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Migration 2 (add_provider_composite_index) failed:'),
        expect.stringMatching(/provider_task_stats|no such table/i),
      );
      expect(getAppliedVersions(db)).toEqual([1]);
      expect(tableExists(db, 'notification_templates')).toBe(false);
      expect(tableExists(db, 'project_tuning')).toBe(false);
    });

    it('rolls back statement changes from a failed custom migration transaction', () => {
      seedAppliedVersions(db, subject.MIGRATIONS);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      addTemporaryMigration({
        version: 999,
        name: 'custom_atomic_failure',
        up: 'CREATE TABLE temp_atomic_failure (id INTEGER); INSERT INTO missing_target(id) VALUES (1)',
        down: 'DROP TABLE IF EXISTS temp_atomic_failure',
      });

      expect(() => subject.runMigrations(db)).toThrow(/missing_target|no such table/i);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Migration 999 (custom_atomic_failure) failed:'),
        expect.stringMatching(/missing_target|no such table/i),
      );
      expect(tableExists(db, 'temp_atomic_failure')).toBe(false);
      expect(getAppliedVersions(db)).not.toContain(999);
    });

    it('does not execute later migrations after a custom migration fails', () => {
      seedAppliedVersions(db, subject.MIGRATIONS);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      addTemporaryMigration({
        version: 900,
        name: 'custom_stop_here',
        up: 'CREATE TABLE stop_here (id INTEGER); INSERT INTO missing_target(id) VALUES (1)',
        down: 'DROP TABLE IF EXISTS stop_here',
      });
      addTemporaryMigration({
        version: 901,
        name: 'custom_never_runs',
        up: 'CREATE TABLE should_not_exist (id INTEGER)',
        down: 'DROP TABLE IF EXISTS should_not_exist',
      });

      expect(() => subject.runMigrations(db)).toThrow(/missing_target|no such table/i);
      expect(tableExists(db, 'should_not_exist')).toBe(false);
      expect(getAppliedVersions(db)).not.toContain(901);
    });
  });

  describe('rollbackMigration', () => {
    it('throws for unknown migration versions', () => {
      expect(() => subject.rollbackMigration(db, 123456)).toThrow('Migration 123456 not found');
    });

    it('throws when the migration has no rollback SQL', () => {
      expect(() => subject.rollbackMigration(db, 3)).toThrow('Migration 3 has no rollback');
    });

    it('rolls back migration v1 by recreating notification_templates and removing its version row', () => {
      createBaseSchema(db);
      subject.runMigrations(db);

      subject.rollbackMigration(db, 1);

      expect(tableExists(db, 'notification_templates')).toBe(true);
      expect(getAppliedVersions(db)).not.toContain(1);
    });

    it('rolls back migration v2 by dropping the composite index and removing its version row', () => {
      createBaseSchema(db);
      subject.runMigrations(db);
      expect(indexExists(db, 'idx_provider_stats_composite')).toBe(true);

      subject.rollbackMigration(db, 2);

      expect(indexExists(db, 'idx_provider_stats_composite')).toBe(false);
      expect(getAppliedVersions(db)).not.toContain(2);
    });

    it('rolls back migration v5 by dropping project_tuning and removing its version row', () => {
      createBaseSchema(db);
      subject.runMigrations(db);
      expect(tableExists(db, 'project_tuning')).toBe(true);

      subject.rollbackMigration(db, 5);

      expect(tableExists(db, 'project_tuning')).toBe(false);
      expect(getAppliedVersions(db)).not.toContain(5);
    });

    it('rolls back migration v6 by dropping benchmark_results and removing its version row', () => {
      createBaseSchema(db);
      subject.runMigrations(db);
      expect(tableExists(db, 'benchmark_results')).toBe(true);

      subject.rollbackMigration(db, 6);

      expect(tableExists(db, 'benchmark_results')).toBe(false);
      expect(getAppliedVersions(db)).not.toContain(6);
    });

    it('rolls back migration v23 by dropping run_artifacts and removing its version row', () => {
      createBaseSchema(db);
      subject.runMigrations(db);
      expect(tableExists(db, 'run_artifacts')).toBe(true);

      subject.rollbackMigration(db, 23);

      expect(tableExists(db, 'run_artifacts')).toBe(false);
      expect(indexExists(db, 'idx_run_artifacts_task')).toBe(false);
      expect(getAppliedVersions(db)).not.toContain(23);
    });

    it('rolls back migration v24 by dropping managed OAuth tables and indexes', () => {
      createBaseSchema(db);
      subject.runMigrations(db);
      expect(tableExists(db, 'auth_configs')).toBe(true);
      expect(tableExists(db, 'connected_accounts')).toBe(true);

      subject.rollbackMigration(db, 24);

      expect(tableExists(db, 'auth_configs')).toBe(false);
      expect(tableExists(db, 'connected_accounts')).toBe(false);
      expect(indexExists(db, 'idx_conn_accounts_user_toolkit')).toBe(false);
      expect(indexExists(db, 'idx_conn_accounts_status')).toBe(false);
      expect(getAppliedVersions(db)).not.toContain(24);
    });

    it('allows a rolled back migration to be reapplied on the next run', () => {
      createBaseSchema(db);
      subject.runMigrations(db);
      subject.rollbackMigration(db, 2);

      const count = subject.runMigrations(db);

      expect(count).toBe(1);
      expect(indexExists(db, 'idx_provider_stats_composite')).toBe(true);
      expect(getAppliedVersions(db)).toContain(2);
    });

    it('falls back to split statement execution for multi-statement rollback SQL', () => {
      seedAppliedVersions(db, subject.MIGRATIONS);
      addTemporaryMigration({
        version: 777,
        name: 'custom_multi_statement_rollback',
        up: 'CREATE TABLE multi_stmt_target (id INTEGER)',
        down: 'DROP TABLE IF EXISTS multi_stmt_target; CREATE TABLE rollback_marker (id INTEGER)',
      });

      expect(subject.runMigrations(db)).toBe(1);
      expect(tableExists(db, 'multi_stmt_target')).toBe(true);

      subject.rollbackMigration(db, 777);

      expect(tableExists(db, 'multi_stmt_target')).toBe(false);
      expect(tableExists(db, 'rollback_marker')).toBe(true);
      expect(getAppliedVersions(db)).not.toContain(777);
    });
  });
});
