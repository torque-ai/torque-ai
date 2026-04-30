'use strict';

const {
  DEFAULT_SCOUT_FILE_PATTERNS,
  DEFAULT_SCOUT_TIMEOUT_MINUTES,
  SCOUT_TIMEOUT_MINUTES_BY_PROVIDER,
  buildStarvationRecoveryScope,
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

  it('extends scout timeout for codex (Phase J)', async () => {
    // Codex needs more headroom than ollama for thorough recon. Without this,
    // codex scouts time out at 12 min while still actively reading real source
    // files and emitting __PATTERNS_READY__ deferrals (DLPhone c0f278ca,
    // 2026-04-30).
    const submitScout = vi.fn().mockResolvedValue({ task_id: 'task-codex' });
    const updateLoopState = vi.fn().mockResolvedValue({});
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const resolveScoutProvider = vi.fn().mockReturnValue('codex');
    const nowMs = Date.parse('2026-04-30T13:30:00.000Z');
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
      loop_last_action_at: '2026-04-30T13:00:00.000Z',
    });

    expect(submitScout).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      timeout_minutes: SCOUT_TIMEOUT_MINUTES_BY_PROVIDER.codex,
    }));
    expect(SCOUT_TIMEOUT_MINUTES_BY_PROVIDER.codex).toBeGreaterThan(DEFAULT_SCOUT_TIMEOUT_MINUTES);
  });

  it('keeps default scout timeout for ollama', async () => {
    // Ollama converges fast (or hallucinates fast); the legacy 12-min budget
    // is the right ceiling — bumping it would just make hallucinated scouts
    // burn the cap before being filtered by Phase B's existence guard.
    const submitScout = vi.fn().mockResolvedValue({ task_id: 'task-ollama' });
    const updateLoopState = vi.fn().mockResolvedValue({});
    const countOpenWorkItems = vi.fn().mockResolvedValue(0);
    const resolveScoutProvider = vi.fn().mockReturnValue('ollama');
    const nowMs = Date.parse('2026-04-30T13:30:00.000Z');
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
      loop_last_action_at: '2026-04-30T13:00:00.000Z',
    });

    expect(submitScout).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'ollama',
      timeout_minutes: DEFAULT_SCOUT_TIMEOUT_MINUTES,
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

describe('buildStarvationRecoveryScope', () => {
  // The rewrite was driven by two DLPhone scout failures on qwen3-coder:30b
  // (e50cfe25 and c6549cc0, 2026-04-29) where the model latched onto
  // "Factory starvation recovery scout" in the original scope and produced
  // patterns about queue monitoring / starvation recovery / work-item
  // prioritization for what is actually a Unity/.NET multiplayer game.

  it('leads with the project name (not "Factory") so small models do not parse "factory" as topic', () => {
    const scope = buildStarvationRecoveryScope({
      project: { name: 'DLPhone', brief: 'Mobile RTS game.' },
      noYieldScoutCount: 0,
    });
    const firstLine = scope.split('\n')[0];
    expect(firstLine).toContain('**DLPhone**');
    expect(firstLine).not.toMatch(/^Factory\s/);
  });

  it('embeds the project brief verbatim under a "Project context" heading', () => {
    const scope = buildStarvationRecoveryScope({
      project: {
        name: 'DLPhone',
        brief: 'DLPhone is a mobile RTS (Android/Unity, .NET 8) inspired by classic colony-management strategy games.',
      },
      noYieldScoutCount: 0,
    });
    expect(scope).toContain('## Project context');
    expect(scope).toContain('DLPhone is a mobile RTS (Android/Unity, .NET 8)');
  });

  it('omits the Project context section when no brief is available', () => {
    const scope = buildStarvationRecoveryScope({
      project: { name: 'NewProject' },
      noYieldScoutCount: 0,
    });
    expect(scope).not.toContain('## Project context');
    expect(scope).toContain('**NewProject**');
  });

  it('treats whitespace-only brief as missing', () => {
    const scope = buildStarvationRecoveryScope({
      project: { name: 'X', brief: '   \n  \t  ' },
      noYieldScoutCount: 0,
    });
    expect(scope).not.toContain('## Project context');
  });

  it('explicitly disambiguates "factory" as the build pipeline, not the project domain', () => {
    const scope = buildStarvationRecoveryScope({
      project: { name: 'DLPhone', brief: 'Mobile RTS.' },
      noYieldScoutCount: 0,
    });
    expect(scope).toContain('## Disambiguation');
    expect(scope).toMatch(/"factory" refers to the autonomous build pipeline/i);
    expect(scope).toContain("NOT to DLPhone's domain");
    // Listing the things models tend to invent so the model is told NOT to:
    expect(scope).toMatch(/queue monitoring|starvation recovery|generic factory/i);
  });

  it('mandates evidence — patterns must come from list_directory or search_files', () => {
    const scope = buildStarvationRecoveryScope({
      project: { name: 'DLPhone', brief: 'Mobile RTS.' },
      noYieldScoutCount: 0,
    });
    expect(scope).toContain('## Evidence requirement');
    // Phase G broadened "Every pattern you emit MUST have ... exemplar_files"
    // into "Every pattern OR concrete item MUST have ... at least one path"
    // so the rule covers both __PATTERNS_READY__ (with exemplar_files) and
    // __SCOUT_COMPLETE__ concrete_factory_work_items (with allowed_files).
    expect(scope).toMatch(/MUST have at least one path/i);
    expect(scope).toMatch(/list_directory.*search_files|search_files.*list_directory/);
    expect(scope).toMatch(/may NOT invent file paths/i);
  });

  it('explicitly allows an empty patterns array as a valid signal', () => {
    const scope = buildStarvationRecoveryScope({
      project: { name: 'DLPhone', brief: 'Mobile RTS.' },
      noYieldScoutCount: 0,
    });
    // Use plain substring checks — the scope intentionally formats
    // `patterns` with backticks, which makes a single greedy regex
    // brittle across backtick boundaries.
    expect(scope).toContain('empty');
    expect(scope).toContain('`patterns` array');
    expect(scope).toContain('empty result is a valid signal');
  });

  it('falls back to "this project" when name is missing', () => {
    const scope = buildStarvationRecoveryScope({
      project: {},
      noYieldScoutCount: 0,
    });
    expect(scope).toContain('this project');
  });

  it('preserves the no-yield scout backoff count for the model', () => {
    const scope = buildStarvationRecoveryScope({
      project: { name: 'DLPhone', brief: 'Mobile RTS.' },
      noYieldScoutCount: 3,
    });
    expect(scope).toContain('No-yield scout backoff count: 3');
  });

  it('preserves scope bounds (80-file cap, evidence sources)', () => {
    const scope = buildStarvationRecoveryScope({
      project: { name: 'DLPhone', brief: 'Mobile RTS.' },
      noYieldScoutCount: 0,
    });
    expect(scope).toContain('## Scope bounds');
    expect(scope).toContain('at most 80 candidate files');
    expect(scope).toMatch(/test files|docs|TODO/i);
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(() => buildStarvationRecoveryScope({ project: null, noYieldScoutCount: 0 })).not.toThrow();
    expect(() => buildStarvationRecoveryScope({ project: undefined, noYieldScoutCount: 0 })).not.toThrow();
    const scope = buildStarvationRecoveryScope({ project: null, noYieldScoutCount: 0 });
    expect(scope).toContain('this project');
  });
});
