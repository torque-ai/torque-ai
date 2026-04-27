'use strict';
/* global describe, it, expect, vi */

const { augment } = require('../factory/plan-augmenter');

describe('plan-augmenter', () => {
  it('returns plan unchanged if all tasks have acceptance criteria', async () => {
    const plan = { tasks: [
      { description: 'Do X', verify: 'npm test' },
      { description: 'Do Y', assert: 'lints clean' },
    ]};
    const result = await augment(plan, { verify_command: 'npm test' }, {});
    expect(result.augmented).toBe(0);
    expect(result.plan.tasks).toEqual(plan.tasks);
  });

  it('augments missing acceptance criteria via deterministic fallback when no Groq client', async () => {
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, { verify_command: 'npm test' }, {});
    expect(result.augmented).toBe(1);
    expect(result.fallback).toBe(1);
    expect(result.plan.tasks[0].verify).toMatch(/npm test/);
  });

  it('uses Groq when available', async () => {
    const groqClient = vi.fn().mockResolvedValue({
      tasks: [{ description: 'Do X', verify: 'pytest -k test_x and assert exit 0' }],
    });
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, { verify_command: 'pytest' }, { groqClient });
    expect(groqClient).toHaveBeenCalled();
    expect(result.augmented).toBe(1);
    expect(result.fallback).toBe(0);
    expect(result.plan.tasks[0].verify).toContain('pytest');
  });

  it('falls back to deterministic template on Groq failure', async () => {
    const groqClient = vi.fn().mockRejectedValue(new Error('groq down'));
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, { verify_command: 'npm test' }, { groqClient });
    expect(result.augmented).toBe(1);
    expect(result.fallback).toBe(1);
    expect(result.plan.tasks[0].verify).toMatch(/npm test/);
  });

  it('falls back when Groq returns malformed JSON', async () => {
    const groqClient = vi.fn().mockResolvedValue({ totally: 'wrong shape' });
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, { verify_command: 'npm test' }, { groqClient });
    expect(result.fallback).toBe(1);
  });

  it('skips augmentation when project has no verify_command', async () => {
    const plan = { tasks: [{ description: 'Do X' }] };
    const result = await augment(plan, {}, {});
    expect(result.augmented).toBe(0);
    expect(result.plan.tasks[0].verify).toBeUndefined();
  });

  it('handles empty/null plan gracefully', async () => {
    const result = await augment(null, { verify_command: 'npm test' }, {});
    expect(result.plan).toBeNull();
    expect(result.augmented).toBe(0);
  });

  it('preserves existing fields on augmented tasks', async () => {
    const plan = { tasks: [{ description: 'Do X', priority: 5, files: ['x.js'] }] };
    const result = await augment(plan, { verify_command: 'npm test' }, {});
    expect(result.plan.tasks[0].priority).toBe(5);
    expect(result.plan.tasks[0].files).toEqual(['x.js']);
    expect(result.plan.tasks[0].verify).toBeDefined();
  });
});
