/**
 * Shared vitest setup for TORQUE tests.
 * Uses db.resetForTest(buffer) to swap the in-memory DB handle in ~5-10ms
 * without filesystem I/O or module cache clearing.
 *
 * Two setup modes:
 * - setupTestDb(suiteName)     — DB setup with lazy tools.handleToolCall wrapper
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
let toolsModule;
let realHandleToolCall;
let realHandleToolCallModule;
let testDir;
let origDataDir;
const TOOLS_MODULE_PATH = require.resolve('../tools');

function getToolsModule() {
  if (!toolsModule || !require.cache[TOOLS_MODULE_PATH]) {
    toolsModule = require('../tools');
  }
  return toolsModule;
}

function getRealHandleToolCall() {
  const mod = getToolsModule();
  if (realHandleToolCall && realHandleToolCallModule === mod) {
    return realHandleToolCall;
  }

  realHandleToolCallModule = mod;
  realHandleToolCall = typeof mod.createTools === 'function'
    ? mod.createTools().handleToolCall
    : mod.handleToolCall;
  return realHandleToolCall;
}

async function lazyHandleToolCall(...args) {
  return getRealHandleToolCall()(...args);
}

function ensureFactoryWorkItemsSchema(dbHandle) {
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  for (const statement of [
    "ALTER TABLE factory_work_items ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
    'ALTER TABLE factory_work_items ADD COLUMN origin_json TEXT',
    "ALTER TABLE factory_work_items ADD COLUMN title TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE factory_work_items ADD COLUMN description TEXT',
    'ALTER TABLE factory_work_items ADD COLUMN priority INTEGER NOT NULL DEFAULT 50',
    'ALTER TABLE factory_work_items ADD COLUMN requestor TEXT',
    'ALTER TABLE factory_work_items ADD COLUMN constraints_json TEXT',
    "ALTER TABLE factory_work_items ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
    'ALTER TABLE factory_work_items ADD COLUMN reject_reason TEXT',
    'ALTER TABLE factory_work_items ADD COLUMN linked_item_id INTEGER',
    'ALTER TABLE factory_work_items ADD COLUMN batch_id TEXT',
    'ALTER TABLE factory_work_items ADD COLUMN claimed_by_instance_id TEXT',
    'ALTER TABLE factory_work_items ADD COLUMN created_at TEXT',
    'ALTER TABLE factory_work_items ADD COLUMN updated_at TEXT',
  ]) {
    try {
      dbHandle.exec(statement);
    } catch {
      // Column already exists or this fixture doesn't include factory tables.
    }
  }

  try {
    dbHandle.exec(`
      UPDATE factory_work_items
      SET
        source = COALESCE(NULLIF(TRIM(source), ''), 'manual'),
        title = COALESCE(NULLIF(TRIM(title), ''), 'fixture'),
        priority = COALESCE(priority, 50),
        status = COALESCE(NULLIF(TRIM(status), ''), 'pending'),
        created_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
  } catch {
    // factory_work_items may be absent in very small ad-hoc fixtures.
  }

  dbHandle.exec(`
    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
    ON factory_work_items (project_id, status);
    CREATE INDEX IF NOT EXISTS idx_fwi_status_priority
    ON factory_work_items (status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_fwi_source
    ON factory_work_items (source);
    CREATE INDEX IF NOT EXISTS idx_fwi_linked
    ON factory_work_items (linked_item_id);
  `);
}

function ensureTestSchema(dbHandle) {
  if (!dbHandle || typeof dbHandle.exec !== 'function') return;

  try {
    dbHandle.exec(`ALTER TABLE tasks ADD COLUMN approval_status TEXT DEFAULT 'not_required'`);
  } catch {
    // Column already exists in this test database variant.
  }

  try {
    dbHandle.exec(`ALTER TABLE tasks ADD COLUMN resume_context TEXT`);
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

  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS auth_configs (
      id TEXT PRIMARY KEY,
      toolkit TEXT NOT NULL UNIQUE,
      auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth2', 'api_key', 'basic', 'bearer')),
      client_id TEXT,
      client_secret_enc TEXT,
      authorize_url TEXT,
      token_url TEXT,
      scopes TEXT,
      redirect_uri TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connected_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      toolkit TEXT NOT NULL,
      auth_config_id TEXT NOT NULL REFERENCES auth_configs(id),
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      expires_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked', 'expired')),
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conn_accounts_user_toolkit
    ON connected_accounts (user_id, toolkit);

    CREATE INDEX IF NOT EXISTS idx_conn_accounts_status
    ON connected_accounts (status);
  `);

  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS run_artifacts (
      artifact_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_id TEXT,
      relative_path TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      size_bytes INTEGER,
      mime_type TEXT,
      promoted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_run_artifacts_task
    ON run_artifacts (task_id);
  `);

  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS workflow_state (
      workflow_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL DEFAULT '{}',
      schema_json TEXT,
      reducers_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_state_updated
    ON workflow_state(updated_at);
  `);

  for (const statement of [
    'ALTER TABLE workflows ADD COLUMN parent_workflow_id TEXT',
    'ALTER TABLE workflows ADD COLUMN fork_checkpoint_id TEXT',
  ]) {
    try {
      dbHandle.exec(statement);
    } catch {
      // Column already exists in this test database variant.
    }
  }

  ensureFactoryWorkItemsSchema(dbHandle);

  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS factory_loop_instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER REFERENCES factory_work_items(id),
      batch_id TEXT,
      loop_state TEXT NOT NULL DEFAULT 'IDLE',
      paused_at_stage TEXT,
      last_action_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      terminated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_loop_instances_stage_occupancy
      ON factory_loop_instances(project_id, loop_state)
      WHERE terminated_at IS NULL AND loop_state NOT IN ('IDLE');
    CREATE INDEX IF NOT EXISTS idx_factory_loop_instances_project_active
      ON factory_loop_instances(project_id)
      WHERE terminated_at IS NULL;
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

  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS provider_model_scores (
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      score REAL DEFAULT 0,
      score_reason TEXT,
      smoke_status TEXT DEFAULT 'metadata',
      latency_ms INTEGER,
      first_response_ms INTEGER,
      tool_call_ok INTEGER DEFAULT 0,
      read_only_ok INTEGER DEFAULT 0,
      rate_limited INTEGER DEFAULT 0,
      error TEXT,
      metadata_json TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (provider, model_name)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_model_scores_provider_score
      ON provider_model_scores(provider, score DESC, checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_model_scores_status
      ON provider_model_scores(provider, smoke_status, rate_limited, score DESC);
  `);

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

  const safeSuiteName = String(suiteName || 'suite')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .slice(0, 48);
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), `torque-vtest-${safeSuiteName}-`));
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;
  require('../data-dir').setDataDir(null);

  db = require('../database');
  db.resetForTest(templateBuffer);
  ensureTestSchema(db.getDbInstance());

  return { db, testDir };
}

/**
 * Full setup with a lazy tools.handleToolCall wrapper — for handler/MCP tool tests.
 */
