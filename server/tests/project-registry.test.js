'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const routes = require('../api/routes');
const taskCore = require('../db/task-core');
const projectConfigCore = require('../db/project-config-core');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('project registry', () => {
  let db;
  let rawDb;
  let testDir;
  let originalProjectsBase;

  beforeEach(() => {
    ({ db, testDir } = setupTestDbOnly('project-registry'));
    rawDb = db.getDbInstance();
    taskCore.setDb(rawDb);
    projectConfigCore.setDb(rawDb);

    for (const statement of [
      'ALTER TABLE project_config ADD COLUMN default_provider TEXT',
      'ALTER TABLE project_config ADD COLUMN verify_command TEXT',
    ]) {
      try {
        rawDb.exec(statement);
      } catch {
        // Column already exists in this test database variant.
      }
    }

    originalProjectsBase = process.env.TORQUE_PROJECTS_BASE;
    process.env.TORQUE_PROJECTS_BASE = testDir;
  });

  afterEach(() => {
    if (originalProjectsBase === undefined) {
      delete process.env.TORQUE_PROJECTS_BASE;
    } else {
      process.env.TORQUE_PROJECTS_BASE = originalProjectsBase;
    }
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('listKnownProjects merges task and config rows and sorts by last_active descending', () => {
    projectConfigCore.setProjectConfig('alpha', { verify_command: 'npm test' });
    projectConfigCore.setProjectConfig('gamma', { default_provider: 'codex' });

    const alphaOlderId = randomUUID();
    taskCore.createTask({
      id: alphaOlderId,
      task_description: 'Older alpha task',
      status: 'queued',
      working_directory: testDir,
      project: 'alpha',
    });
    rawDb.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-03-01T10:00:00.000Z', alphaOlderId);

    const alphaNewerId = randomUUID();
    taskCore.createTask({
      id: alphaNewerId,
      task_description: 'Newer alpha task',
      status: 'queued',
      working_directory: testDir,
      project: 'alpha',
    });
    rawDb.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-03-02T11:00:00.000Z', alphaNewerId);

    const betaId = randomUUID();
    taskCore.createTask({
      id: betaId,
      task_description: 'Beta task',
      status: 'queued',
      working_directory: testDir,
      project: 'beta',
    });
    rawDb.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-03-01T09:00:00.000Z', betaId);

    expect(taskCore.listKnownProjects()).toEqual([
      {
        name: 'alpha',
        task_count: 2,
        last_active: '2026-03-02T11:00:00.000Z',
        has_config: true,
      },
      {
        name: 'beta',
        task_count: 1,
        last_active: '2026-03-01T09:00:00.000Z',
        has_config: true,
      },
      {
        name: 'gamma',
        task_count: 0,
        last_active: null,
        has_config: true,
      },
    ]);
  });

  it('getProjectDefaults resolves both working-directory and project-name inputs', () => {
    projectConfigCore.setProjectConfig('alpha', {
      default_provider: 'codex',
      verify_command: 'npm test',
    });

    const projectRoot = path.join(testDir, 'alpha');
    const nestedDir = path.join(projectRoot, 'src');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');

    const fromPath = projectConfigCore.getProjectDefaults(nestedDir);
    expect(fromPath).toEqual(expect.objectContaining({
      project: 'alpha',
      working_directory: nestedDir,
      default_provider: 'codex',
      verify_command: 'npm test',
    }));

    const fromProject = projectConfigCore.getProjectDefaults('alpha');
    expect(fromProject).toEqual(expect.objectContaining({
      project: 'alpha',
      working_directory: path.join(testDir, 'alpha'),
      default_provider: 'codex',
      verify_command: 'npm test',
    }));
  });

  it('registers the structured GET /api/v2/projects route', () => {
    const route = routes.find((entry) => entry.method === 'GET' && entry.path === '/api/v2/projects');

    expect(route).toEqual(expect.objectContaining({
      tool: 'list_projects',
      handlerName: 'handleV2CpListProjects',
    }));
  });
});
