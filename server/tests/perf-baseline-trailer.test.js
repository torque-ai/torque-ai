'use strict';

const { validateTrailer } = require('../../scripts/perf-baseline-trailer');

describe('perf-baseline-trailer validator', () => {
  it('passes when baseline.json is not in diff', () => {
    const r = validateTrailer({ commitMessage: 'feat: unrelated', changedFiles: ['server/foo.js'] });
    expect(r.ok).toBe(true);
  });

  it('fails when baseline.json is in diff but no trailer present', () => {
    const r = validateTrailer({
      commitMessage: 'perf: tweak something',
      changedFiles: ['server/perf/baseline.json']
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/perf-baseline:/);
  });

  it('passes when trailer is present with non-empty rationale (>20 chars after arrow)', () => {
    const r = validateTrailer({
      commitMessage: `perf: phase 1 ships

perf-baseline: governance evaluate() 1800 to 420 (Phase 1: async git subprocesses replace sync ones)
`,
      changedFiles: ['server/perf/baseline.json']
    });
    expect(r.ok).toBe(true);
  });

  it('fails when rationale is empty (no parens)', () => {
    const r = validateTrailer({
      commitMessage: `perf: x

perf-baseline: foo 100 to 50
`,
      changedFiles: ['server/perf/baseline.json']
    });
    expect(r.ok).toBe(false);
  });

  it('fails when rationale is too short (<20 chars after arrow)', () => {
    const r = validateTrailer({
      commitMessage: `perf: x

perf-baseline: foo 100 to 50 (small)
`,
      changedFiles: ['server/perf/baseline.json']
    });
    expect(r.ok).toBe(false);
  });
});
