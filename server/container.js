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
