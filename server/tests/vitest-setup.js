/**
 * Shared vitest setup for TORQUE tests.
 * Uses db.resetForTest(buffer) to swap the in-memory DB handle in ~5-10ms
 * without filesystem I/O or module cache clearing.
 *
 * Two setup modes:
 * - setupTestDb(suiteName)     — full tools.handleToolCall context (for handler tests)
 * - setupTestDbModule(modulePath, suiteName) — direct db module testing (for db/ tests)
 *
 * Still creates a temp directory for tests that need filesystem paths
 * (artifacts, backups, scan_project, etc.) — just doesn't use it for the DB.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

const taskCore = require('../db/task-core');
const TEMPLATE_DIR = path.join(os.tmpdir(), 'torque-vitest-template');
const TEMPLATE_BUF = path.join(TEMPLATE_DIR, 'template.db.buf');

let templateBuffer = null; // Loaded once per worker process
let db;
let handleToolCall;
let testDir;
let origDataDir;

function ensureTestSchema(dbHandle) {
  if (!dbHandle || typeof dbHandle.exec !== 'function') return;

  try {
    dbHandle.exec(`ALTER TABLE tasks ADD COLUMN approval_status TEXT DEFAULT 'not_required'`);
  } catch {
    // Column already exists in this test database variant.
  }

  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS host_credentials (
      id TEXT PRIMARY KEY,
      host_name TEXT NOT NULL,
      host_type TEXT NOT NULL CHECK(host_type IN ('ollama', 'peek', 'workstation')),
      credential_type TEXT NOT NULL CHECK(credential_type IN ('ssh', 'http_auth', 'windows')),
      label TEXT,
      encrypted_value TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_host_credentials_unique
    ON host_credentials (host_name, host_type, credential_type);
  `);

  for (const statement of [
    'ALTER TABLE task_file_changes ADD COLUMN stash_ref TEXT',
    'ALTER TABLE task_file_changes ADD COLUMN original_content TEXT',
    'ALTER TABLE task_file_changes ADD COLUMN recorded_at TEXT',
  ]) {
    try {
      dbHandle.exec(statement);
    } catch {
      // Column already exists in this test database variant.
    }
  }

  try {
    dbHandle.exec(`
      UPDATE task_file_changes
      SET recorded_at = created_at
      WHERE recorded_at IS NULL
        AND created_at IS NOT NULL
    `);
  } catch {
    // task_file_changes may not exist in very small ad-hoc fixtures.
  }

  try {
    dbHandle.exec(`
      UPDATE tasks
      SET approval_status = 'not_required'
      WHERE approval_status IS NULL
         OR TRIM(approval_status) = ''
         OR approval_status = 'none'
    `);
  } catch {
    // tasks may not exist in very small ad-hoc fixtures.
  }

  try {
    dbHandle.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_success_metrics_upsert
      ON success_metrics(period_type, period_start, project)
    `);
  } catch {
    // success_metrics may not exist in very small ad-hoc fixtures.
  }

  // model_capabilities: add columns from migrations that newer code expects
  for (const col of [
    'can_create_files INTEGER DEFAULT 1',
    'can_edit_safely INTEGER DEFAULT 1',
    'max_safe_edit_lines INTEGER DEFAULT 250',
    'is_agentic INTEGER DEFAULT 0',
    'cap_hashline INTEGER DEFAULT 0',
    'cap_agentic INTEGER DEFAULT 0',
    'cap_file_creation INTEGER DEFAULT 0',
    'cap_multi_file INTEGER DEFAULT 0',
    "capability_source TEXT DEFAULT 'benchmark'",
  ]) {
    try { dbHandle.exec('ALTER TABLE model_capabilities ADD COLUMN ' + col); } catch { /* exists */ }
  }
}

/**
 * Core DB initialization shared by both setup modes.
 * @param {string} suiteName
 * @returns {{ db: object, testDir: string }}
 */
