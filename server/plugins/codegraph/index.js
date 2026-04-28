'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const PLUGIN_NAME = 'codegraph';
const PLUGIN_VERSION = '0.1.0';
const { ensureSchema } = require('./schema');
const toolDefs = require('./tool-defs');
const { createHandlers } = require('./handlers');
const telemetry = require('./telemetry');

const DEDICATED_DB_FILENAME = 'codegraph.db';

function isFeatureEnabled() {
  // Default: enabled. Set TORQUE_CODEGRAPH_ENABLED=0 to opt out.
  // The plugin is now part of the standard surface — disabling it leaves
  // /api/v2/codegraph/* routes returning "Unknown tool: cg_*" 500s, which
  // the dashboard's /codegraph page surfaces as "Error: internal server
  // error" with no actionable message.
  return process.env.TORQUE_CODEGRAPH_ENABLED !== '0';
}

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') return null;
  try { return container.get(name); } catch { return null; }
}

// The codegraph plugin owns its own SQLite file (NOT the main TORQUE db).
// Reasoning: cg_reindex spawns a worker thread that runs a single transaction
// inserting ~200K rows for a mid-size repo. Sharing the main db would lock the
// task scheduler / factory loop / dashboard out of writes for the duration of
// the reindex, and was observed to crash the parent process during full
// TORQUE-on-TORQUE reindex (silent native exit, no Node trace). Keeping the
// graph in its own file means writer contention only affects codegraph reads.
function resolveDedicatedDbPath(container) {
  const dbService = getContainerService(container, 'db');
  if (dbService && typeof dbService.getDataDir === 'function') {
    return path.join(dbService.getDataDir(), DEDICATED_DB_FILENAME);
  }
  // Fallback for ad-hoc scripts: TORQUE_DATA_DIR env var, then process cwd.
  const dataDir = process.env.TORQUE_DATA_DIR || process.cwd();
  return path.join(dataDir, DEDICATED_DB_FILENAME);
}

function createCodegraphPlugin() {
  let db = null;
  let installed = false;
  let toolList = [];
  let diagnostics = null;

  function install(container) {
    if (!isFeatureEnabled()) return;

    const dbPath = resolveDedicatedDbPath(container);
    db = new Database(dbPath);
    // WAL: concurrent readers + single writer without blocking each other.
    // busy_timeout: wait up to 10s for the writer lock during reindex
    // transactions instead of throwing SQLITE_BUSY.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 10000');
    ensureSchema(db);

    diagnostics = { unreachableRepos: [], dbPath };
    try {
      const fs = require('fs');
      const rows = db.prepare('SELECT repo_path FROM cg_index_state').all();
      for (const { repo_path: repoPath } of rows) {
        if (!fs.existsSync(repoPath)) {
          diagnostics.unreachableRepos.push(repoPath);
        }
      }
    } catch { /* schema may be empty */ }

    const rawHandlers = createHandlers({ db });
    // Wrap each cg_* handler so every invocation is recorded into
    // cg_tool_usage. The wrapper swallows any recorder error so a failed
    // INSERT never breaks the tool call. cg_telemetry is added unwrapped —
    // surfacing telemetry must not record itself (recursion / measurement
    // bias).
    const handlers = telemetry.instrument(rawHandlers, db);
    toolList = toolDefs.map((toolDef) => ({
      ...toolDef,
      handler: handlers[toolDef.name],
    }));
    installed = true;
  }

  function uninstall() {
    if (db) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
    db = null;
    installed = false;
    toolList = [];
    diagnostics = null;
  }

  function mcpTools() {
    if (!installed) return [];
    return toolList;
  }

  function middleware() { return []; }
  function eventHandlers() { return {}; }
  function configSchema() { return { type: 'object', properties: {} }; }

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install,
    uninstall,
    mcpTools,
    middleware,
    eventHandlers,
    configSchema,
    diagnostics: () => diagnostics || { unreachableRepos: [] },
  };
}

const codegraphPlugin = createCodegraphPlugin();

module.exports = codegraphPlugin;
module.exports.createCodegraphPlugin = createCodegraphPlugin;
module.exports.createPlugin = createCodegraphPlugin;
