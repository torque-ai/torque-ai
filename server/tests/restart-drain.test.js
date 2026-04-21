'use strict';

const fs = require('fs');
const path = require('path');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('restart_server barrier mode', () => {
  let tools;
  let taskCore;

  beforeAll(() => {
    setupTestDbOnly('restart-drain');
  });
  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
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

  it('rejects second restart when barrier already exists', async () => {
    const first = await tools.handleToolCall('restart_server', { reason: 'first' });
    expect(first.task_id).toBeTruthy();

    const second = await tools.handleToolCall('restart_server', { reason: 'second' });
    expect(second.status).toBe('already_pending');
    expect(second.task_id).toBe(first.task_id);
  });
});

describe('restart_server drain watchdog (no-progress timeout)', () => {
  // Regression guard (2026-04-21): a stale 'running' row whose subprocess
  // already died wedged a cutover for 796s because the drain counter never
  // decreased. The watchdog fails the barrier after NO_PROGRESS_TIMEOUT_MS
  // of no decrement, so the queue auto-resumes instead of waiting for the
  // full drainTimeoutMinutes (default 30+ min).
  //
  // These are source-level guards — the actual watchdog runs on a
  // setInterval with a multi-minute window, which doesn't unit-test
  // cleanly without wholesale timer mocking. The invariants here catch
  // the common regression: someone deleting the watchdog or weakening
  // the failure path.
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools.js'), 'utf8');

  it('declares a NO_PROGRESS_TIMEOUT_MS window for the drain watchdog', () => {
    expect(src).toMatch(/NO_PROGRESS_TIMEOUT_MS\s*=\s*\d+\s*\*/);
  });

  it('tracks lastProgressRunning and lastProgressAt across poll ticks', () => {
    expect(src).toMatch(/lastProgressRunning\s*=/);
    expect(src).toMatch(/lastProgressAt\s*=/);
    // Progress is marked whenever running decreases; this is the load-bearing
    // invariant — without it the counter never updates and the watchdog fires
    // on a legitimate in-progress drain.
    expect(src).toMatch(/running\s*<\s*lastProgressRunning[\s\S]{0,200}lastProgressAt\s*=\s*Date\.now\(\)/);
  });

  it('fails the barrier when no progress elapsed exceeds the timeout', () => {
    expect(src).toMatch(/noProgressElapsed\s*>=\s*NO_PROGRESS_TIMEOUT_MS/);
    // The watchdog must mark the barrier 'failed' (not 'cancelled'/'completed')
    // so isRestartBarrierActive returns null and the queue resumes.
    const watchdogBlock = src.match(/noProgressElapsed\s*>=\s*NO_PROGRESS_TIMEOUT_MS[\s\S]{0,800}/);
    expect(watchdogBlock?.[0]).toMatch(/updateTaskStatus\([^)]+,\s*['"]failed['"]/);
    // Diagnostic error must hint at the stale-row diagnosis so operators
    // know where to look.
    expect(watchdogBlock?.[0]).toMatch(/stale/i);
  });
});
