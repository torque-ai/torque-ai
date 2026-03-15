const { isHostOverloaded, checkResourceGate, getThresholds, RESOURCE_THRESHOLDS } = require('../utils/resource-gate');

describe('resource-gate', () => {
  describe('RESOURCE_THRESHOLDS', () => {
    it('defaults to 85 for both CPU and RAM', () => {
      expect(RESOURCE_THRESHOLDS.cpu).toBe(85);
      expect(RESOURCE_THRESHOLDS.ram).toBe(85);
    });
  });

  describe('isHostOverloaded', () => {
    it('returns false when metrics are below threshold', () => {
      expect(isHostOverloaded({ cpuPercent: 50, ramPercent: 60 })).toBe(false);
    });

    it('returns true when CPU exceeds threshold', () => {
      expect(isHostOverloaded({ cpuPercent: 90, ramPercent: 60 })).toBe(true);
    });

    it('returns true when RAM exceeds threshold', () => {
      expect(isHostOverloaded({ cpuPercent: 50, ramPercent: 92 })).toBe(true);
    });

    it('returns true when both exceed threshold', () => {
      expect(isHostOverloaded({ cpuPercent: 90, ramPercent: 95 })).toBe(true);
    });

    it('returns true at exactly 85%', () => {
      expect(isHostOverloaded({ cpuPercent: 85, ramPercent: 50 })).toBe(true);
    });

    it('returns false when metrics are null (unknown = pass)', () => {
      expect(isHostOverloaded(null)).toBe(false);
      expect(isHostOverloaded({})).toBe(false);
      expect(isHostOverloaded({ cpuPercent: null, ramPercent: null })).toBe(false);
    });

    it('checks only available metrics', () => {
      expect(isHostOverloaded({ cpuPercent: 90 })).toBe(true);
      expect(isHostOverloaded({ ramPercent: 90 })).toBe(true);
      expect(isHostOverloaded({ cpuPercent: 50 })).toBe(false);
    });

    it('respects custom thresholds', () => {
      const metrics = { cpuPercent: 70, ramPercent: 70 };
      expect(isHostOverloaded(metrics, { cpu: 60, ram: 60 })).toBe(true);
      expect(isHostOverloaded(metrics, { cpu: 80, ram: 80 })).toBe(false);
    });
  });

  describe('getThresholds', () => {
    it('returns defaults when no db provided', () => {
      expect(getThresholds()).toEqual({ cpu: 85, ram: 85 });
      expect(getThresholds(null)).toEqual({ cpu: 85, ram: 85 });
    });

    it('reads from config when db provided', () => {
      const mockDb = {
        getConfig: vi.fn((key) => {
          if (key === 'resource_gate_cpu_threshold') return '70';
          if (key === 'resource_gate_ram_threshold') return '75';
          return null;
        }),
      };
      expect(getThresholds(mockDb)).toEqual({ cpu: 70, ram: 75 });
    });

    it('falls back to defaults on db error', () => {
      const mockDb = { getConfig: () => { throw new Error('db closed'); } };
      expect(getThresholds(mockDb)).toEqual({ cpu: 85, ram: 85 });
    });
  });

  describe('checkResourceGate', () => {
    it('returns allowed when no hosts are overloaded', () => {
      const cache = new Map();
      cache.set('host-1', { gpuMetrics: { cpuPercent: 50, ramPercent: 60 } });
      expect(checkResourceGate(cache, 'host-1').allowed).toBe(true);
    });

    it('returns not allowed with reason when host is overloaded', () => {
      const cache = new Map();
      cache.set('host-1', { gpuMetrics: { cpuPercent: 92, ramPercent: 60 } });
      const result = checkResourceGate(cache, 'host-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('CPU');
      expect(result.reason).toContain('92%');
    });

    it('returns allowed when host has no cached data', () => {
      const cache = new Map();
      expect(checkResourceGate(cache, 'unknown-host').allowed).toBe(true);
    });

    it('returns allowed when hostId is null (local execution)', () => {
      const cache = new Map();
      expect(checkResourceGate(cache, null).allowed).toBe(true);
    });

    it('uses config-based thresholds when db is provided', () => {
      const mockDb = {
        getConfig: vi.fn((key) => {
          if (key === 'resource_gate_cpu_threshold') return '70';
          if (key === 'resource_gate_ram_threshold') return '75';
          return null;
        }),
      };
      const cache = new Map();
      cache.set('h1', { gpuMetrics: { cpuPercent: 72, ramPercent: 60 } });
      const result = checkResourceGate(cache, 'h1', mockDb);
      expect(result.allowed).toBe(false);
      expect(mockDb.getConfig).toHaveBeenCalledWith('resource_gate_cpu_threshold');
      expect(mockDb.getConfig).toHaveBeenCalledWith('resource_gate_ram_threshold');
    });

    it('includes RAM in reason when RAM exceeds threshold', () => {
      const cache = new Map();
      cache.set('h1', { gpuMetrics: { cpuPercent: 40, ramPercent: 88 } });
      const result = checkResourceGate(cache, 'h1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('RAM');
      expect(result.reason).toContain('88%');
    });
  });
});
