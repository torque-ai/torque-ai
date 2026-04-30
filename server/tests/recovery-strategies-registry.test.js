'use strict';

const { describe, it, expect, beforeEach } = require('vitest');
const { createRegistry } = require('../factory/recovery-strategies/registry');

const stubStrategy = (overrides = {}) => ({
  name: overrides.name || 'stub',
  reasonPatterns: overrides.reasonPatterns || [/^stub_reason$/],
  async replan() { return { outcome: 'rewrote', updates: {} }; },
  ...overrides,
});

describe('recovery-strategies registry', () => {
  let registry;
  beforeEach(() => { registry = createRegistry(); });

  it('finds a registered strategy by reject_reason', () => {
    registry.register(stubStrategy({
      name: 'rewrite',
      reasonPatterns: [/^cannot_generate_plan:/i],
    }));
    const found = registry.findByReason('cannot_generate_plan: empty desc');
    expect(found).not.toBeNull();
    expect(found.name).toBe('rewrite');
  });

  it('returns null when no strategy matches', () => {
    expect(registry.findByReason('unknown_reason')).toBeNull();
  });

  it('throws on overlap with an already-registered pattern', () => {
    registry.register(stubStrategy({
      name: 'first',
      reasonPatterns: [/^cannot_generate_plan:/i],
    }));
    expect(() => registry.register(stubStrategy({
      name: 'second',
      reasonPatterns: [/^cannot_generate_plan: empty/i],
    }))).toThrow(/overlap/i);
  });

  it('throws when strategy is missing required shape', () => {
    expect(() => registry.register({ name: 'bad' })).toThrow();
    expect(() => registry.register({ reasonPatterns: [/x/] })).toThrow();
    expect(() => registry.register({ name: 'bad', reasonPatterns: [/x/] })).toThrow(/replan/i);
  });

  it('lists all registered strategies', () => {
    registry.register(stubStrategy({ name: 'a', reasonPatterns: [/^a$/] }));
    registry.register(stubStrategy({ name: 'b', reasonPatterns: [/^b$/] }));
    const list = registry.list();
    expect(list.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('exposes a flattened reason-pattern view (for disjointness check vs. rejected-recovery)', () => {
    registry.register(stubStrategy({
      name: 'rewrite',
      reasonPatterns: [/^cannot_generate_plan:/i, /^Rejected by user$/],
    }));
    const all = registry.allReasonPatterns();
    expect(all.length).toBe(2);
    expect(all.some((p) => p.test('cannot_generate_plan: x'))).toBe(true);
    expect(all.some((p) => p.test('Rejected by user'))).toBe(true);
  });
});
