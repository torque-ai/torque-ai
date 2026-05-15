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
      projectName: 'example-project',
      workingDirectory: 'C:/repo',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
    })).toEqual({
      task_id: 'current-running',
      status: 'running',
      same_batch: true,
    });

    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({
      project: 'example-project',
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
      projectName: 'example-project',
      workingDirectory: 'C:/repo',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
    })).toEqual({
      task_id: 'prior-completed',
      status: 'completed',
      same_batch: false,
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
      projectName: 'example-project',
      workingDirectory: 'C:/repo',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
    })).toEqual({
      task_id: 'prior-completed',
      status: 'completed',
      same_batch: false,
    });

    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({
      columns: ['id', 'status', 'tags', 'created_at', 'started_at', 'metadata', 'working_directory'],
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
      projectName: 'example-project',
      workingDirectory: 'C:/repo',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
    })).toEqual({
      task_id: 'fresh-pending',
      status: 'pending',
      same_batch: true,
    });
  });

  it('does not reuse a completed task from a different generated plan path', () => {
    const listTasks = vi.fn(() => ([
      {
        id: 'stale-completed',
        status: 'completed',
        working_directory: 'C:/repo/.worktrees/old',
        metadata: { plan_path: 'C:/repo/.worktrees/old/docs/plan.md' },
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=current-batch'],
      },
    ]));

    expect(findExistingPlanTaskSubmission({ listTasks }, {
      projectName: 'example-project',
      workingDirectory: 'C:/repo/.worktrees/current',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
      planPath: 'C:/repo/.worktrees/current/docs/plan.md',
    })).toBeNull();
  });

  it('does not reuse an active task from a different worktree after fallback lookup', () => {
    const listTasks = vi.fn((options = {}) => {
      if (options.workingDirectory === 'C:/repo/.worktrees/current') {
        return [];
      }
      return [
        {
          id: 'old-running',
          status: 'running',
          working_directory: 'C:/repo/.worktrees/old',
          metadata: JSON.stringify({ plan_path: 'C:/repo/.worktrees/old/docs/plan.md' }),
          tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=current-batch'],
        },
      ];
    });

    expect(findExistingPlanTaskSubmission({ listTasks }, {
      projectName: 'example-project',
      workingDirectory: 'C:/repo/.worktrees/current',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
      planPath: 'C:/repo/.worktrees/old/docs/plan.md',
    })).toBeNull();
  });

  it('reuses a task from the current generated plan path', () => {
    const listTasks = vi.fn(() => ([
      {
        id: 'current-completed',
        status: 'completed',
        working_directory: 'C:/repo/.worktrees/current',
        metadata: JSON.stringify({ plan_path: 'C:/repo/.worktrees/current/docs/plan.md' }),
        tags: ['factory:work_item_id=708', 'factory:plan_task_number=1', 'factory:batch_id=current-batch'],
      },
    ]));

    expect(findExistingPlanTaskSubmission({ listTasks }, {
      projectName: 'example-project',
      workingDirectory: 'C:/repo/.worktrees/current',
      workItemId: 708,
      planTaskNumber: 1,
      batchId: 'current-batch',
      planPath: 'C:/repo/.worktrees/current/docs/plan.md',
    })).toEqual({
      task_id: 'current-completed',
      status: 'completed',
      same_batch: true,
    });
  });
});
