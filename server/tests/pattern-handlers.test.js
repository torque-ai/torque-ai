'use strict';

const { createPatternHandlers } = require('../handlers/pattern-handlers');

describe('pattern-handlers', () => {
  it('lists patterns from the injected store', async () => {
    const handlers = createPatternHandlers({
      patternsStore: {
        sourceDir: '/repo/.torque/patterns',
        list: () => [
          {
            name: 'extract_wisdom',
            description: 'Pull insights',
            tags: ['summary'],
            variables: ['input'],
            source_dir: '/repo/.torque/patterns/extract_wisdom',
          },
        ],
      },
    });

    const result = await handlers.handleListPatterns();

    expect(result.count).toBe(1);
    expect(result.patterns[0]).toEqual({
      name: 'extract_wisdom',
      description: 'Pull insights',
      tags: ['summary'],
      variables: ['input'],
      source_dir: '/repo/.torque/patterns/extract_wisdom',
    });
  });

  it('describes a named pattern and returns a structured not-found error', async () => {
    const handlers = createPatternHandlers({
      patternsStore: {
        get: (name) => (name === 'known'
          ? { name: 'known', system: 'System prompt', user_template: 'User prompt' }
          : null),
      },
    });

    const success = await handlers.handleDescribePattern({ name: 'known' });
    const missing = await handlers.handleDescribePattern({ name: 'missing' });

    expect(success.pattern).toEqual({
      name: 'known',
      system: 'System prompt',
      user_template: 'User prompt',
    });
    expect(missing.isError).toBe(true);
    expect(missing.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('runs a pattern through provider.runPrompt when available', async () => {
    const runPrompt = vi.fn(async () => 'pattern output');
    const handlers = createPatternHandlers({
      patternsStore: {
        get: () => ({
          name: 'extract_wisdom',
          system: 'System prompt',
          user_template: 'Topic: {{topic}}\n\n{{input}}',
        }),
      },
      providerRegistry: {
        getProviderInstance: vi.fn(() => ({ name: 'codex', runPrompt })),
      },
    });

    const result = await handlers.handleRunPattern({
      name: 'extract_wisdom',
      input: 'Long text',
      vars: { topic: 'architecture' },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('pattern output');
    expect(runPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'System prompt\n\nTopic: architecture\n\nLong text',
      max_tokens: 2000,
    }));
  });

  it('falls back to provider.submit when runPrompt is unavailable', async () => {
    const submit = vi.fn(async () => ({ output: 'submitted output' }));
    const handlers = createPatternHandlers({
      patternsStore: {
        get: () => ({
          name: 'summarize',
          system: 'System prompt',
          user_template: '{{input}}',
        }),
      },
      providerRegistry: {
        getProviderInstance: vi.fn(() => ({ name: 'other', submit })),
      },
    });

    const result = await handlers.handleRunPattern({
      name: 'summarize',
      input: 'Plain text',
      provider: 'other',
    });

    expect(result.output).toBe('submitted output');
    expect(submit).toHaveBeenCalledWith('System prompt\n\nPlain text', null, expect.objectContaining({
      transport: 'api',
      maxTokens: 2000,
      raw_prompt: true,
    }));
  });
});
