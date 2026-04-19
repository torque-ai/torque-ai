'use strict';

describe('DEFAULT_PLUGIN_NAMES', () => {
  it('includes model-freshness', () => {
    const src = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    expect(src).toMatch(/DEFAULT_PLUGIN_NAMES.*model-freshness/s);
  });
});
