import { describe, it, expect, vi } from 'vitest';

const { createPlanReviewer } = require('../factory/plan-reviewer');

function createWorkItem() {
  return {
    id: 17,
    project_id: 'project-17',
    title: 'Harden factory plan review',
    description: 'Add a second-opinion plan review before execution.',
    origin: {
      plan_generator_provider: 'codex',
    },
  };
}

describe('factory plan-reviewer', () => {
  it('passes with a single approve verdict from Claude CLI', async () => {
    const submit = vi.fn(async ({ provider }) => ({ task_id: `${provider}-task` }));
    const awaitTask = vi.fn(async () => ({
      status: 'completed',
      output: JSON.stringify({
        verdict: 'approve',
        concerns: [],
        suggestions: ['looks grounded'],
        confidence: 88,
      }),
    }));
    const reviewer = createPlanReviewer({
      submit,
      awaitTask,
      getProvidersHealth: () => [
        { provider: 'claude-cli', enabled: true, api_key_configured: true },
      ],
    });

    const result = await reviewer.review({
      workItem: createWorkItem(),
      planContent: '## Task 1: Add reviewer tests',
    });

    expect(result).toMatchObject({
      overall: 'approve',
      skipped: false,
      reviews: [{
        name: 'Claude CLI',
        provider: 'claude-cli',
        verdict: 'approve',
        confidence: 88,
      }],
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude-cli',
      version_intent: 'internal',
      tags: expect.arrayContaining([
        'factory:internal',
        'factory:plan_review',
        'factory:project_id=project-17',
        'factory:work_item_id=17',
      ]),
    }));
  });

  it('returns block overall when a reviewer blocks the plan', async () => {
    const reviewer = createPlanReviewer({
      submit: vi.fn(async () => ({ task_id: 'claude-review' })),
      awaitTask: vi.fn(async () => ({
        status: 'completed',
        output: JSON.stringify({
          verdict: 'block',
          concerns: ['references a nonexistent API'],
          suggestions: ['replace the hallucinated dependency with the real adapter'],
          confidence: 97,
        }),
      })),
      getProvidersHealth: () => [
        { provider: 'claude-cli', enabled: true, api_key_configured: true },
      ],
    });

    const result = await reviewer.review({
      workItem: createWorkItem(),
      planContent: '## Task 1: Call imaginaryAdapter.doThing()',
    });

    expect(result).toMatchObject({
      overall: 'block',
      skipped: false,
      reviews: [{
        verdict: 'block',
        concerns: ['references a nonexistent API'],
        confidence: 97,
      }],
    });
  });

  it('passes with warnings when reviews are mixed and downgrades unavailable reviewers', async () => {
    const submit = vi.fn(async ({ provider }) => ({ task_id: `${provider}-task` }));
    const awaitTask = vi.fn(async ({ task_id }) => {
      if (task_id === 'claude-cli-task') {
        return {
          status: 'completed',
          output: JSON.stringify({
            verdict: 'approve',
            concerns: [],
            suggestions: [],
            confidence: 82,
          }),
        };
      }

      return {
        status: 'failed',
        error: 'provider offline',
        output: '',
      };
    });
    const reviewer = createPlanReviewer({
      submit,
      awaitTask,
      getProvidersHealth: () => [
        { provider: 'claude-cli', enabled: true, api_key_configured: true },
        { provider: 'anthropic', enabled: true, api_key_configured: true },
      ],
    });

    const result = await reviewer.review({
      workItem: createWorkItem(),
      planContent: '## Task 1: Sequence the work safely',
    });

    expect(result.overall).toBe('request_changes');
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0]).toMatchObject({
      provider: 'claude-cli',
      verdict: 'approve',
    });
    expect(result.reviews[1]).toMatchObject({
      provider: 'anthropic',
      verdict: 'request_changes',
      concerns: ['reviewer_unavailable'],
      reason: 'reviewer_unavailable',
      confidence: 0,
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('skips silently when no reviewers are configured', async () => {
    const submit = vi.fn();
    const awaitTask = vi.fn();
    const reviewer = createPlanReviewer({
      submit,
      awaitTask,
      getProvidersHealth: () => [],
    });

    const result = await reviewer.review({
      workItem: createWorkItem(),
      planContent: '## Task 1: No reviewers available',
    });

    expect(result).toEqual({
      overall: 'approve',
      reviews: [],
      skipped: true,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(awaitTask).not.toHaveBeenCalled();
  });
});
