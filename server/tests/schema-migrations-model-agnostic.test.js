'use strict';
/* global describe, it, expect, beforeEach */

/**
 * Tests for the migrateModelAgnostic migration in schema-migrations.js.
 */

const Database = require('better-sqlite3');
const { migrateModelAgnostic } = require('../db/schema-migrations');

function makeDb() {
  const db = new Database(':memory:');
  // Baseline model_registry table
  db.exec([
    'CREATE TABLE IF NOT EXISTS model_registry (',
    '  id TEXT PRIMARY KEY,',
    '  provider TEXT NOT NULL,',
    '  host_id TEXT,',
    '  model_name TEXT NOT NULL,',
    '  size_bytes INTEGER,',
    "  status TEXT DEFAULT 'pending',",
    '  first_seen_at TEXT,',
    '  last_seen_at TEXT,',
    '  approved_at TEXT,',
    '  approved_by TEXT,',
    '  UNIQUE(provider, host_id, model_name)',
    ')'
  ].join(''));
  // Baseline model_capabilities table
  db.exec([
    'CREATE TABLE IF NOT EXISTS model_capabilities (',
    '  model_name TEXT PRIMARY KEY,',
    '  score_code_gen REAL DEFAULT 0.5,',
    '  context_window INTEGER DEFAULT 8192,',
    '  param_size_b REAL DEFAULT 0,',
    '  is_thinking_model INTEGER DEFAULT 0,',
    "  source TEXT DEFAULT 'benchmark',",
    "  updated_at TEXT DEFAULT (datetime('now')),",
    '  can_create_files INTEGER DEFAULT 1,',
    '  can_edit_safely INTEGER DEFAULT 1,',
    '  max_safe_edit_lines INTEGER DEFAULT 250,',
    '  is_agentic INTEGER DEFAULT 0',
    ')'
  ].join(''));
  return db;
}

function getColumns(db, tableName) {
  return db.prepare('PRAGMA table_info(' + tableName + ')').all().map(c => c.name);
}

function getTableNames(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(r => r.name);
}

describe('migrateModelAgnostic', () => {
  let db;

  beforeEach(() => {
    db = makeDb();
  });

  it('is exported from schema-migrations.js', () => {
    expect(typeof migrateModelAgnostic).toBe('function');
  });

  describe('model_registry new columns', () => {
    beforeEach(() => { migrateModelAgnostic(db); });

    it('adds family column', () => {
      expect(getColumns(db, 'model_registry')).toContain('family');
    });

    it('adds parameter_size_b column', () => {
      expect(getColumns(db, 'model_registry')).toContain('parameter_size_b');
    });

    it('adds quantization column', () => {
      expect(getColumns(db, 'model_registry')).toContain('quantization');
    });

    it('adds role column', () => {
      expect(getColumns(db, 'model_registry')).toContain('role');
    });

    it('adds tuning_json column', () => {
      expect(getColumns(db, 'model_registry')).toContain('tuning_json');
    });

    it('adds prompt_template column', () => {
      expect(getColumns(db, 'model_registry')).toContain('prompt_template');
    });

    it('adds probe_status column', () => {
      expect(getColumns(db, 'model_registry')).toContain('probe_status');
    });

    it('adds source column', () => {
      expect(getColumns(db, 'model_registry')).toContain('source');
    });

  });

  describe('model_capabilities new columns', () => {
    beforeEach(() => { migrateModelAgnostic(db); });

    it('adds cap_hashline column', () => {
      expect(getColumns(db, 'model_capabilities')).toContain('cap_hashline');
    });

    it('adds cap_agentic column', () => {
      expect(getColumns(db, 'model_capabilities')).toContain('cap_agentic');
    });

    it('adds cap_file_creation column', () => {
      expect(getColumns(db, 'model_capabilities')).toContain('cap_file_creation');
    });

    it('adds cap_multi_file column', () => {
      expect(getColumns(db, 'model_capabilities')).toContain('cap_multi_file');
    });

    it('adds capability_source column', () => {
      expect(getColumns(db, 'model_capabilities')).toContain('capability_source');
    });

    it('does not remove pre-existing source column', () => {
      expect(getColumns(db, 'model_capabilities')).toContain('source');
    });

  });

  describe('model_family_templates table', () => {
    beforeEach(() => { migrateModelAgnostic(db); });

    it('creates the model_family_templates table', () => {
      expect(getTableNames(db)).toContain('model_family_templates');
    });

    it('table has family column', () => {
      expect(getColumns(db, 'model_family_templates')).toContain('family');
    });

    it('table has system_prompt column', () => {
      expect(getColumns(db, 'model_family_templates')).toContain('system_prompt');
    });

    it('table has tuning_json column', () => {
      expect(getColumns(db, 'model_family_templates')).toContain('tuning_json');
    });

    it('table has size_overrides column', () => {
      expect(getColumns(db, 'model_family_templates')).toContain('size_overrides');
    });

  });

  describe('column defaults', () => {
    beforeEach(() => { migrateModelAgnostic(db); });

    it('probe_status defaults to pending on insert', () => {
      db.exec("INSERT INTO model_registry (id, provider, model_name) VALUES ('test-1', 'ollama', 'llama3:8b')");
      const row = db.prepare("SELECT probe_status FROM model_registry WHERE id = 'test-1'").get();
      expect(row.probe_status).toBe('pending');
    });

    it('source defaults to discovered on insert', () => {
      db.exec("INSERT INTO model_registry (id, provider, model_name) VALUES ('test-2', 'ollama', 'llama3:8b')");
      const row = db.prepare("SELECT source FROM model_registry WHERE id = 'test-2'").get();
      expect(row.source).toBe('discovered');
    });

    it('capability_source defaults to heuristic on insert', () => {
      db.exec("INSERT INTO model_capabilities (model_name) VALUES ('qwen3-coder:30b')");
      const row = db.prepare("SELECT capability_source FROM model_capabilities WHERE model_name = 'qwen3-coder:30b'").get();
      expect(row.capability_source).toBe('heuristic');
    });

  });

  describe('idempotency', () => {
    it('running migrateModelAgnostic twice does not throw', () => {
      migrateModelAgnostic(db);
      expect(() => migrateModelAgnostic(db)).not.toThrow();
    });

    it('columns are still present after second run', () => {
      migrateModelAgnostic(db);
      migrateModelAgnostic(db);
      const cols = getColumns(db, 'model_registry');
      expect(cols).toContain('family');
      expect(cols).toContain('probe_status');
      expect(cols).toContain('source');
    });

    it('model_family_templates table still present after second run', () => {
      migrateModelAgnostic(db);
      migrateModelAgnostic(db);
      expect(getTableNames(db)).toContain('model_family_templates');
    });
  });
});
