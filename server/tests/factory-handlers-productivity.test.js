const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const childProcess = require('child_process');

const factoryHandlers = require('../handlers/factory-handlers');
const { rawDb, resetTables, safeTool, setupTestDb, teardownTestDb } = require('./vitest-setup');

function createGitProcess({ stdout = '', code = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();

  setImmediate(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    child.stdout.end(stdout);
    child.stderr.end();
    child.emit('close', code);
  });

  return child;
}

function insertProject(db, {
  id,
  name,
  projectPath,
  status,
  loopState = 'IDLE',
  loopPausedAtStage = null,
  loopLastActionAt = null,
}) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO factory_projects (
      id,
      name,
      path,
      brief,
      trust_level,
      status,
      config_json,
      loop_state,
      loop_batch_id,
      loop_last_action_at,
      loop_paused_at_stage,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    projectPath,
    `${name} brief`,
    'guided',
    status,
    null,
    loopState,
    null,
    loopLastActionAt,
    loopPausedAtStage,
    createdAt,
    createdAt,
  );
}

function insertActiveLoopInstance(db, {
  projectId,
  loopState,
  pausedAtStage = null,
  lastActionAt = null,
  batchId = null,
}) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO factory_loop_instances (
      id,
      project_id,
      batch_id,
      loop_state,
      paused_at_stage,
      last_action_at,
      created_at,
      terminated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    `${projectId}-instance`,
    projectId,
    batchId,
    loopState,
    pausedAtStage,
    lastActionAt,
    createdAt,
  );
}

describe('factory_status productivity', () => {
  let testDir;

  beforeAll(() => {
    ({ testDir } = setupTestDb('factory-handlers-productivity'));
  });

  beforeEach(() => {
    resetTables(['factory_loop_instances', 'factory_projects']);
    factoryHandlers.__test.clearCommitsTodayCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    factoryHandlers.__test.clearCommitsTodayCache();
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('returns commits_today for each project and counts only running zero-commit projects', async () => {
    const db = rawDb();
    const alphaPath = path.join(testDir, 'alpha');
    const betaPath = path.join(testDir, 'beta');
    const gammaPath = path.join(testDir, 'gamma');
    fs.mkdirSync(alphaPath, { recursive: true });
    fs.mkdirSync(betaPath, { recursive: true });
    fs.mkdirSync(gammaPath, { recursive: true });

    insertProject(db, { id: 'alpha', name: 'Alpha', projectPath: alphaPath, status: 'running', loopState: 'PLAN' });
    insertProject(db, { id: 'beta', name: 'Beta', projectPath: betaPath, status: 'running', loopState: 'EXECUTE' });
    insertProject(db, { id: 'gamma', name: 'Gamma', projectPath: gammaPath, status: 'paused', loopState: 'PAUSED', loopPausedAtStage: 'VERIFY_FAIL' });
    insertActiveLoopInstance(db, { projectId: 'alpha', loopState: 'PLAN' });
    insertActiveLoopInstance(db, { projectId: 'beta', loopState: 'EXECUTE' });
    insertActiveLoopInstance(db, { projectId: 'gamma', loopState: 'PAUSED', pausedAtStage: 'VERIFY_FAIL' });

    const outputsByPath = new Map([
      [alphaPath, '1111111 alpha\n2222222 beta\n'],
      [betaPath, ''],
      [gammaPath, ''],
    ]);
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation((_command, _args, options = {}) => {
      return createGitProcess({ stdout: outputsByPath.get(options.cwd) || '' });
    });

    const result = await safeTool('factory_status', {});

    expect(result.isError).toBeFalsy();
    const payload = result.structuredData;
    const projectsById = Object.fromEntries(payload.projects.map(project => [project.id, project]));

    expect(projectsById.alpha).toMatchObject({ commits_today: 2, status: 'running', loop_state: 'PLAN' });
    expect(projectsById.beta).toMatchObject({ commits_today: 0, status: 'running', loop_state: 'EXECUTE' });
    expect(projectsById.gamma).toMatchObject({
      commits_today: 0,
      status: 'paused',
      loop_state: 'PAUSED',
      loop_paused_at_stage: 'VERIFY_FAIL',
    });
    expect(payload.summary).toMatchObject({
      total: 3,
      running: 2,
      paused: 1,
      production_today: 2,
      zero_commit_projects: 1,
    });

    expect(spawnSpy).toHaveBeenCalledTimes(3);
    expect(spawnSpy).toHaveBeenCalledWith('git', ['log', '--since=midnight', '--oneline'], expect.objectContaining({
      cwd: alphaPath,
      windowsHide: true,
    }));
  });

  it('skips commit counting for basic project-list responses', async () => {
    const db = rawDb();
    const alphaPath = path.join(testDir, 'list-alpha');
    const betaPath = path.join(testDir, 'list-beta');
    fs.mkdirSync(alphaPath, { recursive: true });
    fs.mkdirSync(betaPath, { recursive: true });

    insertProject(db, { id: 'list-alpha', name: 'Alpha', projectPath: alphaPath, status: 'running' });
    insertProject(db, { id: 'list-beta', name: 'Beta', projectPath: betaPath, status: 'paused' });
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('git should not be spawned for basic project lists');
    });

    const result = await factoryHandlers.handleListFactoryProjects({ status: 'paused', summary: 'basic' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.projects).toEqual([
      expect.objectContaining({
        id: 'list-beta',
        name: 'Beta',
        path: betaPath,
        trust_level: 'guided',
        status: 'paused',
      }),
    ]);
    expect(result.structuredData.projects[0]).not.toHaveProperty('commits_today');
    expect(result.structuredData.projects[0]).not.toHaveProperty('scores');
    expect(result.structuredData.projects[0]).not.toHaveProperty('balance');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('can omit commit counts while preserving project health fields', async () => {
    const db = rawDb();
    const projectPath = path.join(testDir, 'list-without-commits');
    fs.mkdirSync(projectPath, { recursive: true });

    insertProject(db, { id: 'without-commits', name: 'WithoutCommits', projectPath, status: 'running' });
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('git should not be spawned when include_commits=false');
    });

    const result = await factoryHandlers.handleListFactoryProjects({ include_commits: 'false' });
    const project = result.structuredData.projects.find((entry) => entry.id === 'without-commits');

    expect(project).toMatchObject({
      id: 'without-commits',
      scores: {},
    });
    expect(project).toHaveProperty('balance');
    expect(project).not.toHaveProperty('commits_today');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('returns cached value within the ttl and refreshes after expiry', async () => {
    const projectPath = path.join(testDir, 'cache-project');
    fs.mkdirSync(projectPath, { recursive: true });

    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    spawnSpy
      .mockImplementationOnce(() => createGitProcess({ stdout: '1111111 alpha\n2222222 beta\n' }))
      .mockImplementationOnce(() => createGitProcess({ stdout: '3333333 gamma\n' }));

    await expect(factoryHandlers.__test.countCommitsToday(projectPath)).resolves.toBe(2);
    nowMs += 30_000;
    await expect(factoryHandlers.__test.countCommitsToday(projectPath)).resolves.toBe(2);
    nowMs += 61_000;
    await expect(factoryHandlers.__test.countCommitsToday(projectPath)).resolves.toBe(1);

    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('returns 0 when git fails or the path is not a repo', async () => {
    const projectPath = path.join(testDir, 'not-a-repo');
    fs.mkdirSync(projectPath, { recursive: true });

    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(() => createGitProcess({ code: 128 }));

    await expect(factoryHandlers.__test.countCommitsToday(projectPath)).resolves.toBe(0);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});
