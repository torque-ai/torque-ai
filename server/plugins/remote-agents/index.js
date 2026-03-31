'use strict';

const allToolDefs = require('./tool-defs');
const { createHandlers } = require('./handlers');
const { RemoteAgentRegistry } = require('./agent-registry');
const { createRemoteTestRouter } = require('./remote-test-routing');

const PLUGIN_NAME = 'remote-agents';
const PLUGIN_VERSION = '1.0.0';

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') return null;
  try {
    return container.get(name);
  } catch {
    return null;
  }
}

function resolveRawDb(dbService) {
  const rawDb = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('remote-agents plugin requires db service with prepare()');
  }
  return rawDb;
}

function createPlugin() {
  let db = null;
  let dbService = null;
  let agentRegistry = null;
  let testRunnerRegistry = null;
  let handlers = null;
  let healthCheckTimer = null;
  let installed = false;

  function install(container) {
    dbService = getContainerService(container, 'db');
    if (!dbService) {
      try {
        dbService = require('../../database');
      } catch {}
    }
    db = resolveRawDb(dbService);
    agentRegistry = new RemoteAgentRegistry(db);

    testRunnerRegistry = getContainerService(container, 'testRunnerRegistry');
    if (testRunnerRegistry) {
      const logger = require('../../logger').child({ component: 'remote-agents-plugin' });
      const router = createRemoteTestRouter({ agentRegistry, db: dbService, logger });
      testRunnerRegistry.register({
        runVerifyCommand: router.runVerifyCommand,
        runRemoteOrLocal: router.runRemoteOrLocal,
      });
    }

    handlers = createHandlers({ agentRegistry, db: dbService });

    healthCheckTimer = setInterval(() => {
      agentRegistry.runHealthChecks().catch(() => {});
    }, 60000);

    installed = true;
  }

  function uninstall() {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }
    if (testRunnerRegistry) {
      testRunnerRegistry.unregister();
    }
    db = null;
    dbService = null;
    agentRegistry = null;
    testRunnerRegistry = null;
    handlers = null;
    installed = false;
  }

  function mcpTools() {
    if (!installed || !handlers) return [];
    return allToolDefs.map((toolDef) => ({ ...toolDef, handler: handlers[toolDef.name] }));
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
    getAgentRegistry: () => agentRegistry,
  };
}

module.exports = { createPlugin };
module.exports.createPlugin = createPlugin;
