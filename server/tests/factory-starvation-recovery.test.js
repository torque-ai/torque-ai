'use strict';

const { createStarvationRecovery } = require('../factory/starvation-recovery');
const { LOOP_STATES } = require('../factory/loop-states');

describe('factory starvation recovery', () => {
  it('leaves non-starved projects alone', async () => {
    const submitScout = vi.fn();
    const updateLoopState = vi.fn();
    const recovery = createStarvationRecovery({ submitScout, updateLoopState });

    const result = await recovery.maybeRecover({
      id: 'project-1',
      loop_state: LOOP_STATES.IDLE,
    });

    expect(result).toEqual({ recovered: false, reason: 'not_starved' });
    expect(submitScout).not.toHaveBeenCalled();
    expect(updateLoopState).not.toHaveBeenCalled();
  });

  it('waits for the dwell interval before submitting recovery scouts', async () => {
    const submitScout = vi.fn();
    const updateLoopState = vi.fn();
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      dwellMs: 1000,
      now: () => Date.parse('2026-04-22T12:00:00.500Z'),
    });

    const result = await recovery.maybeRecover({
      id: 'project-1',
      path: 'C:\\repo',
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: '2026-04-22T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      recovered: false,
      reason: 'dwell_not_elapsed',
      elapsed_ms: 500,
      dwell_ms: 1000,
    });
    expect(submitScout).not.toHaveBeenCalled();
    expect(updateLoopState).not.toHaveBeenCalled();
  });

  it('submits a scout and moves STARVED projects back to SENSE after dwell', async () => {
    const submitScout = vi.fn().mockResolvedValue({ task_id: 'task-1' });
    const updateLoopState = vi.fn().mockResolvedValue({});
    const nowMs = Date.parse('2026-04-22T12:30:00.000Z');
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      dwellMs: 1000,
      now: () => nowMs,
    });

    const result = await recovery.maybeRecover({
      id: 'project-1',
      path: 'C:\\repo',
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: '2026-04-22T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      recovered: true,
      reason: 'scout_submitted',
      scout: { task_id: 'task-1' },
    });
    expect(submitScout).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      project_path: 'C:\\repo',
      working_directory: 'C:\\repo',
      reason: 'factory_starvation_recovery',
      provider: 'codex',
      timeout_minutes: 30,
    }));
    expect(updateLoopState).toHaveBeenCalledWith('project-1', {
      loop_state: LOOP_STATES.SENSE,
      loop_last_action_at: '2026-04-22T12:30:00.000Z',
      loop_paused_at_stage: null,
      consecutive_empty_cycles: 0,
    });
  });
});
