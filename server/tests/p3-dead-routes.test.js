const fs = require('fs');
const path = require('path');

const { routeMap } = require('../tools');
const remoteAgentToolDefs = require('../plugins/remote-agents/tool-defs');

const INTERNAL_ONLY_ROUTES = new Set([
  'ping', 'restart_server', 'unlock_all_tools', 'unlock_tier',
  // Handler names differ from tool-def names (handleSetApiKey → set_api_key vs tool-def set_provider_api_key)
  'set_api_key', 'clear_api_key',
  // Handler names differ from tool-def names (handleConfigGet → config_get vs tool-def strategic_config_get)
  'config_get', 'config_set', 'config_reset', 'config_templates', 'config_apply_template',
  // Built-in MCP-SSE handler, not registered in tool-defs
  'subscribe_task_events',
  // Internal handler without tool-def (accessed via task finalizer pipeline, not MCP)
  'get_verification_ledger',
]);

function loadToolDefinitionNames() {
  const toolDefDir = path.join(__dirname, '../tool-defs');
  const toolDefFiles = fs.readdirSync(toolDefDir).filter((file) => file.endsWith('.js')).sort();

  const names = [];

  for (const file of toolDefFiles) {
    const defs = require(path.join(toolDefDir, file));
    expect(Array.isArray(defs)).toBe(true);

    for (const def of defs) {
      if (def && typeof def.name === 'string') {
        names.push(def.name);
      }
    }
  }

  for (const def of remoteAgentToolDefs) {
    if (def && typeof def.name === 'string') {
      names.push(def.name);
    }
  }

  return names;
}

describe('routeMap', () => {
  it('contains only tool definitions or documented internal-only routes', () => {
    expect(routeMap instanceof Map).toBe(true);

    const toolDefinitionNames = loadToolDefinitionNames();
    const toolDefinitionSet = new Set(toolDefinitionNames);

    const deadRoutes = [...routeMap.keys()].filter(
      (name) => !toolDefinitionSet.has(name) && !INTERNAL_ONLY_ROUTES.has(name),
    );

    expect(deadRoutes).toEqual([]);
  });
});
