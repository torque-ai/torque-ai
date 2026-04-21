import { describe, it, expect } from 'vitest';

const { buildVerifyFixPrompt, __testing__ } = require('../factory/loop-controller');

const basePlan = {
  planPath: 'docs/superpowers/plans/x.md',
  planTitle: 'X Plan',
  branch: 'feat/x',
  verifyCommand: 'npm test',
  verifyOutput: ' FAIL foo.test.ts > handles empty array\n',
};

describe('buildVerifyFixPrompt — prior-attempts block', () => {
  it('omits the prior-attempts section when priorAttempts is empty', () => {
    const p = buildVerifyFixPrompt({ ...basePlan, priorAttempts: [], verifyOutputPrev: null });
    expect(p).not.toMatch(/Prior attempts/);
    expect(p).toMatch(/Verify output \(tail\)/);
  });

  it('omits the prior-attempts section when priorAttempts is undefined', () => {
    const p = buildVerifyFixPrompt(basePlan);
    expect(p).not.toMatch(/Prior attempts/);
  });

  it('renders one attempt row with kind label, file count, touched files, and Codex summary', () => {
    const p = buildVerifyFixPrompt({
      ...basePlan,
      priorAttempts: [{
        attempt: 1, kind: 'execute', file_count: 2,
        files_touched: ['src/foo.ts', 'src/bar.ts'],
        stdout_tail: 'Added early-return guard.',
        zero_diff_reason: null,
      }],
    });
    expect(p).toMatch(/Prior attempts on this work item/);
    expect(p).toMatch(/Attempt 1 \(execute\): 2 files touched/);
    expect(p).toMatch(/src\/foo\.ts/);
    expect(p).toMatch(/Codex summary: "Added early-return guard\."/);
  });

  it('renders zero-diff attempt with classifier reason', () => {
    const p = buildVerifyFixPrompt({
      ...basePlan,
      priorAttempts: [{
        attempt: 2, kind: 'verify_retry', file_count: 0, files_touched: [],
        stdout_tail: 'The guard is already present.',
        zero_diff_reason: 'already_in_place',
      }],
    });
    expect(p).toMatch(/0 files touched — classified as `already_in_place`/);
  });

  it('renders the progression line when both outputs have extractable test sets', () => {
    const p = buildVerifyFixPrompt({
      ...basePlan,
      verifyOutput: ' FAIL foo.test.ts > handles empty array\n',
      verifyOutputPrev: ' FAIL foo.test.ts > rejects null\n FAIL foo.test.ts > handles empty array\n',
      priorAttempts: [{ attempt: 1, kind: 'execute', file_count: 1, files_touched: ['src/foo.ts'], stdout_tail: '', zero_diff_reason: null }],
    });
    expect(p).toMatch(/Verify error progression/);
    expect(p).toMatch(/Previous run failed with/);
    expect(p).toMatch(/This run is failing with/);
  });

  it('caps prior-attempts block at VERIFY_FIX_PROMPT_PRIOR_BUDGET, trimming oldest first', () => {
    const longAttempts = Array.from({ length: 6 }, (_, i) => ({
      attempt: i + 1,
      kind: 'execute',
      file_count: 3,
      files_touched: ['a.ts', 'b.ts', 'c.ts'],
      stdout_tail: 'x'.repeat(500),
      zero_diff_reason: null,
    }));
    const p = buildVerifyFixPrompt({ ...basePlan, priorAttempts: longAttempts });
    const block = p.match(/Prior attempts on this work item:\n([\s\S]+?)\n\nConstraints:/);
    expect(block).toBeTruthy();
    expect(block[1].length).toBeLessThanOrEqual(__testing__.VERIFY_FIX_PROMPT_PRIOR_BUDGET + 200);
    expect(p).toMatch(/\(\d+ earlier attempts elided\)/);
  });

  it('truncates files_touched to first 5 with "(+N more)" suffix', () => {
    const manyFiles = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
    const p = buildVerifyFixPrompt({
      ...basePlan,
      priorAttempts: [{ attempt: 1, kind: 'execute', file_count: 8, files_touched: manyFiles, stdout_tail: '', zero_diff_reason: null }],
    });
    expect(p).toMatch(/f0\.ts.*f1\.ts.*f2\.ts.*f3\.ts.*f4\.ts.*\(\+3 more\)/);
  });
});
