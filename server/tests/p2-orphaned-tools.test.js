const fs = require('fs');
const path = require('path');

const { routeMap } = require('../tools');

const INLINE_TOOL_HANDLERS = new Set(['ping', 'restart_server', 'unlock_all_tools', 'unlock_tier']);

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

  return names;
}

describe('tool definitions', () => {
  it('are mapped in routeMap or intentionally inline', () => {
    expect(routeMap instanceof Map).toBe(true);

    const toolDefinitionNames = loadToolDefinitionNames();
    const missing = toolDefinitionNames.filter(
      (name) => !routeMap.has(name) && !INLINE_TOOL_HANDLERS.has(name),
    );

    expect(missing).toEqual([]);
  });
});
