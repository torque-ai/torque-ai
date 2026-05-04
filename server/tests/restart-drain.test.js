'use strict';

const fs = require('fs');
const path = require('path');
const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');

describe('restart_server barrier mode', () => {
  let tools;
  let taskCore;
  let originalRestartCooldown;

  beforeAll(() => {
    originalRestartCooldown = process.env.TORQUE_RESTART_COOLDOWN_MS;
    setupTestDbOnly('restart-drain');
  });
  afterAll(() => {
    if (originalRestartCooldown === undefined) {
      delete process.env.TORQUE_RESTART_COOLDOWN_MS;
    } else {
      process.env.TORQUE_RESTART_COOLDOWN_MS = originalRestartCooldown;
    }
    teardownTestDb();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    resetTables('tasks');
    delete process._torqueRestartPending;
    process.env.TORQUE_RESTART_COOLDOWN_MS = '0';
    // eslint-disable-next-line torque/no-reset-modules-in-each -- vi.doMock requires fresh registry; re-requires task-core and tools
    vi.resetModules();
    vi.doMock('../event-bus', () => ({
      emitShutdown: vi.fn(),
      onShutdown: vi.fn(),
      removeListener: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
      emitTaskEvent: vi.fn(),
    }));
    vi.doMock('../hooks/event-dispatch', () => ({
      taskEvents: new (require('events').EventEmitter)(),
      NOTABLE_EVENTS: [],
    }));

    taskCore = require('../db/task-core');
    tools = require('../tools');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process._torqueRestartPending;
    vi.restoreAllMocks();
  });

  it('creates a barrier task when no tasks running', async () => {
    const result = await tools.handleToolCall('restart_server', { reason: 'cutover' });
    expect(result.task_id || result.content).toBeTruthy();
    // Status may be 'restart_scheduled' (immediate) or 'queued' depending on pipeline state
    expect(['queued', 'restart_scheduled']).toContain(result.status);
  });

  it('creates a barrier task when tasks are running (no rejection)', async () => {
    taskCore.createTask({
      id: 'running-1',
      task_description: 'busy',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('running-1', 'queued', {});
    taskCore.updateTaskStatus('running-1', 'running', { started_at: new Date().toISOString() });

    const result = await tools.handleToolCall('restart_server', { reason: 'cutover' });
    expect(result.task_id || result.content).toBeTruthy();
    expect(['queued', 'drain_started']).toContain(result.status);
    if (result.pipeline) {
      expect(result.pipeline.running).toBe(1);
    }
  });

  // Phase D / §2.5.3 — drain_timeout_ms parameter
  it('honors drain_timeout_ms in the response and surfaces it in seconds when ≥ 60s', async () => {
    taskCore.createTask({
      id: 'drain-ms-pin',
      task_description: 'pin drain',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('drain-ms-pin', 'queued', {});
    taskCore.updateTaskStatus('drain-ms-pin', 'running', { started_at: new Date().toISOString() });

    const result = await tools.handleToolCall('restart_server', { reason: 'fast', drain_timeout_ms: 30_000 });
    expect(result.status).toBe('drain_started');
    expect(result.drain_timeout_ms).toBe(30_000);
    // 30 s falls below the "render in minutes" threshold; copy uses ms.
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('30000 ms');
  });

  it('falls back to drain_timeout_minutes when drain_timeout_ms is unset', async () => {
    taskCore.createTask({
      id: 'drain-min-pin',
      task_description: 'pin',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('drain-min-pin', 'queued', {});
    taskCore.updateTaskStatus('drain-min-pin', 'running', { started_at: new Date().toISOString() });

    const result = await tools.handleToolCall('restart_server', { reason: 'legacy', drain_timeout_minutes: 5 });
    expect(result.status).toBe('drain_started');
    expect(result.drain_timeout_ms).toBe(5 * 60_000);
  });

  it('defaults to 60_000 ms when no drain timeout is provided', async () => {
    taskCore.createTask({
      id: 'drain-default-pin',
      task_description: 'pin',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('drain-default-pin', 'queued', {});
    taskCore.updateTaskStatus('drain-default-pin', 'running', { started_at: new Date().toISOString() });

    const result = await tools.handleToolCall('restart_server', { reason: 'default' });
    expect(result.drain_timeout_ms).toBe(60_000);
  });

  it('rejects second restart when barrier already exists', async () => {
    // Park a running task so the first barrier stays queued for drain instead
    // of completing instantly. Without this, the beforeEach cooldown='0'
    // override would let the second call create a fresh barrier, because the
    // first barrier's empty-pipeline shortcut marks it terminal before the
    // existing-barrier lookup can see it.
    taskCore.createTask({
      id: 'barrier-pin-running',
      task_description: 'keeps first barrier in drain',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('barrier-pin-running', 'queued', {});
    taskCore.updateTaskStatus('barrier-pin-running', 'running', { started_at: new Date().toISOString() });

    const first = await tools.handleToolCall('restart_server', { reason: 'first' });
    expect(first.task_id).toBeTruthy();

    const second = await tools.handleToolCall('restart_server', { reason: 'second' });
    expect(second.status).toBe('already_pending');
    expect(second.task_id).toBe(first.task_id);
  });
});

describe('restart_server drain watchdog reverted', () => {
  // Regression guard (2026-04-21): a no-progress watchdog was shipped and
  // immediately reverted. It failed the barrier after 3 min of drain-counter
  // stagnation, which killed legitimate slow drains. Real drains can sit for
  // 5–10+ min (or longer) between task completions — user reports full-hour
  // waits in practice. Only the user-configurable `drainTimeoutMinutes`
  // should bound the drain.
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools.js'), 'utf8');

  it('does not re-introduce a no-progress watchdog that fails the barrier', () => {
    expect(src).not.toMatch(/NO_PROGRESS_TIMEOUT_MS/);
    expect(src).not.toMatch(/lastProgressRunning/);
    expect(src).not.toMatch(/lastProgressAt/);
    expect(src).not.toMatch(/noProgressElapsed/);
  });

  it('still honors the full configured drain budget', () => {
    // The only drain-failure path left should be the user-set timeout,
    // bounded by `drainTimeoutMs` (resolved from drain_timeout_ms |
    // drain_timeout_minutes | timeout_minutes per Phase D §2.5.3,
    // default 60_000 ms).
    expect(src).toMatch(/elapsed\s*>=\s*drainTimeoutMs/);
    // Phase D resolves drainTimeoutMs at the top of the function from
    // any of three operator inputs. We pin the resolution surface
    // (canonical drain_timeout_ms arg + sub-minute-default literal)
    // rather than the old `drainTimeoutMinutes * 60 * 1000` math, which
    // is gone after the refactor. The regression-guard intent is
    // preserved: the only failure path is still the user-set timeout.
    expect(src).toMatch(/drain_timeout_ms/);
    expect(src).toMatch(/DEFAULT_DRAIN_TIMEOUT_MS\s*=\s*60_?000/);
  });
});
