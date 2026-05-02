'use strict';


describe('architect-runner recovery helpers', () => {
  it('rewriteWorkItem returns parsed JSON from the underlying provider', async () => {
    const mockProvider = vi.fn().mockResolvedValue(JSON.stringify({
      title: 'New T',
      description: 'x'.repeat(150),
      acceptance_criteria: ['must X'],
    }));
    const runner = require('../factory/architect-runner');
    const result = await runner.rewriteWorkItem({
      workItem: { id: 1, title: 'old', description: 'old', reject_reason: 'cannot_generate_plan: x' },
      history: { attempts: 0, priorReason: 'cannot_generate_plan: x', priorDescription: 'old', recoveryRecords: [] },
      _testProviderCall: mockProvider,
    });
    expect(result.title).toBe('New T');
    expect(result.acceptance_criteria).toEqual(['must X']);
    expect(mockProvider).toHaveBeenCalledOnce();
    const promptArg = mockProvider.mock.calls[0][0];
    expect(promptArg).toMatch(/cannot_generate_plan: x/);
    expect(promptArg).toMatch(/strict JSON/i);
    expect(promptArg).toMatch(/Do not inspect the repository or run shell commands/i);
  });

  it('rewriteWorkItem throws on invalid JSON from provider', async () => {
    const mockProvider = vi.fn().mockResolvedValue('not json at all');
    const runner = require('../factory/architect-runner');
    await expect(runner.rewriteWorkItem({
      workItem: { id: 1, title: 't', description: 'd', reject_reason: 'cannot_generate_plan: x' },
      history: { attempts: 0, priorReason: 'cannot_generate_plan: x', priorDescription: 'd', recoveryRecords: [] },
      _testProviderCall: mockProvider,
    })).rejects.toThrow(/invalid|json/i);
  });

  it('decomposeWorkItem includes priorPlans in the prompt', async () => {
    const mockProvider = vi.fn().mockResolvedValue(JSON.stringify({
      children: [
        { title: 'A', description: 'x'.repeat(150), acceptance_criteria: ['x'] },
        { title: 'B', description: 'x'.repeat(150), acceptance_criteria: ['y'] },
      ],
    }));
    const runner = require('../factory/architect-runner');
    const result = await runner.decomposeWorkItem({
      workItem: { id: 1, title: 'parent', description: 'parent', reject_reason: 'plan_quality_gate_rejected_after_2_attempts' },
      history: { attempts: 1, recoveryRecords: [] },
      priorPlans: [{ attempt: 1, planMarkdown: '# Plan A', lintErrors: ['too vague'] }],
      _testProviderCall: mockProvider,
    });
    expect(result.children).toHaveLength(2);
    const promptArg = mockProvider.mock.calls[0][0];
    expect(promptArg).toMatch(/Plan A/);
    expect(promptArg).toMatch(/too vague/);
  });
});
