const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');

let testDir;
let createTask;
let listKnownProjects;
let handleListTasks;

function createDbTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  return createTask({
    id,
    task_description: overrides.task_description || `project-awareness-${id.slice(0, 8)}`,
    status: overrides.status || 'queued',
    ...overrides,
  });
}

function getTaskRow(taskId) {
  const row = rawDb().prepare('SELECT id, project, tags FROM tasks WHERE id = ?').get(taskId);
  return {
    ...(row || {}),
    tags: row?.tags ? JSON.parse(row.tags) : [],
  };
}

function createMarkedWorkingDirectory(projectName) {
  const projectRoot = path.join(testDir, projectName);
  const nestedDir = path.join(projectRoot, 'src', 'feature');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: projectName }), 'utf8');
  return nestedDir;
}

function insertProjectConfig(project) {
  const now = new Date().toISOString();
  rawDb().prepare(`
    INSERT INTO project_config (project, created_at, updated_at)
    VALUES (?, ?, ?)
  `).run(project, now, now);
}

describe('task project awareness', () => {
  beforeAll(() => {
    ({ testDir } = setupTestDbOnly('project-awareness'));
    ({ createTask, listKnownProjects } = require('../db/task-core'));
    ({ handleListTasks } = require('../handlers/task/core'));
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    rawDb().prepare('DELETE FROM tasks').run();
    rawDb().prepare('DELETE FROM project_config').run();
  });

  describe('explicit project on submit', () => {
    it('uses explicit project instead of auto-detect', () => {
      const workingDirectory = createMarkedWorkingDirectory('auto-detected-root');
      const task = createDbTask({
        working_directory: workingDirectory,
        project: 'my-project',
      });

      const row = getTaskRow(task.id);
      expect(row.project).toBe('my-project');
    });

    it('falls back to auto-detect when project not provided', () => {
      const workingDirectory = createMarkedWorkingDirectory('detected-project');
      const task = createDbTask({ working_directory: workingDirectory });

      const row = getTaskRow(task.id);
      expect(row.project).toBe('detected-project');
    });
  });

  describe('tags at creation time', () => {
    it('writes tags array at creation time', () => {
      const task = createDbTask({ tags: ['urgent', 'refactor'] });

      const row = getTaskRow(task.id);
      expect(row.tags).toEqual(['urgent', 'refactor']);
    });

    it('auto-adds project:<name> tag', () => {
      const task = createDbTask({
        project: 'my-project',
        tags: ['urgent'],
      });

      const row = getTaskRow(task.id);
      expect(row.tags).toEqual(expect.arrayContaining(['urgent', 'project:my-project']));
    });

    it('does not duplicate project tag if already present', () => {
      const task = createDbTask({
        project: 'foo',
        tags: ['project:foo'],
      });

      const row = getTaskRow(task.id);
      expect(row.tags.filter((tag) => tag === 'project:foo')).toHaveLength(1);
    });
  });

  describe('listKnownProjects', () => {
    it('returns projects from both tasks and project_config', () => {
      createDbTask({ project: 'alpha' });
      createDbTask({ project: 'beta' });
      insertProjectConfig('config-only');

      expect(typeof listKnownProjects).toBe('function');
      const projects = listKnownProjects();

      expect(projects.map((project) => project.name)).toEqual(
        expect.arrayContaining(['alpha', 'beta', 'config-only'])
      );
    });

    it('merges task counts with config presence', () => {
      createDbTask({ project: 'alpha' });
      createDbTask({ project: 'alpha' });
      createDbTask({ project: 'alpha' });
      insertProjectConfig('alpha');

      expect(typeof listKnownProjects).toBe('function');
      const alpha = listKnownProjects().find((project) => project.name === 'alpha');

      expect(alpha).toMatchObject({
        name: 'alpha',
        task_count: 3,
        has_config: true,
      });
    });
  });

  describe('list_tasks project filter', () => {
    it('filters tasks by project name', () => {
      const projATask = createDbTask({
        project: 'proj-a',
        task_description: 'project A task',
      });
      createDbTask({
        project: 'proj-b',
        task_description: 'project B task',
      });

      const result = handleListTasks({ project: 'proj-a', limit: 10 });

      expect(result.structuredData.count).toBe(1);
      expect(result.structuredData.tasks.map((task) => task.id)).toEqual([projATask.id]);
    });
  });
});
