import { describe, it, expect } from 'vitest';

const {
  checkResourceGate,
  isHostOverloaded,
  getThresholds,
  RESOURCE_THRESHOLDS,
} = require('../utils/resource-gate');

describe('resource-gate integration', () => {
  it('full flow: cache to gate to decision', () => {
    const cache = new Map();

    cache.set('host-ok', { gpuMetrics: { cpuPercent: 60, ramPercent: 70 } });
    expect(checkResourceGate(cache, 'host-ok').allowed).toBe(true);

    cache.set('host-cpu-high', { gpuMetrics: { cpuPercent: 92, ramPercent: 50 } });
    const cpuResult = checkResourceGate(cache, 'host-cpu-high');
    expect(cpuResult.allowed).toBe(false);
    expect(cpuResult.reason).toContain('CPU');

    cache.set('host-ram-high', { gpuMetrics: { cpuPercent: 40, ramPercent: 88 } });
    const ramResult = checkResourceGate(cache, 'host-ram-high');
    expect(ramResult.allowed).toBe(false);
    expect(ramResult.reason).toContain('RAM');

    cache.set('host-both-high', { gpuMetrics: { cpuPercent: 90, ramPercent: 95 } });
    const bothResult = checkResourceGate(cache, 'host-both-high');
    expect(bothResult.allowed).toBe(false);
    expect(bothResult.reason).toContain('CPU');
    expect(bothResult.reason).toContain('RAM');

    expect(checkResourceGate(cache, 'nonexistent').allowed).toBe(true);
    expect(checkResourceGate(cache, null).allowed).toBe(true);
  });

  it('isHostOverloaded boundary tests', () => {
    expect(isHostOverloaded({ cpuPercent: 85, ramPercent: 0 })).toBe(true);
    expect(isHostOverloaded({ cpuPercent: 0, ramPercent: 85 })).toBe(true);

    expect(isHostOverloaded({ cpuPercent: 84, ramPercent: 84 })).toBe(false);

    expect(isHostOverloaded({ cpuPercent: 100, ramPercent: 100 })).toBe(true);

    expect(isHostOverloaded({ cpuPercent: 0, ramPercent: 0 })).toBe(false);
  });

  it('getThresholds returns correct defaults', () => {
    const defaults = getThresholds();
    expect(defaults.cpu).toBe(85);
    expect(defaults.ram).toBe(85);
  });

  it('RESOURCE_THRESHOLDS is exported correctly', () => {
    expect(RESOURCE_THRESHOLDS).toEqual({ cpu: 85, ram: 85 });
  });

  it('checkResourceGate reason includes percentage values', () => {
    const cache = new Map();
    cache.set('h1', { gpuMetrics: { cpuPercent: 95, ramPercent: 91 } });
    const result = checkResourceGate(cache, 'h1');
    expect(result.reason).toContain('95%');
    expect(result.reason).toContain('91%');
  });
});
