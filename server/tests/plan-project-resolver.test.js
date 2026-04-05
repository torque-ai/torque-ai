import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const resolver = require('../execution/plan-project-resolver');

function createDbMocks() {
  return {
    getPlanProjectTask: vi.fn(),
    getPlanProject: vi.fn(),
    getPlanProjectTasks: vi.fn(() => []),
    updatePlanProject: vi.fn(),
    getDependentPlanTasks: vi.fn(() => []),
    getTask: vi.fn(() => null),
    updateTaskStatus: vi.fn(),
    areAllPlanDependenciesComplete: vi.fn(() => false),
  };
}

describe('execution/plan-project-resolver', () => {
  let db;
  let dashboard;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();

    db = createDbMocks();
    dashboard = { notifyTaskUpdated: vi.fn() };
    resolver.init({ db, dashboard });
  });

  it('ignores non-terminal statuses', () => {
    resolver.handleProjectDependencyResolution('task-1', 'running');

    expect(db.getPlanProjectTask).not.toHaveBeenCalled();
    expect(db.updateTaskStatus).not.toHaveBeenCalled();
    expect(db.updatePlanProject).not.toHaveBeenCalled();
    expect(dashboard.notifyTaskUpdated).not.toHaveBeenCalled();
  });

  it('handlePlanProjectTaskCompletion queues dependent tasks when all dependencies are complete', () => {
    db.getPlanProjectTask.mockReturnValue({ project_id: 'project-1' });
    db.getPlanProject.mockReturnValue({ total_tasks: 3 });
    db.getPlanProjectTasks.mockReturnValue([
      { id: 'task-1', status: 'completed' },
      { id: 'task-2', status: 'waiting' },
      { id: 'task-3', status: 'waiting' },
    ]);
    db.getDependentPlanTasks.mockReturnValue(['task-2']);
    db.getTask.mockImplementation((taskId) => {
      if (taskId === 'task-2') {
        return { id: 'task-2', status: 'waiting' };
      }
      return null;
    });
    db.areAllPlanDependenciesComplete.mockReturnValue(true);

    resolver.handlePlanProjectTaskCompletion('task-1');

    expect(db.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-2', 'queued');
    expect(db.areAllPlanDependenciesComplete).toHaveBeenCalledWith('task-2');
    expect(dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(1);
    expect(dashboard.notifyTaskUpdated).toHaveBeenCalledWith('task-2');
    expect(db.updatePlanProject).toHaveBeenCalledTimes(1);
    expect(db.updatePlanProject).toHaveBeenCalledWith('project-1', {
      completed_tasks: 1,
      failed_tasks: 0,
    });
  });

  it('blocks transitive dependents via BFS after a task fails', () => {
    db.getPlanProjectTask.mockReturnValue({ project_id: 'project-1' });
    db.getPlanProject.mockReturnValue({ total_tasks: 4 });
    db.getPlanProjectTasks.mockReturnValue([
      { id: 'task-1', status: 'failed' },
      { id: 'task-2', status: 'waiting' },
      { id: 'task-3', status: 'queued' },
      { id: 'task-99', status: 'running' },
    ]);

    const dependents = {
      'task-1': ['task-2', 'task-4'],
      'task-2': ['task-3'],
      'task-3': [],
      'task-4': [],
    };

    db.getDependentPlanTasks.mockImplementation((taskId) => dependents[taskId] ?? []);
    db.getTask.mockImplementation((taskId) => {
      const tasks = {
        'task-2': { id: 'task-2', status: 'waiting' },
        'task-3': { id: 'task-3', status: 'queued' },
        'task-4': { id: 'task-4', status: 'completed' },
      };
      return tasks[taskId] ?? null;
    });

    resolver.handleProjectDependencyResolution('task-1', 'failed');

    expect(db.updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(1, 'task-2', 'blocked');
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(2, 'task-3', 'blocked');
    expect(dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
    expect(dashboard.notifyTaskUpdated).toHaveBeenNthCalledWith(1, 'task-2');
    expect(dashboard.notifyTaskUpdated).toHaveBeenNthCalledWith(2, 'task-3');
    expect(db.updatePlanProject).toHaveBeenCalledTimes(1);
    expect(db.updatePlanProject).toHaveBeenCalledWith('project-1', {
      completed_tasks: 0,
      failed_tasks: 1,
    });
  });

  it('marks the project completed when all tasks are done', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:34:56.000Z'));

    db.getPlanProjectTask.mockReturnValue({ project_id: 'project-1' });
    db.getPlanProject.mockReturnValue({ total_tasks: 2 });
    db.getPlanProjectTasks.mockReturnValue([
      { id: 'task-1', status: 'completed' },
      { id: 'task-2', status: 'completed' },
    ]);

    resolver.handleProjectDependencyResolution('task-2', 'completed');

    expect(db.updatePlanProject).toHaveBeenNthCalledWith(1, 'project-1', {
      completed_tasks: 2,
      failed_tasks: 0,
    });
    expect(db.updatePlanProject).toHaveBeenNthCalledWith(2, 'project-1', {
      status: 'completed',
      completed_at: '2026-04-05T12:34:56.000Z',
    });
  });

  it('handlePlanProjectTaskFailure marks the project failed when no tasks can proceed', () => {
    db.getPlanProjectTask.mockReturnValue({ project_id: 'project-1' });
    db.getPlanProject.mockReturnValue({ total_tasks: 2 });
    db.getPlanProjectTasks
      .mockReturnValueOnce([
        { id: 'task-1', status: 'failed' },
        { id: 'task-2', status: 'waiting' },
      ])
      .mockReturnValueOnce([
        { id: 'task-1', status: 'failed' },
        { id: 'task-2', status: 'blocked' },
      ]);
    db.getDependentPlanTasks.mockImplementation((taskId) => (
      taskId === 'task-1' ? ['task-2'] : []
    ));
    db.getTask.mockImplementation((taskId) => {
      if (taskId === 'task-2') {
        return { id: 'task-2', status: 'waiting' };
      }
      return null;
    });

    resolver.handlePlanProjectTaskFailure('task-1');

    expect(db.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-2', 'blocked');
    expect(dashboard.notifyTaskUpdated).toHaveBeenCalledWith('task-2');
    expect(db.updatePlanProject).toHaveBeenNthCalledWith(1, 'project-1', {
      completed_tasks: 0,
      failed_tasks: 1,
    });
    expect(db.updatePlanProject).toHaveBeenNthCalledWith(2, 'project-1', {
      status: 'failed',
    });
  });
});
