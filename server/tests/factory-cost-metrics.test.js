import { describe, it, expect } from 'vitest';

const { getCostPerCycle, getCostPerHealthPoint, getProviderEfficiency } = require('../factory/cost-metrics');

describe('factory cost metrics', () => {
  it('returns zero for unknown project', () => {
    expect(getCostPerCycle('nonexistent')).toBe(0);
    expect(getCostPerHealthPoint('nonexistent')).toBe(0);
  });

  it('returns empty array for provider efficiency with no data', () => {
    expect(getProviderEfficiency('nonexistent')).toEqual([]);
  });

  it('returns zero for null project_id', () => {
    expect(getCostPerCycle(null)).toBe(0);
    expect(getCostPerHealthPoint(null)).toBe(0);
    expect(getProviderEfficiency(null)).toEqual([]);
  });

  it('exports all 3 metric functions', () => {
    expect(typeof getCostPerCycle).toBe('function');
    expect(typeof getCostPerHealthPoint).toBe('function');
    expect(typeof getProviderEfficiency).toBe('function');
  });
});
