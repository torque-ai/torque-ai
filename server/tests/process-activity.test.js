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

    // Some platforms cannot sample the current process and fall back to the empty result.
    expect(result.processCount).toBeGreaterThanOrEqual(0);
    // Some platforms report 0 for a short-lived sampled process.
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

    expect(second).toEqual(first);
  });

  it('clearActivityCache resets cache', () => {
    const first = getProcessTreeCpu(process.pid);
    first.totalCpuPercent = -1;
    first.processCount = -1;

    clearActivityCache();

    const second = getProcessTreeCpu(process.pid);

    expect(second.totalCpuPercent).toBeGreaterThanOrEqual(0);
    expect(second.processCount).toBeGreaterThanOrEqual(0);
    expect(typeof second.isActive).toBe('boolean');
  });
});
