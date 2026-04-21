'use strict';

const { createStarvationRecovery } = require('../factory/starvation-recovery');

describe('starvation recovery', () => {
  it('dispatches scout sweep when project has been STARVED longer than dwell', async () => {
    const submitScout = vi.fn().mockResolvedValue({ task_id: 't1' });
    const updateLoopState = vi.fn();
    const now = Date.now();
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      dwellMs: 15 * 60 * 1000,
      now: () => now,
    });

    const project = {
      id: 'p1',
      path: '/tmp/p1',
      loop_state: 'STARVED',
      loop_last_action_at: new Date(now - 20 * 60 * 1000).toISOString(),
    };

    const result = await recovery.maybeRecover(project);

    expect(submitScout).toHaveBeenCalled();
    expect(submitScout.mock.calls[0][0]).toMatchObject({ project_id: 'p1' });
    expect(updateLoopState).toHaveBeenCalledWith('p1', expect.objectContaining({ loop_state: 'SENSE' }));
    expect(result.recovered).toBe(true);
  });

  it('does nothing before dwell elapses', async () => {
    const submitScout = vi.fn();
    const now = Date.now();
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState: vi.fn(),
      dwellMs: 15 * 60 * 1000,
      now: () => now,
    });

    const project = {
      id: 'p1',
      path: '/tmp/p1',
      loop_state: 'STARVED',
      loop_last_action_at: new Date(now - 5 * 60 * 1000).toISOString(),
    };

    const result = await recovery.maybeRecover(project);

    expect(submitScout).not.toHaveBeenCalled();
    expect(result.recovered).toBe(false);
  });

  it('does nothing when project is not STARVED', async () => {
    const submitScout = vi.fn();
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState: vi.fn(),
      dwellMs: 1,
      now: () => Date.now(),
    });
    const result = await recovery.maybeRecover({ id: 'p1', loop_state: 'IDLE', path: '/tmp/p1' });
    expect(submitScout).not.toHaveBeenCalled();
    expect(result.recovered).toBe(false);
  });
});
