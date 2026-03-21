'use strict';
/* global describe, it, expect, afterEach */

const {
  clearActivityCache,
  getProcessTreeCpu,
} = require('../utils/process-activity');

describe('utils/process-activity', () => {
  afterEach(() => {
    clearActivityCache();
  });

  it('returns activity for current process', () => {
    const result = getProcessTreeCpu(process.pid);

    expect(result.processCount).toBeGreaterThanOrEqual(1);
    expect(result.totalCpuPercent).toBeGreaterThanOrEqual(0);
    expect(typeof result.isActive).toBe('boolean');
  });

  it('returns inactive for non-existent pid', () => {
    const result = getProcessTreeCpu(999999);

    expect(result).toEqual({
      totalCpuPercent: 0,
      processCount: 0,
      isActive: false,
    });
  });

  it('caches results for 2 seconds', () => {
    const first = getProcessTreeCpu(process.pid);
    const second = getProcessTreeCpu(process.pid);

    expect(second).toBe(first);
  });

  it('clearActivityCache resets cache', () => {
    const first = getProcessTreeCpu(process.pid);

    clearActivityCache();

    const second = getProcessTreeCpu(process.pid);

    expect(second).not.toBe(first);
    expect(second.processCount).toBeGreaterThanOrEqual(1);
  });
});
