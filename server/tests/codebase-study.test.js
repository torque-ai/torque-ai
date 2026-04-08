'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function resetCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that are not currently loaded.
  }
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeRepoFile(repoDir, relativePath, content) {
  const fullPath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function createRepo(files) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-study-'));
  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.email', 'study@example.com']);
  runGit(repoDir, ['config', 'user.name', 'Study Test']);
  Object.entries(files).forEach(([relativePath, content]) => {
    writeRepoFile(repoDir, relativePath, content);
  });
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'initial']);
  return repoDir;
}

function loadStudyModule(mocks) {
  [
    '../integrations/codebase-study',
    '../handlers/integration/routing',
    '../handlers/workflow/await',
  ].forEach(resetCjsModule);

  installCjsModuleMock('../handlers/integration/routing', {
    handleSmartSubmitTask: mocks.handleSmartSubmitTask,
  });
  installCjsModuleMock('../handlers/workflow/await', {
    handleAwaitTask: mocks.handleAwaitTask,
  });

  return require('../integrations/codebase-study');
}

describe('codebase study integration', () => {
  let repoDir;
  let handleSmartSubmitTask;
  let handleAwaitTask;

  afterEach(() => {
    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      repoDir = null;
    }
    [
      '../integrations/codebase-study',
      '../handlers/integration/routing',
      '../handlers/workflow/await',
    ].forEach(resetCjsModule);
  });

  function createService(taskCoreOverrides = {}) {
    handleSmartSubmitTask = vi.fn(async () => ({
      task_id: 'study-task-1',
      content: [{ type: 'text', text: 'submitted' }],
    }));
    handleAwaitTask = vi.fn(async () => ({
      content: [{ type: 'text', text: 'completed' }],
    }));

    const { createCodebaseStudy } = loadStudyModule({
      handleSmartSubmitTask,
      handleAwaitTask,
    });

    const taskCore = {
      listTasks: vi.fn(() => []),
      getTask: vi.fn(() => ({ id: 'study-task-1', status: 'completed' })),
      ...taskCoreOverrides,
    };

    return {
      service: createCodebaseStudy({
        db: {},
        taskCore,
        logger: {
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
      }),
      taskCore,
    };
  }

  it('skips when the queue already has running tasks', async () => {
    repoDir = createRepo({
      'src/alpha.js': 'module.exports = 1;\n',
    });

    const { service } = createService({
      listTasks: vi.fn(() => [{ id: 'running-task', status: 'running' }]),
    });

    const result = await service.runStudyCycle(repoDir);

    expect(result).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'queue_active',
      running_task_count: 1,
    }));
    expect(handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(handleAwaitTask).not.toHaveBeenCalled();
  });

  it('detects delta files from the previous study sha', async () => {
    repoDir = createRepo({
      'src/alpha.js': 'module.exports = 1;\n',
      'src/beta.ts': 'export const beta = 2;\n',
      'data/config.json': '{"ok":true}\n',
    });

    const { service } = createService();
    const firstRun = await service.runStudyCycle(repoDir);
    expect(firstRun.batch_files.sort()).toEqual(['data/config.json', 'src/alpha.js', 'src/beta.ts']);

    writeRepoFile(repoDir, 'src/alpha.js', 'module.exports = 42;\n');
    writeRepoFile(repoDir, 'src/gamma.js', 'module.exports = 3;\n');
    writeRepoFile(repoDir, 'README.md', '# ignored\n');
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'delta']);

    const secondRun = await service.runStudyCycle(repoDir);

    expect(secondRun.batch_files.sort()).toEqual(['src/alpha.js', 'src/gamma.js']);
    expect(handleSmartSubmitTask).toHaveBeenCalledTimes(2);
  });

  it('caps each study batch at five files', async () => {
    repoDir = createRepo({
      'src/a.js': 'module.exports = "a";\n',
      'src/b.js': 'module.exports = "b";\n',
      'src/c.js': 'module.exports = "c";\n',
      'src/d.js': 'module.exports = "d";\n',
      'src/e.js': 'module.exports = "e";\n',
      'src/f.js': 'module.exports = "f";\n',
      'src/g.js': 'module.exports = "g";\n',
    });

    const { service } = createService();
    const result = await service.runStudyCycle(repoDir);

    expect(result.skipped).toBe(false);
    expect(result.batch_files).toHaveLength(5);
    expect(result.pending_count).toBe(2);
    expect(handleSmartSubmitTask.mock.calls[0][0].files).toHaveLength(7);
  });

  it('persists pending state across runs until the backlog is empty', async () => {
    repoDir = createRepo({
      'src/a.js': 'module.exports = "a";\n',
      'src/b.js': 'module.exports = "b";\n',
      'src/c.js': 'module.exports = "c";\n',
      'src/d.js': 'module.exports = "d";\n',
      'src/e.js': 'module.exports = "e";\n',
      'src/f.js': 'module.exports = "f";\n',
      'src/g.js': 'module.exports = "g";\n',
    });

    const { service } = createService();
    const firstRun = await service.runStudyCycle(repoDir);
    expect(firstRun.pending_count).toBe(2);

    const statePath = path.join(repoDir, 'docs', 'architecture', 'study-state.json');
    const persistedAfterFirstRun = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(persistedAfterFirstRun.run_count).toBe(1);
    expect(persistedAfterFirstRun.pending_files).toHaveLength(2);
    expect(persistedAfterFirstRun.last_sha).toBe(runGit(repoDir, ['rev-parse', 'HEAD']));

    const secondRun = await service.runStudyCycle(repoDir);
    expect(secondRun.pending_count).toBe(0);

    const status = await service.getStudyStatus(repoDir);
    expect(status.run_count).toBe(2);
    expect(status.pending_count).toBe(0);
    expect(status.tracked_count).toBe(7);
  });
});