function setupTestDb(suiteName) {
  const result = _initDb(suiteName);
  handleToolCall = lazyHandleToolCall;
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
    try { require('../data-dir').setDataDir(null); } catch { /* ok */ }
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

function quoteIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe table name: ${name}`);
  }
  return `"${name}"`;
}

function listUserTables(handle) {
  return handle.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `).all().map(row => row.name);
}

function getReferencingTables(handle, targetTable) {
  return listUserTables(handle).filter(table => {
    try {
      return handle.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all()
        .some(fk => fk.table === targetTable);
    } catch {
      return false;
    }
  });
}

function buildDeleteOrder(handle, tables) {
  const order = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(table) {
    if (visited.has(table) || visiting.has(table)) return;
    visiting.add(table);
    for (const dependent of getReferencingTables(handle, table)) {
      visit(dependent);
    }
    visiting.delete(table);
    visited.add(table);
    order.push(table);
  }

  for (const table of tables) {
    visit(table);
  }

  return order;
}

/**
 * Delete all rows from one or more tables. Useful in beforeEach for test isolation.
 * @param {string|string[]} tables
 */
function resetTables(tables) {
  const handle = rawDb();
  const names = Array.isArray(tables) ? tables : [tables];
  for (const table of buildDeleteOrder(handle, names)) {
    handle.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
  }
}

module.exports = { setupTestDb, setupTestDbOnly, setupTestDbModule, teardownTestDb, safeTool, getText, mkTask, rawDb, resetTables, ensureTestSchema };
