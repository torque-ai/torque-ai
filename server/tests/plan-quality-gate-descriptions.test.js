import { describe, it, expect } from 'vitest';

const planQualityGate = require('../factory/plan-quality-gate');

describe('plan-quality-gate RULES', () => {
  it('every rule has a non-empty string `description` field', () => {
    const rules = planQualityGate.RULES || planQualityGate.default?.RULES;
    expect(rules).toBeDefined();
    const keys = Object.keys(rules);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const rule = rules[key];
      expect(rule.description, `rule "${key}" is missing a description`).toBeTypeOf('string');
      expect(rule.description.length, `rule "${key}" description is empty`).toBeGreaterThan(10);
    }
  });

  it('exports RULES so consumers can iterate', () => {
    const rules = planQualityGate.RULES || planQualityGate.default?.RULES;
    expect(rules).toBeDefined();
    expect(typeof rules).toBe('object');
  });
});
