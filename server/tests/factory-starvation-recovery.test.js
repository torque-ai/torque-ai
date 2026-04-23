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
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      countOpenWorkItems,
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

  it('moves STARVED projects back to SENSE immediately when intake is available', async () => {
    const submitScout = vi.fn();
    const updateLoopState = vi.fn().mockResolvedValue({});
    const countOpenWorkItems = vi.fn().mockResolvedValue(2);
    const nowMs = Date.parse('2026-04-22T12:30:00.000Z');
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      countOpenWorkItems,
      dwellMs: 1000,
      now: () => nowMs,
    });

    const result = await recovery.maybeRecover({
      id: 'project-1',
      path: 'C:\\repo',
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: '2026-04-22T12:29:59.900Z',
    });

    expect(result).toMatchObject({
      recovered: true,
      reason: 'open_intake_available',
      open_work_items: 2,
    });
    expect(submitScout).not.toHaveBeenCalled();
    expect(updateLoopState).toHaveBeenCalledWith('project-1', {
      loop_state: LOOP_STATES.SENSE,
      loop_last_action_at: '2026-04-22T12:30:00.000Z',
      loop_paused_at_stage: null,
      consecutive_empty_cycles: 0,
    });
  });

  it('ingests scout findings before submitting a new scout', async () => {
    const submitScout = vi.fn();
    const updateLoopState = vi.fn().mockResolvedValue({});
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const ingestScoutFindings = vi.fn().mockResolvedValue({
      created: [{ id: 42 }],
      skipped: [],
      scanned: 1,
    });
    const nowMs = Date.parse('2026-04-22T12:30:00.000Z');
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      countOpenWorkItems,
      ingestScoutFindings,
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
      reason: 'scout_findings_ingested',
      created_count: 1,
    });
    expect(ingestScoutFindings).toHaveBeenCalledWith(expect.objectContaining({
      id: 'project-1',
      path: 'C:\\repo',
    }));
    expect(submitScout).not.toHaveBeenCalled();
    expect(updateLoopState).toHaveBeenCalledWith('project-1', expect.objectContaining({
      loop_state: LOOP_STATES.SENSE,
      consecutive_empty_cycles: 0,
    }));
  });

  it('ingests completed scout task output before submitting a new scout', async () => {
    const submitScout = vi.fn();
    const updateLoopState = vi.fn().mockResolvedValue({});
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const ingestScoutFindings = vi.fn().mockResolvedValue({ created: [], skipped: [], scanned: 0 });
    const ingestScoutOutputs = vi.fn().mockResolvedValue({
      created: [{ id: 43 }],
      skipped: [],
      scanned: 1,
    });
    const nowMs = Date.parse('2026-04-22T12:30:00.000Z');
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      countOpenWorkItems,
      ingestScoutFindings,
      ingestScoutOutputs,
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
      reason: 'scout_outputs_ingested',
      created_count: 1,
    });
    expect(ingestScoutOutputs).toHaveBeenCalledWith(expect.objectContaining({
      id: 'project-1',
      path: 'C:\\repo',
    }));
    expect(submitScout).not.toHaveBeenCalled();
    expect(updateLoopState).toHaveBeenCalledWith('project-1', expect.objectContaining({
      loop_state: LOOP_STATES.SENSE,
      consecutive_empty_cycles: 0,
    }));
  });

  it('submits a scout after dwell but keeps STARVED projects parked until intake exists', async () => {
    const submitScout = vi.fn().mockResolvedValue({ task_id: 'task-1' });
    const updateLoopState = vi.fn().mockResolvedValue({});
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const ingestScoutFindings = vi.fn().mockResolvedValue({ created: [], skipped: [], scanned: 0 });
    const nowMs = Date.parse('2026-04-22T12:30:00.000Z');
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      countOpenWorkItems,
      ingestScoutFindings,
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
      recovered: false,
      reason: 'scout_submitted_waiting_for_intake',
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
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: '2026-04-22T12:30:00.000Z',
      loop_paused_at_stage: null,
      consecutive_empty_cycles: 0,
    });
  });
});
