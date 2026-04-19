'use strict';

const { validatePlugin } = require('../../plugin-contract');
const { createPlugin } = require('../index');

describe('model-freshness plugin contract', () => {
  it('satisfies the required fields', () => {
    const plugin = createPlugin();
    const { valid, errors } = validatePlugin(plugin);
    expect(valid).toBe(true);
    if (!valid) console.log(errors);
    expect(plugin.name).toBe('model-freshness');
    expect(typeof plugin.version).toBe('string');
  });

  it('mcpTools() returns the 5 tool defs', () => {
    const plugin = createPlugin();
    const tools = plugin.mcpTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'model_freshness_events',
      'model_freshness_scan_now',
      'model_watchlist_add',
      'model_watchlist_list',
      'model_watchlist_remove',
    ]);
  });
});