function _initDb(suiteName) {
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  }

  testDir = path.join(os.tmpdir(), `torque-vtest-${suiteName}-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  db.resetForTest(templateBuffer);
  ensureTestSchema(db.getDbInstance());

  return { db, testDir };
}

/**
 * Full setup with tools.handleToolCall — for handler/MCP tool tests.
 */
function setupTestDb(suiteName) {
  const result = _initDb(suiteName);
  const tools = require('../tools');
  handleToolCall = tools.handleToolCall;
  return { ...result, handleToolCall };
}

/**
 * Lightweight DB-only setup — skips tools.js import (saves ~335ms per test file).
 * Use for tests that only need the database, not handleToolCall.
 */
function setupTestDbOnly(suiteName) {
  return _initDb(suiteName);
}

/**
 * Lightweight setup for direct db sub-module tests.
 * Requires the module, calls setDb(), and returns { db, mod, rawDb, testDir }.
 *
 * Usage:
 *   const { setupTestDbModule, teardownTestDb } = require('./vitest-setup');
 *   let db, mod, rawDb;
 *   beforeAll(() => { ({ db, mod, rawDb } = setupTestDbModule('../db/analytics', 'analytics')); });
 *   afterAll(() => teardownTestDb());
 *
 * @param {string} modulePath - Relative path to the db module (e.g., '../db/analytics')
 * @param {string} suiteName - Name for the temp directory
 * @returns {{ db: object, mod: object, rawDb: function, testDir: string }}
 */
function setupTestDbModule(modulePath, suiteName) {
  const result = _initDb(suiteName);
  const mod = require(modulePath);
  const dbHandle = db.getDbInstance();
  if (typeof mod.setDb === 'function') mod.setDb(dbHandle);
  return { ...result, mod, rawDb: () => db.getDbInstance() };
}

function teardownTestDb() {
  try { if (db && db.close) db.close(); } catch { /* ok */ }
  db = null;

  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

async function safeTool(name, args) {
  try {
    return await handleToolCall(name, args);
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}

function getText(result) {
  if (result && result.content && result.content[0]) {
    return result.content[0].text || '';
  }
  return '';
}

/**
 * Create a task directly in the DB for testing.
 * Reduces the `rawDb().prepare(...).run(...)` boilerplate in 30+ test files.
 *
 * @param {object} db - The database module
 * @param {object} [overrides] - Fields to override
 * @returns {string} The created task's ID
 */
function mkTask(db, overrides = {}) {
  const id = overrides.id || randomUUID();
  const defaults = {
    id,
    task_description: overrides.description || overrides.task_description || 'Test task',
    status: overrides.status || 'completed',
    provider: overrides.provider || 'ollama',
    model: overrides.model || 'test-model',
    created_at: overrides.created_at || new Date().toISOString(),
    completed_at: overrides.completed_at || (overrides.status === 'running' ? null : new Date().toISOString()),
    output: overrides.output || '',
    error_output: overrides.error_output || null,
    exit_code: overrides.exit_code != null ? overrides.exit_code : 0,
    working_directory: overrides.working_directory || '/tmp/test',
    metadata: overrides.metadata || null,
  };

  if (typeof taskCore.createTask === 'function') {
    return taskCore.createTask({
      id: defaults.id,
      task_description: defaults.task_description,
      provider: defaults.provider,
      model: defaults.model,
      working_directory: defaults.working_directory,
      status: defaults.status,
      metadata: defaults.metadata,
    });
  }

  // Fallback: direct SQL insert
  const rawDbFn = db.getDbInstance;
  if (rawDbFn) {
    rawDbFn.call(db).prepare(`
      INSERT INTO tasks (id, task_description, status, provider, model, created_at, completed_at, output, error_output, exit_code, working_directory, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      defaults.id, defaults.task_description, defaults.status, defaults.provider,
      defaults.model, defaults.created_at, defaults.completed_at, defaults.output,
      defaults.error_output, defaults.exit_code, defaults.working_directory, defaults.metadata
    );
  }
  return id;
}

/**
 * Get the raw better-sqlite3 handle. Works after either setup mode.
 */
function rawDb() {
  if (!db) throw new Error('rawDb() called before setupTestDb/setupTestDbModule');
  return db.getDbInstance();
}

/**
 * Delete all rows from one or more tables. Useful in beforeEach for test isolation.
 * @param {string|string[]} tables
 */
function resetTables(tables) {
  const handle = rawDb();
  const names = Array.isArray(tables) ? tables : [tables];
  for (const table of names) {
    handle.prepare(`DELETE FROM ${table}`).run();
  }
}

module.exports = { setupTestDb, setupTestDbOnly, setupTestDbModule, teardownTestDb, safeTool, getText, mkTask, rawDb, resetTables, ensureTestSchema };
