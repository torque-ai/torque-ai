'use strict';

const {
  DEFAULT_SCOUT_FILE_PATTERNS,
  DEFAULT_SCOUT_TIMEOUT_MINUTES,
  computeBackoffDwellMs,
  countConsecutiveNoYieldScouts,
  createStarvationRecovery,
} = require('../factory/starvation-recovery');
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

  it('can bypass dwell when an explicit recovery trigger asks for immediate scout seeding', async () => {
    const submitScout = vi.fn().mockResolvedValue({ task_id: 'task-1' });
    const updateLoopState = vi.fn().mockResolvedValue({});
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
    }, {
      force: true,
      trigger: 'manual_advance',
    });

    expect(result).toMatchObject({
      recovered: false,
      reason: 'scout_submitted_waiting_for_intake',
      scout: { task_id: 'task-1' },
      forced: true,
      trigger: 'manual_advance',
    });
    expect(submitScout).toHaveBeenCalledTimes(1);
    expect(updateLoopState).toHaveBeenCalledWith('project-1', expect.objectContaining({
      loop_state: LOOP_STATES.STARVED,
    }));
  });

  it('does not submit a second starvation scout while one is already active for the project', async () => {
    const submitScout = vi.fn();
    const updateLoopState = vi.fn();
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const listActiveScouts = vi.fn().mockResolvedValue([
      { id: 'scout-running-1', status: 'running' },
    ]);
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      countOpenWorkItems,
      listActiveScouts,
      dwellMs: 1000,
      now: () => Date.parse('2026-04-22T12:30:00.000Z'),
    });

    const result = await recovery.maybeRecover({
      id: 'project-1',
      path: 'C:\\repo',
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: '2026-04-22T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      recovered: false,
      reason: 'scout_already_running',
      existing_task_id: 'scout-running-1',
      active_scout_count: 1,
    });
    expect(submitScout).not.toHaveBeenCalled();
    expect(updateLoopState).not.toHaveBeenCalled();
  });

  it('applies exponential dwell backoff after consecutive no-yield scouts', async () => {
    const submitScout = vi.fn();
    const updateLoopState = vi.fn();
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const listActiveScouts = vi.fn().mockResolvedValue([]);
    const listRecentScouts = vi.fn().mockResolvedValue([
      { id: 'failed-2', status: 'failed' },
      { id: 'failed-1', status: 'completed', output: 'No actionable findings.' },
    ]);
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      countOpenWorkItems,
      listActiveScouts,
      listRecentScouts,
      dwellMs: 1000,
      now: () => Date.parse('2026-04-22T12:00:01.500Z'),
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
      elapsed_ms: 1500,
      dwell_ms: 4000,
      base_dwell_ms: 1000,
      no_yield_scout_count: 2,
    });
    expect(submitScout).not.toHaveBeenCalled();
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
      timeout_minutes: DEFAULT_SCOUT_TIMEOUT_MINUTES,
      file_patterns: DEFAULT_SCOUT_FILE_PATTERNS,
    }));
    expect(submitScout.mock.calls[0][0].file_patterns).not.toContain('server/**/*.js');
    expect(submitScout.mock.calls[0][0].file_patterns).not.toContain('dashboard/src/**/*.{js,jsx,ts,tsx}');
    expect(updateLoopState).toHaveBeenCalledWith('project-1', {
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: '2026-04-22T12:30:00.000Z',
      loop_paused_at_stage: null,
      consecutive_empty_cycles: 0,
    });
  });

  it('uses resolved provider lane provider for recovery scouts', async () => {
    const submitScout = vi.fn().mockResolvedValue({ task_id: 'task-1' });
    const updateLoopState = vi.fn().mockResolvedValue({});
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const resolveScoutProvider = vi.fn().mockReturnValue('ollama-cloud');
    const nowMs = Date.parse('2026-04-22T12:30:00.000Z');
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      countOpenWorkItems,
      resolveScoutProvider,
      dwellMs: 1000,
      now: () => nowMs,
    });

    await recovery.maybeRecover({
      id: 'project-1',
      path: 'C:\\repo',
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: '2026-04-22T12:00:00.000Z',
    });

    expect(resolveScoutProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'project-1',
      path: 'C:\\repo',
    }));
    expect(submitScout).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      provider: 'ollama-cloud',
    }));
  });
});

describe('starvation recovery scout backoff helpers', () => {
  it('counts consecutive terminal scouts that produced no actionable scout signal', () => {
    expect(countConsecutiveNoYieldScouts([
      { id: 'running', status: 'running' },
      { id: 'failed', status: 'failed' },
      { id: 'empty-complete', status: 'completed', output: 'No work found.' },
      { id: 'signal', status: 'completed', output: '__SCOUT_COMPLETE__\n{}' },
      { id: 'older-failed', status: 'failed' },
    ])).toBe(2);
  });

  it('ignores scout signal markers that only appear in stderr', () => {
    expect(countConsecutiveNoYieldScouts([
      { id: 'prompt-echo', status: 'completed', error_output: 'Example: __SCOUT_COMPLETE__' },
      { id: 'signal', status: 'completed', output: '__SCOUT_COMPLETE__\n{}' },
    ])).toBe(1);
  });

  it('caps exponential dwell backoff', () => {
    expect(computeBackoffDwellMs(1000, 0, 8000)).toBe(1000);
    expect(computeBackoffDwellMs(1000, 2, 8000)).toBe(4000);
    expect(computeBackoffDwellMs(1000, 10, 8000)).toBe(8000);
  });
});
