'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');
const { promotePendingRestartResubmissions } = require('../execution/restart-resubmit-queue');

describe('restart resubmission queue repair', () => {
  let testDir;

  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`restart-resubmit-queue-${Date.now()}`));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
    testDir = null;
  });

  it('queues pending restart-resubmitted task clones without touching ordinary pending tasks', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    taskCore.createTask({
      id: 'restart-clone',
      status: 'pending',
      task_description: 'restart clone',
      provider: 'codex',
      working_directory: testDir,
      metadata: {
        resubmitted_from: 'cancelled-original',
        restart_resubmit_count: 1,
      },
    });
    taskCore.createTask({
      id: 'ordinary-pending',
      status: 'pending',
      task_description: 'ordinary pending task',
      provider: 'codex',
      working_directory: testDir,
    });

    const result = promotePendingRestartResubmissions(taskCore, { logger });

    expect(result).toMatchObject({ scanned: 2, promoted: 1, failed: 0 });
    expect(taskCore.getTask('restart-clone')).toMatchObject({
      status: 'queued',
      provider: 'codex',
    });
    expect(taskCore.getTask('ordinary-pending')).toMatchObject({
      status: 'pending',
      provider: 'codex',
    });
  });
});
