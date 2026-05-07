'use strict';

const {
  isFactoryStructuredOutputTask,
  isScoutStructuredOutputTask,
  shouldUseOutputCompletionDetection,
} = require('../execution/completion-policy');

describe('completion-policy', () => {
  it('disables output-completion grace for factory structured-output tasks', () => {
    const metadata = {
      factory_internal: true,
      kind: 'plan_generation',
    };

    expect(isFactoryStructuredOutputTask(metadata)).toBe(true);
    expect(shouldUseOutputCompletionDetection({
      provider: 'codex',
      metadata,
    })).toBe(false);
  });

  it('normalizes JSON-string metadata before deciding', () => {
    expect(shouldUseOutputCompletionDetection({
      provider: 'codex',
      metadata: JSON.stringify({
        factory_internal: true,
        kind: 'architect_cycle',
      }),
    })).toBe(false);
  });

  it('disables output-completion grace for starvation recovery scouts', () => {
    const metadata = {
      mode: 'scout',
      diffusion: true,
      reason: 'factory_starvation_recovery',
    };

    expect(isScoutStructuredOutputTask(metadata)).toBe(true);
    expect(shouldUseOutputCompletionDetection({
      provider: 'codex',
      metadata,
    })).toBe(false);
  });

  it('disables output-completion grace for factory scout kind metadata', () => {
    expect(shouldUseOutputCompletionDetection({
      provider: 'codex',
      metadata: JSON.stringify({
        factory_internal: true,
        kind: 'scout',
      }),
    })).toBe(false);
  });

  it('keeps completion grace enabled for ordinary Codex execution tasks', () => {
    expect(shouldUseOutputCompletionDetection({
      provider: 'codex',
      metadata: {
        factory_internal: false,
        kind: 'execute',
      },
    })).toBe(true);
  });
});
