import { describe, it, expect } from 'vitest';

const { classifyZeroDiff, HEURISTIC_PATTERNS } = require('../factory/completion-rationale');

describe('classifyZeroDiff — heuristic layer', () => {
  const cases = [
    ['already_in_place', [
      'The change is already in place.',
      'This code already satisfies the requirement.',
      'No changes needed — module already implements the API.',
      'Already present in src/foo.ts.',
      'Nothing to change.',
      'No modifications required.',
    ]],
    ['blocked', [
      'I cannot proceed without write access.',
      'Blocked by a missing dependency.',
      'Permission denied on src/secrets/.env.',
      'Refusing to edit files outside the worktree.',
    ]],
    ['precondition_missing', [
      'File does not exist at src/foo/bar.ts.',
      'No such file or directory: build/output.json.',
      'Module not found: "@torque/xyz".',
      'Path not found in the configured tree.',
    ]],
  ];

  for (const [bucket, samples] of cases) {
    for (const text of samples) {
      it(`classifies "${text.slice(0, 40)}..." as ${bucket}`, async () => {
        const res = await classifyZeroDiff({ stdout_tail: text, attempt: 1, kind: 'execute' });
        expect(res.reason).toBe(bucket);
        expect(res.source).toBe('heuristic');
        expect(res.confidence).toBe(1.0);
      });
    }
  }

  it('returns unknown with source=none when no pattern matches and no LLM router supplied', async () => {
    const res = await classifyZeroDiff({ stdout_tail: 'Task complete. Summary: ok.', attempt: 1, kind: 'execute' });
    expect(res.reason).toBe('unknown');
    expect(res.source).toBe('none');
    expect(res.confidence).toBe(0);
  });

  it('pins already_in_place confidence to 0 when attempt > 1', async () => {
    const res = await classifyZeroDiff({
      stdout_tail: 'Already in place.',
      attempt: 2,
      kind: 'verify_retry',
    });
    expect(res.reason).toBe('already_in_place');
    expect(res.confidence).toBe(0);
    expect(res.source).toBe('heuristic');
  });

  it('is case-insensitive on heuristic matching', async () => {
    const res = await classifyZeroDiff({ stdout_tail: 'ALREADY IN PLACE', attempt: 1, kind: 'execute' });
    expect(res.reason).toBe('already_in_place');
  });

  it('never throws on malformed input', async () => {
    const results = await Promise.all([
      classifyZeroDiff({ stdout_tail: null, attempt: 1, kind: 'execute' }),
      classifyZeroDiff({ stdout_tail: undefined, attempt: 1, kind: 'execute' }),
      classifyZeroDiff({ stdout_tail: '', attempt: 1, kind: 'execute' }),
      classifyZeroDiff({}),
    ]);
    for (const r of results) {
      expect(r.reason).toBe('unknown');
    }
  });

  it('exports pattern list for external inspection', () => {
    expect(HEURISTIC_PATTERNS.already_in_place.length).toBeGreaterThan(0);
    expect(HEURISTIC_PATTERNS.blocked.length).toBeGreaterThan(0);
    expect(HEURISTIC_PATTERNS.precondition_missing.length).toBeGreaterThan(0);
  });
});

describe('classifyZeroDiff — LLM fallback', () => {
  it('invokes llmRouter only when heuristic misses', async () => {
    let calls = 0;
    const llmRouter = async () => { calls += 1; return 'blocked'; };
    const hit = await classifyZeroDiff({
      stdout_tail: 'Already in place.', attempt: 1, kind: 'execute', llmRouter,
    });
    const miss = await classifyZeroDiff({
      stdout_tail: 'Task did unusual thing.', attempt: 1, kind: 'execute', llmRouter,
    });
    expect(hit.source).toBe('heuristic');
    expect(miss.source).toBe('llm');
    expect(miss.reason).toBe('blocked');
    expect(miss.confidence).toBe(0.7);
    expect(calls).toBe(1);
  });

  it('returns unknown when llmRouter replies with unparseable text', async () => {
    const llmRouter = async () => 'the vibe is unclear';
    const res = await classifyZeroDiff({
      stdout_tail: 'Task did unusual thing.', attempt: 1, kind: 'execute', llmRouter,
    });
    expect(res.reason).toBe('unknown');
  });

  it('returns unknown when llmRouter throws', async () => {
    const llmRouter = async () => { throw new Error('boom'); };
    const res = await classifyZeroDiff({
      stdout_tail: 'Task did unusual thing.', attempt: 1, kind: 'execute', llmRouter,
    });
    expect(res.reason).toBe('unknown');
  });

  it('respects timeoutMs on hanging llmRouter', async () => {
    const llmRouter = () => new Promise((resolve) => setTimeout(() => resolve('blocked'), 2000));
    const start = Date.now();
    const res = await classifyZeroDiff({
      stdout_tail: 'Task did unusual thing.',
      attempt: 1, kind: 'execute', llmRouter, timeoutMs: 50,
    });
    expect(Date.now() - start).toBeLessThan(500);
    expect(res.reason).toBe('unknown');
  });

  it('trims and validates llmRouter response against the bucket set', async () => {
    const samples = [
      ['  already_in_place  ', 'already_in_place'],
      ['BLOCKED', 'blocked'],
      ['Precondition_Missing', 'precondition_missing'],
      ['unknown', 'unknown'],
    ];
    for (const [input, expected] of samples) {
      const llmRouter = async () => input;
      const res = await classifyZeroDiff({
        stdout_tail: 'Task did unusual thing.', attempt: 1, kind: 'execute', llmRouter,
      });
      expect(res.reason).toBe(expected);
    }
  });
});
