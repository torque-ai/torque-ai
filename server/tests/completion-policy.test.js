'use strict';

const {
  isFactoryStructuredOutputTask,
  isFactoryPlanExecutionTask,
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

  it.each(['architect_json', 'replan_decompose', 'replan_rewrite', 'retrospective_generation'])(
    'treats factory %s as structured output',
    (kind) => {
      expect(isFactoryStructuredOutputTask({
        factory_internal: true,
        kind,
      })).toBe(true);
    },
  );

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

  it('disables output-completion grace for factory plan execution tasks', () => {
    const metadata = {
      plan_path: 'C:\\repo\\.worktrees\\fea-123\\docs\\plans\\generated.md',
      plan_task_number: 1,
      plan_task_title: 'Align metadata',
      file_paths: ['.claude-plugin/marketplace.json'],
    };

    expect(isFactoryPlanExecutionTask(metadata)).toBe(true);
    expect(shouldUseOutputCompletionDetection({
      provider: 'codex',
      metadata,
    })).toBe(false);
  });

  it('normalizes JSON-string factory plan execution metadata', () => {
    expect(shouldUseOutputCompletionDetection({
      provider: 'codex',
      metadata: JSON.stringify({
        plan_path: 'C:\\repo\\docs\\plans\\generated.md',
        plan_task_number: 2,
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
