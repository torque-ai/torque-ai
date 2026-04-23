'use strict';

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
    teardownTestDb();
  });

  beforeEach(() => {
    resetTables('tasks');
    restartHandoff.clearRestartHandoff();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restartHandoff.clearRestartHandoff();
    vi.restoreAllMocks();
  });

  it('completes a matching running restart barrier on successor startup', () => {
    const barrierId = createRunningBarrier();
    restartHandoff.writeRestartHandoff({
      barrier_id: barrierId,
      reason: 'cutover',
      requested_at: '2026-04-23T19:34:18.000Z',
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
});
