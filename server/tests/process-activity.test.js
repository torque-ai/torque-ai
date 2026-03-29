'use strict';
/* global describe, it, expect, afterEach, vi */

const childProcess = require('child_process');

const {
  clearActivityCache,
  getProcessTreeCpu,
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
});
