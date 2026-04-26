const fs = require('fs');
const path = require('path');

const { routeMap } = require('../tool-registry');
const remoteAgentToolDefs = require('../plugins/remote-agents/tool-defs');

const INLINE_TOOL_HANDLERS = new Set([
  'ping',
  'restart_server',
  'restart_status',
  'unlock_all_tools',
  'unlock_tier',
  'get_tool_schema',
]);
const EXPECTED_UNMAPPED_TOOLS = new Set([
  // Tool-def names differ from handler route names (set_provider_api_key vs set_api_key)
  'set_provider_api_key', 'clear_provider_api_key',
  // Tool-def names differ from handler route names (strategic_config_* vs config_*)
  'strategic_config_get', 'strategic_config_set', 'strategic_config_templates', 'strategic_config_apply_template',
  // Handler auto-dispatch derives poll_git_hub_issues from handlePollGitHubIssues
  'poll_github_issues',
]);
const PLUGIN_PROVIDED_TOOLS = new Set(
  remoteAgentToolDefs
    .filter((def) => def && typeof def.name === 'string')
    .map((def) => def.name),
);

function isHandledOrAllowed(name) {
  return routeMap.has(name)
    || INLINE_TOOL_HANDLERS.has(name)
    || EXPECTED_UNMAPPED_TOOLS.has(name)
    || PLUGIN_PROVIDED_TOOLS.has(name);
}

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

describe('tool definitions', () => {
  it('are mapped in routeMap or intentionally inline', () => {
    expect(routeMap instanceof Map).toBe(true);

    const toolDefinitionNames = loadToolDefinitionNames();
    const missing = toolDefinitionNames.filter(
      (name) => !isHandledOrAllowed(name),
    );

    expect(missing).toEqual([]);
  });
});
