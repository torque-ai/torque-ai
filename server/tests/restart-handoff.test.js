'use strict';

const fs = require('fs');
const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');
const taskCore = require('../db/task-core');
const restartHandoff = require('../execution/restart-handoff');

function createRunningBarrier(id = 'restart-handoff-barrier') {
  taskCore.createTask({
    id,
    task_description: 'Restart barrier',
    working_directory: process.cwd(),
    provider: 'system',
    model: null,
    status: 'queued',
    metadata: {},
  });
  taskCore.updateTaskStatus(id, 'running', { started_at: new Date().toISOString() });
  return id;
}

describe('restart handoff', () => {
  beforeAll(() => {
    setupTestDbOnly('restart-handoff');
  });

  afterAll(() => {
    restartHandoff.clearRestartHandoff();
    restartHandoff.clearRestartIntent();
    teardownTestDb();
  });

  beforeEach(() => {
    resetTables('tasks');
    restartHandoff.clearRestartHandoff();
    restartHandoff.clearRestartIntent();
    try { fs.unlinkSync(restartHandoff.getRestartExitDiagnosticsPath()); } catch { /* ok */ }
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restartHandoff.clearRestartHandoff();
    restartHandoff.clearRestartIntent();
    try { fs.unlinkSync(restartHandoff.getRestartExitDiagnosticsPath()); } catch { /* ok */ }
    vi.restoreAllMocks();
  });

  it('completes a matching running restart barrier on successor startup', () => {
    const barrierId = createRunningBarrier();
    restartHandoff.writeRestartHandoff({
      barrier_id: barrierId,
      reason: 'cutover',
      requested_at: '2026-04-23T19:34:18.000Z',
    });
    restartHandoff.writeRestartIntent({
      barrier_id: barrierId,
      reason: 'cutover',
      phase: 'handoff_staged',
    });

    const logger = { info: vi.fn() };
    const result = restartHandoff.completePendingRestartHandoff({
      taskCore,
      instanceId: 'mcp-new-instance',
      logger,
    });

    expect(result).toMatchObject({
      completed: true,
      barrier_id: barrierId,
      barrier_status: 'completed',
    });
    expect(taskCore.getTask(barrierId).status).toBe('completed');
    expect(taskCore.getTask(barrierId).output).toContain('Restart completed by instance mcp-new-instance');
    expect(restartHandoff.readRestartHandoff()).toBeNull();
    expect(restartHandoff.readRestartIntent()).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(barrierId.slice(0, 8)));
  });

  it('clears orphaned handoff state when the barrier task is missing', () => {
    restartHandoff.writeRestartHandoff({
      barrier_id: 'missing-barrier',
      reason: 'cutover',
    });

    const result = restartHandoff.completePendingRestartHandoff({
      taskCore,
      instanceId: 'mcp-new-instance',
      logger: { info: vi.fn() },
    });

    expect(result).toMatchObject({
      completed: false,
      reason: 'missing_barrier',
      barrier_id: 'missing-barrier',
    });
    expect(restartHandoff.readRestartHandoff()).toBeNull();
  });

  it('persists and updates restart intent while a barrier drains', () => {
    const barrierId = createRunningBarrier('restart-intent-barrier');
    restartHandoff.writeRestartIntent({
      barrier_id: barrierId,
      reason: 'cutover',
      phase: 'created',
      running_count: 2,
      queued_held_count: 4,
      requested_at: '2026-04-30T15:23:05.000Z',
    });

    restartHandoff.updateRestartIntent({
      phase: 'draining',
      running_count: 1,
      queued_held_count: 4,
    });

    expect(restartHandoff.readRestartIntent()).toMatchObject({
      barrier_id: barrierId,
      reason: 'cutover',
      phase: 'draining',
      running_count: 1,
      queued_held_count: 4,
      requested_at: '2026-04-30T15:23:05.000Z',
    });
  });

  it('formats stale-barrier errors with the interrupted restart phase', () => {
    const message = restartHandoff.formatStaleRestartBarrierError('barrier-a', {
      barrier_id: 'barrier-a',
      reason: 'node24 rebuild',
      phase: 'draining',
      requested_at: '2026-04-30T15:23:05.000Z',
      updated_at: '2026-04-30T15:37:13.000Z',
      requested_by_pid: 72788,
      running_count: 2,
      queued_held_count: 4,
    });

    expect(message).toContain("phase was 'draining'");
    expect(message).toContain('reason=node24 rebuild');
    expect(message).toContain('requested_by_pid=72788');
    expect(message).toContain('running_count=2');
  });

  it('writes a sync exit diagnostic when restart state is active', () => {
    restartHandoff.writeRestartIntent({
      barrier_id: 'exit-barrier',
      reason: 'cutover',
      phase: 'draining',
    });

    const diagnostic = restartHandoff.writeRestartExitDiagnostic({
      event: 'exit',
      code: 0,
      shutdown_state: 'running',
      restart_pending: false,
    });

    expect(diagnostic).toMatchObject({
      event: 'exit',
      code: 0,
      shutdown_state: 'running',
      intent: {
        barrier_id: 'exit-barrier',
        phase: 'draining',
      },
    });
    const log = fs.readFileSync(restartHandoff.getRestartExitDiagnosticsPath(), 'utf8');
    expect(log).toContain('"event":"exit"');
    expect(log).toContain('"barrier_id":"exit-barrier"');
  });
});
