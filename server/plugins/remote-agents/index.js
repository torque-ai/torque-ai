'use strict';

const allToolDefs = require('./tool-defs');
const { createRemoteTestRouter } = require('./remote-test-routing');
const {
  getInstalledRegistry,
  getRemoteAgentPluginHandlers,
  requireRemoteAgentRegistry,
  resetRemoteAgentRegistry,
  unwrapRemoteAgentDb,
} = require('./registry-runtime');

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
  try {
    return unwrapRemoteAgentDb(dbService);
  } catch {
    throw new Error('remote-agents plugin requires db service with prepare()');
  }
}

function createPlugin() {
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
    resolveRawDb(dbService);
    agentRegistry = requireRemoteAgentRegistry({ db: dbService });

    testRunnerRegistry = getContainerService(container, 'testRunnerRegistry');
    if (testRunnerRegistry) {
      const logger = require('../../logger').child({ component: 'remote-agents-plugin' });
      const router = createRemoteTestRouter({ agentRegistry, db: dbService, logger });
      testRunnerRegistry.register({
        runVerifyCommand: router.runVerifyCommand,
        runRemoteOrLocal: router.runRemoteOrLocal,
      });
    }

    handlers = getRemoteAgentPluginHandlers({ remoteAgentRegistry: agentRegistry, db: dbService });

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
    dbService = null;
    agentRegistry = null;
    resetRemoteAgentRegistry();
    testRunnerRegistry = null;
    handlers = null;
    installed = false;
  }

  function mcpTools() {
    if (!installed) return [];
    handlers = getRemoteAgentPluginHandlers({ db: dbService });
    if (!handlers) return [];
    return allToolDefs.map((toolDef) => ({ ...toolDef, handler: handlers[toolDef.name] }));
  }

  function middleware() { return []; }
  function eventHandlers() { return {}; }
  function configSchema() { return { type: 'object', properties: {} }; }
  function tierTools() {
    return {
      tier1: [],
      tier2: ['register_remote_agent', 'list_remote_agents', 'check_remote_agent_health', 'run_remote_command'],
    };
  }

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
    tierTools,
  };
}

module.exports = { createPlugin, getInstalledRegistry };
module.exports.createPlugin = createPlugin;
module.exports.getInstalledRegistry = getInstalledRegistry;
