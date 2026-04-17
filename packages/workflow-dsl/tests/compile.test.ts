import { describe, expect, it, vi } from 'vitest';

import { createStep, createWorkflow, submitToTorque } from '../src';

describe('submitToTorque()', () => {
  it('posts a built workflow spec to the TORQUE workflows endpoint', async () => {
    const spec = createWorkflow({ name: 'ci-and-deploy' })
      .step(createStep({ id: 'plan', task_description: 'Plan deployment' }))
      .then(createStep({ id: 'build', task_description: 'Build artifact' }))
      .toSpec();
    const responseBody = { workflowId: 'wf-123' };
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue(responseBody),
    });

    await expect(
      submitToTorque(spec, {
        torqueBaseUrl: 'http://localhost:3457///',
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).resolves.toEqual(responseBody);

    expect(fetcher).toHaveBeenCalledWith('http://localhost:3457/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
  });

  it('throws when TORQUE returns a non-ok response', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn(),
    });

    await expect(
      submitToTorque(
        { name: 'ci-and-deploy', tasks: [] },
        {
          torqueBaseUrl: 'http://localhost:3457',
          fetcher: fetcher as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow('submit failed: HTTP 503');
  });
});
