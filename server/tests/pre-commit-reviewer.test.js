'use strict';

const { reviewDiff } = require('../review/pre-commit-reviewer');

describe('reviewDiff', () => {
  it('passes a clean diff with no issues', async () => {
    const runLLM = vi.fn().mockResolvedValue({ verdict: 'pass', issues: [], suggestions: [] });
    const result = await reviewDiff({
      diff: 'diff --git a/x.js b/x.js\n+ const safe = 1;\n',
      runLLM,
    });
    expect(result.verdict).toBe('pass');
    expect(result.issues).toEqual([]);
  });

  it('returns warn when reviewer flags non-blocking issues', async () => {
    const runLLM = vi.fn().mockResolvedValue({
      verdict: 'warn',
      issues: [{ severity: 'medium', file: 'x.js', line: 5, note: 'no error handling' }],
      suggestions: ['add try/catch'],
    });
    const result = await reviewDiff({ diff: '...', runLLM });
    expect(result.verdict).toBe('warn');
    expect(result.issues).toHaveLength(1);
  });

  it('passes reviewerProvider through to the LLM runner', async () => {
    const runLLM = vi.fn().mockResolvedValue({ verdict: 'pass', issues: [], suggestions: [] });
    await reviewDiff({
      diff: 'diff --git a/x.js b/x.js\n+ const safe = 1;\n',
      reviewerProvider: 'anthropic',
      runLLM,
    });
    expect(runLLM).toHaveBeenCalledWith(expect.any(String), { reviewerProvider: 'anthropic' });
  });

  it('falls back to "pass" with annotation when LLM throws', async () => {
    const runLLM = vi.fn().mockRejectedValue(new Error('llm down'));
    const result = await reviewDiff({ diff: '...', runLLM });
    expect(result.verdict).toBe('pass');
    expect(result.issues[0].note).toMatch(/reviewer unavailable/i);
  });

  it('falls back to "pass" when LLM returns malformed JSON', async () => {
    const runLLM = vi.fn().mockResolvedValue({ not_a_verdict: true });
    const result = await reviewDiff({ diff: '...', runLLM });
    expect(result.verdict).toBe('pass');
    expect(result.issues[0].note).toMatch(/schema|invalid|malformed/i);
  });
});
