'use strict';

const { randomUUID } = require('crypto');

const { createEventBus } = require('../event-bus');
const {
  MAX_RECOVERY_ATTEMPTS,
  VERIFY_STALL_THRESHOLD_MS,
  recoverStalledVerifyLoops,
} = require('../factory/verify-stall-recovery');
const { rawDb, resetTables, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;

function insertProject({
  loopState,
  pausedAtStage = null,
  lastActionAt,
}) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO factory_projects (
      id,
      name,
      path,
      status,
      loop_state,
      loop_paused_at_stage,
      loop_last_action_at
    )
    VALUES (?, ?, ?, 'running', ?, ?, ?)
  `).run(
    id,
    `Project ${id}`,
    `C:/projects/${id}`,
    loopState,
    pausedAtStage,
    lastActionAt,
  );
  return id;
}

function makeLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

beforeAll(() => {
  setupTestDbOnly('verify-stall-recovery');
  db = rawDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  // factory_decisions has FKs to factory_projects; reset children first to
  // avoid FOREIGN KEY constraint failures. Recovery now writes decision log
  // entries on auto-retry / unrecoverable branches.
  resetTables(['factory_decisions', 'factory_projects']);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-18T18:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recoverStalledVerifyLoops', () => {
  it('retries stalled VERIFY loops with the correct project_id', async () => {
    const projectId = insertProject({
      loopState: 'VERIFY',
      lastActionAt: new Date(Date.now() - (VERIFY_STALL_THRESHOLD_MS + 60 * 1000)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockResolvedValue({});
    const logger = makeLogger();
    const eventBus = createEventBus();
    const retryEvents = [];
    eventBus.onFactoryVerifyAutoRetry((payload) => retryEvents.push(payload));

    const actions = await recoverStalledVerifyLoops({
      db,
      logger,
      eventBus,
      retryFactoryVerify,
    });

    expect(retryFactoryVerify).toHaveBeenCalledWith({ project_id: projectId });
    expect(actions).toEqual([{ project_id: projectId, action: 'retry', attempts: 1 }]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Auto-retrying stalled VERIFY loop',
      expect.objectContaining({
        event: 'factory_verify_auto_retry',
        project_id: projectId,
        attempts: 1,
      }),
    );
    expect(retryEvents).toEqual([
      expect.objectContaining({
        project_id: projectId,
        attempts: 1,
      }),
    ]);
  });

  it('does nothing for recent VERIFY activity below the stall threshold', async () => {
    insertProject({
      loopState: 'VERIFY',
      lastActionAt: new Date(Date.now() - (VERIFY_STALL_THRESHOLD_MS - 60 * 1000)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockResolvedValue({});
    const logger = makeLogger();

    const actions = await recoverStalledVerifyLoops({
      db,
      logger,
      eventBus: createEventBus(),
      retryFactoryVerify,
    });

    expect(actions).toEqual([]);
    expect(retryFactoryVerify).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ignores non-VERIFY loop states regardless of age', async () => {
    insertProject({
      loopState: 'IDLE',
      lastActionAt: new Date(Date.now() - (2 * VERIFY_STALL_THRESHOLD_MS)).toISOString(),
    });
    insertProject({
      loopState: 'PLAN',
      lastActionAt: new Date(Date.now() - (2 * VERIFY_STALL_THRESHOLD_MS)).toISOString(),
    });
    insertProject({
      loopState: 'SENSE',
      lastActionAt: new Date(Date.now() - (2 * VERIFY_STALL_THRESHOLD_MS)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockResolvedValue({});

    const actions = await recoverStalledVerifyLoops({
      db,
      logger: makeLogger(),
      eventBus: createEventBus(),
      retryFactoryVerify,
    });

    expect(actions).toEqual([]);
    expect(retryFactoryVerify).not.toHaveBeenCalled();
  });

  it('treats PAUSED-at-VERIFY the same as VERIFY', async () => {
    const projectId = insertProject({
      loopState: 'PAUSED',
      pausedAtStage: 'VERIFY',
      lastActionAt: new Date(Date.now() - (VERIFY_STALL_THRESHOLD_MS + 60 * 1000)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockResolvedValue({});

    const actions = await recoverStalledVerifyLoops({
      db,
      logger: makeLogger(),
      eventBus: createEventBus(),
      retryFactoryVerify,
    });

    expect(retryFactoryVerify).toHaveBeenCalledWith({ project_id: projectId });
    expect(actions).toEqual([{ project_id: projectId, action: 'retry', attempts: 1 }]);
  });

  it('skips stalled VERIFY recovery when the caller reports the loop is still waiting on batch tasks', async () => {
    const projectId = insertProject({
      loopState: 'PAUSED',
      pausedAtStage: 'VERIFY',
      lastActionAt: new Date(Date.now() - (VERIFY_STALL_THRESHOLD_MS + 60 * 1000)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockResolvedValue({});
    const shouldSkipStalledLoop = vi.fn().mockResolvedValue('batch_tasks_not_terminal');

    const actions = await recoverStalledVerifyLoops({
      db,
      logger: makeLogger(),
      eventBus: createEventBus(),
      retryFactoryVerify,
      shouldSkipStalledLoop,
    });

    expect(shouldSkipStalledLoop).toHaveBeenCalledWith(expect.objectContaining({
      project_id: projectId,
      attempts: 0,
    }));
    expect(actions).toEqual([]);
    expect(retryFactoryVerify).not.toHaveBeenCalled();
  });

  it('emits factory:verify_unrecoverable after max recovery attempts without retrying again', async () => {
    const projectId = insertProject({
      loopState: 'VERIFY',
      lastActionAt: new Date(Date.now() - (VERIFY_STALL_THRESHOLD_MS + 60 * 1000)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockResolvedValue({});
    const logger = makeLogger();
    const eventBus = createEventBus();
    const unrecoverableEvents = [];
    eventBus.onFactoryVerifyUnrecoverable((payload) => unrecoverableEvents.push(payload));

    await recoverStalledVerifyLoops({ db, logger, eventBus, retryFactoryVerify });
    await recoverStalledVerifyLoops({ db, logger, eventBus, retryFactoryVerify });
    const actions = await recoverStalledVerifyLoops({ db, logger, eventBus, retryFactoryVerify });

    expect(retryFactoryVerify).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);
    expect(actions).toEqual([{ project_id: projectId, action: 'skipped_maxed', attempts: MAX_RECOVERY_ATTEMPTS }]);
    expect(unrecoverableEvents).toEqual([
      expect.objectContaining({
        project_id: projectId,
        attempts: MAX_RECOVERY_ATTEMPTS,
      }),
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      'Stalled VERIFY loop reached max auto-recovery attempts',
      expect.objectContaining({
        event: 'factory_verify_unrecoverable',
        project_id: projectId,
        attempts: MAX_RECOVERY_ATTEMPTS,
      }),
    );
  });

  it('delegates maxed stalled VERIFY loops to a terminal resolver and stops reprocessing after state clears', async () => {
    const projectId = insertProject({
      loopState: 'VERIFY',
      lastActionAt: new Date(Date.now() - (VERIFY_STALL_THRESHOLD_MS + 60 * 1000)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockResolvedValue({});
    const resolveUnrecoverableVerify = vi.fn().mockImplementation(async ({ project_id }) => {
      db.prepare(`
        UPDATE factory_projects
        SET loop_state = 'IDLE',
            loop_paused_at_stage = NULL,
            loop_last_action_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), project_id);
      return {
        action: 'resolved_unrecoverable_verify',
        terminated_instances: ['inst-1'],
      };
    });
    const logger = makeLogger();

    await recoverStalledVerifyLoops({ db, logger, eventBus: createEventBus(), retryFactoryVerify });
    await recoverStalledVerifyLoops({ db, logger, eventBus: createEventBus(), retryFactoryVerify });
    const actions = await recoverStalledVerifyLoops({
      db,
      logger,
      eventBus: createEventBus(),
      retryFactoryVerify,
      resolveUnrecoverableVerify,
    });
    const nextActions = await recoverStalledVerifyLoops({
      db,
      logger,
      eventBus: createEventBus(),
      retryFactoryVerify,
      resolveUnrecoverableVerify,
    });

    expect(resolveUnrecoverableVerify).toHaveBeenCalledWith(expect.objectContaining({
      project_id: projectId,
      attempts: MAX_RECOVERY_ATTEMPTS,
    }));
    expect(actions).toEqual([
      {
        project_id: projectId,
        action: 'resolved_unrecoverable_verify',
        attempts: MAX_RECOVERY_ATTEMPTS,
        resolution: {
          action: 'resolved_unrecoverable_verify',
          terminated_instances: ['inst-1'],
        },
      },
    ]);
    expect(nextActions).toEqual([]);
  });

  it('keeps attempt counts across invocations when the DB column is absent', async () => {
    const projectId = insertProject({
      loopState: 'VERIFY',
      lastActionAt: new Date(Date.now() - (VERIFY_STALL_THRESHOLD_MS + 60 * 1000)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockResolvedValue({});

    const first = await recoverStalledVerifyLoops({
      db,
      logger: makeLogger(),
      eventBus: createEventBus(),
      retryFactoryVerify,
    });
    const second = await recoverStalledVerifyLoops({
      db,
      logger: makeLogger(),
      eventBus: createEventBus(),
      retryFactoryVerify,
    });

    expect(first).toEqual([{ project_id: projectId, action: 'retry', attempts: 1 }]);
    expect(second).toEqual([{ project_id: projectId, action: 'retry', attempts: 2 }]);
  });

  it('catches retryFactoryVerify failures and logs them without throwing', async () => {
    const projectId = insertProject({
      loopState: 'VERIFY',
      lastActionAt: new Date(Date.now() - (VERIFY_STALL_THRESHOLD_MS + 60 * 1000)).toISOString(),
    });
    const retryFactoryVerify = vi.fn().mockRejectedValue(new Error('retry blew up'));
    const logger = makeLogger();

    await expect(recoverStalledVerifyLoops({
      db,
      logger,
      eventBus: createEventBus(),
      retryFactoryVerify,
    })).resolves.toEqual([
      { project_id: projectId, action: 'terminated', attempts: 1 },
    ]);

    expect(logger.error).toHaveBeenCalledWith(
      'Auto-retry for stalled VERIFY loop failed',
      expect.objectContaining({
        event: 'factory_verify_retry_failed',
        project_id: projectId,
        attempts: 1,
        err: 'retry blew up',
      }),
    );
  });
});
