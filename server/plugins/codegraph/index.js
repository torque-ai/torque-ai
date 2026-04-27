'use strict';

const PLUGIN_NAME = 'codegraph';
const PLUGIN_VERSION = '0.1.0';
const { ensureSchema } = require('./schema');
const toolDefs = require('./tool-defs');
const { createHandlers } = require('./handlers');

function isFeatureEnabled() {
  return process.env.TORQUE_CODEGRAPH_ENABLED === '1';
}

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') return null;
  try { return container.get(name); } catch { return null; }
}

function resolveRawDb(dbService) {
  const rawDb = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('codegraph plugin requires container db service with prepare() or getDbInstance()');
  }
  return rawDb;
}

function createCodegraphPlugin() {
  let db = null;
  let installed = false;
  let toolList = [];
  let diagnostics = null;

  function install(container) {
    if (!isFeatureEnabled()) return;
    const dbService = getContainerService(container, 'db');
    db = resolveRawDb(dbService);
    ensureSchema(db);
    diagnostics = { unreachableRepos: [] };
    try {
      const fs = require('fs');
      const rows = db.prepare('SELECT repo_path FROM cg_index_state').all();
      for (const { repo_path: repoPath } of rows) {
        if (!fs.existsSync(repoPath)) {
          diagnostics.unreachableRepos.push(repoPath);
        }
      }
    } catch { /* schema may be empty */ }
    const handlers = createHandlers({ db });
    toolList = toolDefs.map((toolDef) => ({
      ...toolDef,
      handler: handlers[toolDef.name],
    }));
    installed = true;
  }

  function uninstall() {
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
