'use strict';

describe('deepMerge prototype pollution', () => {
  it('does not pollute Object prototype via __proto__', () => {
    // mergeConfig calls deepMerge internally
    const { mergeConfig } = require('../orchestrator/config-loader');
    expect(({}).polluted).toBeUndefined();

    // JSON.parse creates a real __proto__ key (not the prototype accessor)
    const malicious = JSON.parse('{"__proto__": {"polluted": "yes"}}');
    mergeConfig(malicious, null, { safe: true });

    expect(({}).polluted).toBeUndefined();
  });

  it('does not pollute via constructor.prototype', () => {
    const { mergeConfig } = require('../orchestrator/config-loader');
    expect(({}).polluted2).toBeUndefined();

    const malicious = { constructor: { prototype: { polluted2: 'yes' } } };
    mergeConfig(malicious, null, { safe: true });

    expect(({}).polluted2).toBeUndefined();
  });

  it('preserves legitimate keys while blocking dangerous ones', () => {
    const { mergeConfig } = require('../orchestrator/config-loader');
    const input = JSON.parse('{"__proto__": {"bad": true}, "good_key": "value"}');
    const result = mergeConfig(input, null, {});
    expect(result.good_key).toBe('value');
    expect(({}).bad).toBeUndefined();
  });
});
