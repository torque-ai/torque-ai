'use strict';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));

const loopController = require('../factory/loop-controller');

describe('findExistingPlanTaskSubmission', () => {
  const { findExistingPlanTaskSubmission } = loopController._internalForTests;

  it('prefers a matching active task from the current batch', () => {
    const listTasks = vi.fn(() => ([
      {
        id: 'wrong-step',
        status: 'running',
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=2', 'factory:batch_id=current-batch'],
      },
      {
        id: 'older-completed',
        status: 'completed',
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=older-batch'],
      },
      {
        id: 'current-running',
        status: 'running',
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=current-batch'],
      },
    ]));

    expect(findExistingPlanTaskSubmission({ listTasks }, {
      projectName: 'DLPhone',
      workingDirectory: 'C:/repo',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
    })).toEqual({
      task_id: 'current-running',
      status: 'running',
    });

    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({
      project: 'DLPhone',
      workingDirectory: 'C:/repo',
      tag: 'factory:work_item_id=708',
      statuses: ['pending', 'pending_approval', 'queued', 'running', 'completed'],
    }));
  });

  it('falls back to a prior completed task when the same step already landed', () => {
    const listTasks = vi.fn(() => ([
      {
        id: 'prior-completed',
        status: 'completed',
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=older-batch'],
      },
    ]));

    expect(findExistingPlanTaskSubmission({ listTasks }, {
      projectName: 'DLPhone',
      workingDirectory: 'C:/repo',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
    })).toEqual({
      task_id: 'prior-completed',
      status: 'completed',
    });
  });

  it('ignores stale never-started pending tasks and reuses completed work', () => {
    const listTasks = vi.fn(() => ([
      {
        id: 'stale-pending',
        status: 'pending',
        created_at: '2000-01-01T00:00:00.000Z',
        started_at: null,
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=current-batch'],
      },
      {
        id: 'prior-completed',
        status: 'completed',
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=older-batch'],
      },
    ]));

    expect(findExistingPlanTaskSubmission({ listTasks }, {
      projectName: 'DLPhone',
      workingDirectory: 'C:/repo',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
    })).toEqual({
      task_id: 'prior-completed',
      status: 'completed',
    });

    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({
      columns: ['id', 'status', 'tags', 'created_at', 'started_at'],
    }));
  });

  it('still treats fresh never-started pending tasks as active', () => {
    const listTasks = vi.fn(() => ([
      {
        id: 'fresh-pending',
        status: 'pending',
        created_at: new Date().toISOString(),
        started_at: null,
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=current-batch'],
      },
      {
        id: 'prior-completed',
        status: 'completed',
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=older-batch'],
      },
    ]));

    expect(findExistingPlanTaskSubmission({ listTasks }, {
      projectName: 'DLPhone',
      workingDirectory: 'C:/repo',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
    })).toEqual({
      task_id: 'fresh-pending',
      status: 'pending',
    });
  });
});
