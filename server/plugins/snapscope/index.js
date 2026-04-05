'use strict';

const { createPeekClient } = require('./peek-client');
const { createHostRegistry } = require('./host-registry');

const PLUGIN_NAME = 'snapscope';
const PLUGIN_VERSION = '1.0.0';

function createSnapScopePlugin() {
  let peekClient = null;
  let hostRegistry = null;
  let installed = false;
  let _db = null;
  let _eventBus = null;
  let _serverConfig = null;

  function getContainerService(container, name) {
    if (!container || typeof container.get !== 'function') return null;
    try { return container.get(name); } catch { return null; }
  }

  function install(container) {
    _db = getContainerService(container, 'db');
    if (!_db) {
      try { _db = require('../../database'); } catch { /* fallback unavailable */ }
    }
    _serverConfig = getContainerService(container, 'serverConfig');
    _eventBus = getContainerService(container, 'eventBus');

    if (_db) {
      const rawDb = typeof _db.getDbInstance === 'function' ? _db.getDbInstance() : _db;
      hostRegistry = createHostRegistry(rawDb);
    }

    const peekUrl = _serverConfig && typeof _serverConfig.get === 'function'
      ? (_serverConfig.get('peek_server_url') || '')
      : '';
    peekClient = createPeekClient({ url: peekUrl, hostRegistry });

    installed = true;
  }

  function uninstall() {
    peekClient = null;
    hostRegistry = null;
    _db = null;
    _eventBus = null;
    _serverConfig = null;
    installed = false;
  }

  function middleware() {
    return [];
  }

  function mcpTools() {
    if (!installed) return [];

    const toolDefs = [
      ...require('./tool-defs'),
      ...require('./new-tool-defs'),
    ];
    const handlerModules = [
      require('./handlers/cli'),
      require('./handlers/capture'),
      require('./handlers/analysis'),
      require('./handlers/artifacts'),
      require('./handlers/hosts'),
      require('./handlers/recovery'),
      require('./handlers/onboarding'),
      require('./handlers/shared'),
      require('./handlers/compliance'),
      require('./handlers/federation'),
      require('./handlers/quality-score'),
      require('./handlers/accessibility-diff'),
      require('./handlers/browser-capture'),
      require('./handlers/live-autonomy'),
      require('./handlers/rollback'),
      require('./handlers/webhook-outbound'),
    ];
    const { createVerifyHandlers } = require('./handlers/verify');
    const { createWatchHandlers } = require('./handlers/watch');

    const FIXUPS = {
      export_report_c_s_v: 'export_report_csv',
      export_report_j_s_o_n: 'export_report_json',
    };
    const routeMap = new Map();

    function pascalToSnake(name) {
      return name.replace(/([A-Z])/g, (match, char, index) => (index > 0 ? '_' : '') + char.toLowerCase());
    }

    function registerHandlers(mod) {
      for (const [fnName, fn] of Object.entries(mod || {})) {
        if (!fnName.startsWith('handle') || typeof fn !== 'function') continue;
        let toolName = pascalToSnake(fnName.slice(6));
        toolName = FIXUPS[toolName] || toolName;
        routeMap.set(toolName, fn);
      }
    }

    for (const mod of handlerModules) {
      registerHandlers(mod);
    }

    registerHandlers(createVerifyHandlers(peekClient));
    registerHandlers(createWatchHandlers(peekClient));

    return toolDefs
      .filter((def) => def && def.name && routeMap.has(def.name))
      .map((def) => ({
        ...def,
        handler: async (args) => routeMap.get(def.name)(args),
      }));
  }

  function eventHandlers() {
    return {};
  }

  function configSchema() {
    return {
      type: 'object',
      properties: {
        peek_server_url: {
          type: 'string',
          default: '',
          description: 'Override peek_server URL. Empty = use host registry.',
        },
        peek_hosts_enabled: {
          type: 'boolean',
          default: true,
          description: 'Enable automatic peek host registry for multi-host discovery.',
        },
        snapscope_cli_project: {
          type: 'string',
          default: '',
          description: 'Path to SnapScope.Cli .csproj. Empty = CLI tools disabled.',
        },
        auto_register_tools: {
          type: 'boolean',
          default: true,
          description: 'Automatically register tools based on capability detection.',
        },
      },
    };
  }

  function tierTools() {
    return {
      tier1: [
        'peek_ui', 'peek_interact', 'peek_elements', 'peek_diagnose',
        'peek_wait', 'peek_launch', 'peek_action_sequence', 'peek_pre_analyze',
      ],
      tier2: [
        'peek_hit_test', 'peek_discover', 'peek_health_all',
        'peek_build_and_open', 'peek_assert', 'peek_ocr',
        'register_peek_host', 'unregister_peek_host', 'list_peek_hosts',
      ],
    };
  }

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install,
    uninstall,
    middleware,
    mcpTools,
    eventHandlers,
    configSchema,
    tierTools,
  };
}

module.exports = { createSnapScopePlugin };
