'use strict';
const { createRegistry } = require('../factory/auto-recovery/registry');

describe('auto-recovery registry', () => {
  it('merges rules from plugins, sorted by priority desc', () => {
    const reg = createRegistry();
    reg.registerFromPlugin('A', {
      classifierRules: [{ name: 'a1', category: 'transient', priority: 10, match: {} }],
      recoveryStrategies: [],
    });
    reg.registerFromPlugin('B', {
      classifierRules: [{ name: 'b1', category: 'transient', priority: 20, match: {} }],
      recoveryStrategies: [],
    });
    expect(reg.getRules().map(r => r.name)).toEqual(['b1', 'a1']);
  });

  it('merges strategies from plugins by name', () => {
    const reg = createRegistry();
    reg.registerFromPlugin('A', {
      classifierRules: [],
      recoveryStrategies: [{ name: 'retry', applicable_categories: ['transient'], run: async () => ({}) }],
    });
    reg.registerFromPlugin('B', {
      classifierRules: [],
      recoveryStrategies: [{ name: 'escalate', applicable_categories: ['any'], run: async () => ({}) }],
    });
    expect(reg.getStrategyByName('retry')).toBeTruthy();
    expect(reg.getStrategyByName('escalate')).toBeTruthy();
    expect(reg.getStrategyByName('missing')).toBeNull();
  });

  it('pick() returns the first suggested strategy applicable to the category', () => {
    const reg = createRegistry();
    reg.registerFromPlugin('p', {
      classifierRules: [],
      recoveryStrategies: [
        { name: 'retry', applicable_categories: ['transient'], run: async () => ({}) },
        { name: 'escalate', applicable_categories: ['unknown', 'terminal'], run: async () => ({}) },
      ],
    });
    const picked = reg.pick({
      category: 'transient',
      suggested_strategies: ['clean_and_retry', 'retry'],
    });
    expect(picked.name).toBe('retry');
  });

  it('pick() returns null when no suggested strategies apply', () => {
    const reg = createRegistry();
    expect(reg.pick({ category: 'x', suggested_strategies: ['none'] })).toBeNull();
  });

  it('rejects malformed rules, keeps valid ones', () => {
    const reg = createRegistry({ logger: { warn: () => {} } });
    reg.registerFromPlugin('p', {
      classifierRules: [
        { name: 'good', category: 'transient', priority: 1, match: {} },
        { category: 'bad' },
      ],
      recoveryStrategies: [],
    });
    expect(reg.getRules().map(r => r.name)).toEqual(['good']);
  });

  it('rejects strategies without run()', () => {
    const reg = createRegistry({ logger: { warn: () => {} } });
    reg.registerFromPlugin('p', {
      classifierRules: [],
      recoveryStrategies: [
        { name: 'nope', applicable_categories: ['any'] },
        { name: 'ok', applicable_categories: ['any'], run: async () => ({}) },
      ],
    });
    expect(reg.getStrategyByName('nope')).toBeNull();
    expect(reg.getStrategyByName('ok')).toBeTruthy();
  });

  it('getStrategies() returns all registered strategies', () => {
    const reg = createRegistry();
    reg.registerFromPlugin('p', {
      classifierRules: [],
      recoveryStrategies: [
        { name: 's1', applicable_categories: ['a'], run: async () => ({}) },
        { name: 's2', applicable_categories: ['b'], run: async () => ({}) },
      ],
    });
    expect(reg.getStrategies().map(s => s.name).sort()).toEqual(['s1', 's2']);
  });
});
