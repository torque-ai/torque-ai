'use strict';

/**
 * server/container.js — Composition root for TORQUE dependency wiring.
 *
 * Centralizes and documents the initialization order that was previously
 * scattered across index.js:init() and the task-manager.js module body.
 *
 * Usage: called from index.js:init() as a helper after db.init().
 * Does NOT replace index.js:init() yet — that migration is a future step.
 */

const logger = require('./logger').child({ component: 'container' });

/**
 * Phase 2.4: These 8 modules directly require('./database').
 * Phase 3 will migrate each to receive db through init(deps).
 *
 * Migration order (least-coupled first):
 * 1. config.js — only uses getConfig/setConfig/getBool
 * 2. discovery.js — only uses host management functions
 * 3. tools.js — only uses getConfig for tool mode
 * 4. dashboard-server.js — uses listTasks, getTask, updateTaskStatus
 * 5. api-server.core.js — uses broad set of db functions
 * 6. mcp-sse.js — uses config and task functions
 * 7. task-manager.js — heaviest consumer, uses everything
 * 8. index.js — orchestrator, last to migrate
 */
const DIRECT_DB_CONSUMERS = [
  'config.js', 'discovery.js', 'tools.js', 'dashboard-server.js',
  'api-server.core.js', 'mcp-sse.js', 'task-manager.js', 'index.js',
];

// Module references — populated by initModules
const _modules = {};

/**
 * Initialize core infrastructure modules in dependency order.
 *
 * Phase 1: Core infrastructure (no inter-module dependencies)
 * Phase 2: Provider config and registry (depend on db)
 * Phase 3: MCP protocol (depends on tools, wired after tools are loaded)
 *
 * @param {object} db           - Initialized database module
 * @param {object} serverConfig - Server configuration module
 */
function initModules(db, serverConfig) {
  // Phase 1: Core infrastructure (no dependencies)
  _modules.db = db;
  _modules.serverConfig = serverConfig;

  // Phase 2.4 (PoC): config.js migrated to init(deps) — receives db here
  // rather than requiring('./database') directly.
  serverConfig.init({ db });
  logger.info('Container: config.js wired via init(deps)');

  // Phase 2: Provider config and registry
  const providerCfg = require('./providers/config');
  providerCfg.init({ db });
  _modules.providerCfg = providerCfg;

  const providerRegistry = require('./providers/registry');
  providerRegistry.init({ db });
  _modules.providerRegistry = providerRegistry;

  // Phase 3: MCP protocol
  // mcpProtocol.init() is called later in index.js:init() after tools are loaded
  const mcpProtocol = require('./mcp-protocol');
  _modules.mcpProtocol = mcpProtocol;

  // Phase 3 (future): DB sub-module injection will move here.
  // db._injectDbAll() and db._wireCrossModuleDI() are currently called
  // internally by db.init(), but are exported so the container can eventually
  // own this wiring — decoupling it from the database module itself.
  // That migration requires converting 26 sub-modules from setDb(db) to
  // init({ db }) and is tracked as Phase 2.3 / Phase 3 work.

  logger.info('Container: core modules initialized');
}

/**
 * Retrieve a module registered during initModules().
 * @param {string} name - Module key (e.g., 'db', 'providerCfg', 'providerRegistry')
 * @returns {object|undefined}
 */
function getModule(name) {
  return _modules[name];
}

module.exports = { initModules, getModule };
