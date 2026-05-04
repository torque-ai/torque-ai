'use strict';
/* global describe, it, expect, afterEach, vi */

const childProcess = require('child_process');

const {
  clearActivityCache,
  forgetPid,
  getProcessTreeCpu,
  getProcessTreeCpuDelta,
  isProcessAlive,
} = require('../utils/process-activity');

describe('utils/process-activity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearActivityCache();
  });

  it('isProcessAlive returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for a non-existent pid', () => {
    expect(isProcessAlive(99999)).toBe(false);
  });

  it('getProcessTreeCpu returns isActive for the current process', () => {
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      const err = new Error('spawn blocked');
      err.code = 'EPERM';
      throw err;
    });
    clearActivityCache();

    const result = getProcessTreeCpu(process.pid);

    expect(result.processCount).toBeGreaterThanOrEqual(1);
    expect(result.totalCpu).toBeGreaterThanOrEqual(0);
    expect(result.totalCpuPercent).toBe(result.totalCpu);
    expect(result.isActive).toBe(true);
  });

  it('cache returns the same result within 2 seconds', () => {
    const first = getProcessTreeCpu(99999);
    const second = getProcessTreeCpu(99999);

    expect(second).toEqual(first);
  });

  it('cache expires after 2 seconds', () => {
    const baseNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(baseNow);

    const first = getProcessTreeCpu(99999);
    first.totalCpu = -1;
    first.totalCpuPercent = -1;
    first.processCount = -1;

    nowSpy.mockReturnValue(baseNow + 2501);
    const second = getProcessTreeCpu(99999);

    expect(second).toEqual({
      totalCpu: 0,
      totalCpuPercent: 0,
      processCount: 0,
      isActive: false,
    });
    expect(second).not.toBe(first);
  });

  describe('getProcessTreeCpuDelta', () => {
    it('returns isAdvancing=false on first sample (baseline only)', () => {
      const first = getProcessTreeCpuDelta(process.pid);
      expect(first.isAdvancing).toBe(false);
      expect(first.deltaMs).toBe(0);
      expect(first.hasBaseline).toBe(false);
    });

    it('returns isAdvancing=true when cumulative CPU advanced between calls', () => {
      const cumulative = { value: 0 };
      const first = getProcessTreeCpuDelta(12345, () => cumulative.value);
      expect(first.isAdvancing).toBe(false);

      cumulative.value = 250;
      const second = getProcessTreeCpuDelta(12345, () => cumulative.value);
      expect(second.isAdvancing).toBe(true);
      expect(second.deltaMs).toBe(250);
      expect(second.hasBaseline).toBe(true);
    });

    it('returns isAdvancing=false when cumulative CPU is unchanged', () => {
      const cumulative = { value: 1000 };
      getProcessTreeCpuDelta(12346, () => cumulative.value);
      const second = getProcessTreeCpuDelta(12346, () => cumulative.value);
      expect(second.isAdvancing).toBe(false);
      expect(second.deltaMs).toBe(0);
      expect(second.hasBaseline).toBe(true);
    });

    it('forgets baseline when sampler returns null (process gone)', () => {
      const cumulative = { value: 500 };
      getProcessTreeCpuDelta(12347, () => cumulative.value);
      const result = getProcessTreeCpuDelta(12347, () => null);
      expect(result.isAdvancing).toBe(false);
      expect(result.hasBaseline).toBe(false);
    });

    it('resets baseline when cumulative CPU drops (PID reuse)', () => {
      const cumulative = { value: 5000 };
      getProcessTreeCpuDelta(12348, () => cumulative.value);
      cumulative.value = 6000;
      const advanced = getProcessTreeCpuDelta(12348, () => cumulative.value);
      expect(advanced.isAdvancing).toBe(true);
      expect(advanced.deltaMs).toBe(1000);

      cumulative.value = 100;
      const reused = getProcessTreeCpuDelta(12348, () => cumulative.value);
      expect(reused.isAdvancing).toBe(false);
      expect(reused.deltaMs).toBe(0);
      expect(reused.hasBaseline).toBe(false);

      cumulative.value = 200;
      const fresh = getProcessTreeCpuDelta(12348, () => cumulative.value);
      expect(fresh.isAdvancing).toBe(true);
      expect(fresh.deltaMs).toBe(100);
      expect(fresh.hasBaseline).toBe(true);
    });
  });

  describe('forgetPid', () => {
    it('clears the cumulative-CPU baseline so the next sample looks like a first call', () => {
      const cumulative = { value: 1000 };
      // Seed baseline.
      getProcessTreeCpuDelta(54321, () => cumulative.value);
      cumulative.value = 1500;
      const advanced = getProcessTreeCpuDelta(54321, () => cumulative.value);
      expect(advanced.hasBaseline).toBe(true);
      expect(advanced.deltaMs).toBe(500);

      forgetPid(54321);

      cumulative.value = 9999;
      const afterForget = getProcessTreeCpuDelta(54321, () => cumulative.value);
      expect(afterForget.hasBaseline).toBe(false);
      expect(afterForget.deltaMs).toBe(0);
      expect(afterForget.isAdvancing).toBe(false);
    });

    it('is a no-op for non-numeric or zero/negative pids', () => {
      expect(() => forgetPid(null)).not.toThrow();
      expect(() => forgetPid(undefined)).not.toThrow();
      expect(() => forgetPid(0)).not.toThrow();
      expect(() => forgetPid(-5)).not.toThrow();
      expect(() => forgetPid('abc')).not.toThrow();
    });
  });
});
