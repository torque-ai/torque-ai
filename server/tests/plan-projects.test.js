import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const planProjects = require('../db/plan-projects');

const PLAN_PROJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_projects (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  source_file TEXT,
  status TEXT DEFAULT 'active',
  total_tasks INTEGER DEFAULT 0,
  completed_tasks INTEGER DEFAULT 0,
  failed_tasks INTEGER DEFAULT 0,
  completed_at TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS plan_project_tasks (
  project_id TEXT,
  task_id TEXT,
  sequence_number INTEGER,
  depends_on TEXT,
  PRIMARY KEY(project_id, task_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT,
  task_description TEXT,
  provider TEXT,
  created_at TEXT
);
`;

let db;
let dbHandle;
let getTaskMock;

function insertTask({
  id,
  status = 'queued',
  task_description = `Task ${id}`,
  provider = 'codex',
  created_at = '2026-04-05T12:00:00.000Z',
} = {}) {
  dbHandle.prepare(`
    INSERT INTO tasks (id, status, task_description, provider, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, status, task_description, provider, created_at);
}

beforeEach(() => {
  ({ db } = setupTestDbOnly('plan-projects'));
  dbHandle = db.getDbInstance();
  dbHandle.exec(PLAN_PROJECTS_SCHEMA);

  planProjects.setDb(dbHandle);
  getTaskMock = vi.fn((taskId) => (
    dbHandle.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) || null
  ));
  planProjects.setGetTask(getTaskMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  teardownTestDb();
});

describe('server/db/plan-projects', () => {
  it('createPlanProject creates and returns a project', () => {
    const project = planProjects.createPlanProject({
      id: 'project-1',
      name: 'Alpha',
      description: 'Project description',
      source_file: 'plans/alpha.md',
      total_tasks: 3,
    });

    expect(project).toMatchObject({
      id: 'project-1',
      name: 'Alpha',
      description: 'Project description',
      source_file: 'plans/alpha.md',
      status: 'active',
      total_tasks: 3,
      completed_tasks: 0,
      failed_tasks: 0,
      completed_at: null,
      created_at: expect.any(String),
    });
  });

  it('getPlanProject returns null for a non-existent project', () => {
    expect(planProjects.getPlanProject('missing-project')).toBeNull();
  });

  it('listPlanProjects filters by status', () => {
    planProjects.createPlanProject({ id: 'project-active', name: 'Active project' });
    planProjects.createPlanProject({ id: 'project-paused', name: 'Paused project' });
    planProjects.updatePlanProject('project-paused', { status: 'paused' });

    const pausedProjects = planProjects.listPlanProjects({ status: 'paused' });

    expect(pausedProjects).toHaveLength(1);
    expect(pausedProjects[0]).toMatchObject({
      id: 'project-paused',
      status: 'paused',
    });
  });

  it('updatePlanProject updates status and counters', () => {
    planProjects.createPlanProject({ id: 'project-2', name: 'Beta', total_tasks: 3 });

    const updated = planProjects.updatePlanProject('project-2', {
      status: 'completed',
      total_tasks: 4,
      completed_tasks: 3,
      failed_tasks: 1,
      completed_at: '2026-04-05T15:00:00.000Z',
    });

    expect(updated).toMatchObject({
      id: 'project-2',
      status: 'completed',
      total_tasks: 4,
      completed_tasks: 3,
      failed_tasks: 1,
      completed_at: '2026-04-05T15:00:00.000Z',
    });
  });

  it('addTaskToPlanProject and getPlanProjectTask round-trip the task link', () => {
    planProjects.createPlanProject({ id: 'project-3', name: 'Gamma' });
    insertTask({ id: 'task-1', status: 'queued' });

    planProjects.addTaskToPlanProject('project-3', 'task-1', 1, ['task-0']);

    expect(planProjects.getPlanProjectTask('task-1')).toEqual({
      project_id: 'project-3',
      task_id: 'task-1',
      sequence_number: 1,
      depends_on: ['task-0'],
    });
  });

  it('getPlanProjectTasks returns tasks with parsed depends_on', () => {
    planProjects.createPlanProject({ id: 'project-4', name: 'Delta' });
    insertTask({
      id: 'task-a',
      status: 'completed',
      task_description: 'First task',
      provider: 'codex',
      created_at: '2026-04-05T10:00:00.000Z',
    });
    insertTask({
      id: 'task-b',
      status: 'running',
      task_description: 'Second task',
      provider: 'ollama',
      created_at: '2026-04-05T11:00:00.000Z',
    });

    planProjects.addTaskToPlanProject('project-4', 'task-a', 1);
    planProjects.addTaskToPlanProject('project-4', 'task-b', 2, ['task-a']);

    const tasks = planProjects.getPlanProjectTasks('project-4');

    expect(tasks).toEqual([
      {
        project_id: 'project-4',
        task_id: 'task-a',
        sequence_number: 1,
        depends_on: [],
        status: 'completed',
        task_description: 'First task',
        provider: 'codex',
        task_created_at: '2026-04-05T10:00:00.000Z',
      },
      {
        project_id: 'project-4',
        task_id: 'task-b',
        sequence_number: 2,
        depends_on: ['task-a'],
        status: 'running',
        task_description: 'Second task',
        provider: 'ollama',
        task_created_at: '2026-04-05T11:00:00.000Z',
      },
    ]);
  });

  it('getDependentPlanTasks finds tasks depending on the given task', () => {
    planProjects.createPlanProject({ id: 'project-5', name: 'Epsilon' });
    insertTask({ id: 'root-task' });
    insertTask({ id: 'child-task-1' });
    insertTask({ id: 'child-task-2' });
    insertTask({ id: 'independent-task' });

    planProjects.addTaskToPlanProject('project-5', 'root-task', 1);
    planProjects.addTaskToPlanProject('project-5', 'child-task-1', 2, ['root-task']);
    planProjects.addTaskToPlanProject('project-5', 'child-task-2', 3, ['other-task', 'root-task']);
    planProjects.addTaskToPlanProject('project-5', 'independent-task', 4, ['other-task']);

    const dependentTasks = planProjects.getDependentPlanTasks('root-task');

    expect(dependentTasks.sort()).toEqual(['child-task-1', 'child-task-2']);
  });

  it('areAllPlanDependenciesComplete returns true when all dependencies are completed', () => {
    planProjects.createPlanProject({ id: 'project-6', name: 'Zeta' });
    insertTask({ id: 'dep-1', status: 'completed' });
    insertTask({ id: 'dep-2', status: 'completed' });
    insertTask({ id: 'target-task', status: 'queued' });

    planProjects.addTaskToPlanProject('project-6', 'dep-1', 1);
    planProjects.addTaskToPlanProject('project-6', 'dep-2', 2);
    planProjects.addTaskToPlanProject('project-6', 'target-task', 3, ['dep-1', 'dep-2']);

    expect(planProjects.areAllPlanDependenciesComplete('target-task')).toBe(true);
    expect(getTaskMock).toHaveBeenCalledWith('dep-1');
    expect(getTaskMock).toHaveBeenCalledWith('dep-2');
  });

  it('areAllPlanDependenciesComplete returns false with pending dependencies', () => {
    planProjects.createPlanProject({ id: 'project-7', name: 'Eta' });
    insertTask({ id: 'dep-done', status: 'completed' });
    insertTask({ id: 'dep-pending', status: 'running' });
    insertTask({ id: 'target-task', status: 'queued' });

    planProjects.addTaskToPlanProject('project-7', 'dep-done', 1);
    planProjects.addTaskToPlanProject('project-7', 'dep-pending', 2);
    planProjects.addTaskToPlanProject('project-7', 'target-task', 3, ['dep-done', 'dep-pending']);

    expect(planProjects.areAllPlanDependenciesComplete('target-task')).toBe(false);
  });

  it('hasFailedPlanDependency detects failed dependencies', () => {
    planProjects.createPlanProject({ id: 'project-8', name: 'Theta' });
    insertTask({ id: 'dep-ok', status: 'completed' });
    insertTask({ id: 'dep-failed', status: 'failed' });
    insertTask({ id: 'target-task', status: 'queued' });

    planProjects.addTaskToPlanProject('project-8', 'dep-ok', 1);
    planProjects.addTaskToPlanProject('project-8', 'dep-failed', 2);
    planProjects.addTaskToPlanProject('project-8', 'target-task', 3, ['dep-ok', 'dep-failed']);

    expect(planProjects.hasFailedPlanDependency('target-task')).toBe(true);
    expect(getTaskMock).toHaveBeenCalledWith('dep-ok');
    expect(getTaskMock).toHaveBeenCalledWith('dep-failed');
  });

  it('deletePlanProject removes the project and task links', () => {
    planProjects.createPlanProject({ id: 'project-9', name: 'Iota' });
    insertTask({ id: 'delete-task-1' });
    insertTask({ id: 'delete-task-2' });
    planProjects.addTaskToPlanProject('project-9', 'delete-task-1', 1);
    planProjects.addTaskToPlanProject('project-9', 'delete-task-2', 2, ['delete-task-1']);

    planProjects.deletePlanProject('project-9');

    const remainingLinks = dbHandle.prepare(`
      SELECT task_id FROM plan_project_tasks WHERE project_id = ?
    `).all('project-9');

    expect(planProjects.getPlanProject('project-9')).toBeNull();
    expect(remainingLinks).toEqual([]);
  });
});
