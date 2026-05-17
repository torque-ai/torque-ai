const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const Module = require('module');
const { randomUUID } = require('crypto');

const { gitSync, cleanupRepo } = require('./git-test-utils');
const { setupTestDbOnly, teardownTestDb, getText, resetTables, rawDb } = require('./vitest-setup');

let taskCore;
let fileTracking;
let validationRules;
let costTracking;
let validationModule;

const TABLES_TO_RESET = [
  'validation_results',
  'diff_previews',
  'build_checks',
  'cost_tracking',
  'validation_rules',
  'cost_budgets',
  'tasks',
];

let repoDir;

function writeRepoFile(relativePath, content) {
  const absolutePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

function stageRepoFile(relativePath, content) {
  writeRepoFile(relativePath, content);
  gitSync(['add', relativePath], { cwd: repoDir });
}

function createTask(overrides = {}) {
  const task = taskCore.createTask({
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'validation handler test task',
    working_directory: overrides.working_directory || repoDir,
    provider: overrides.provider || 'codex',
    model: overrides.model || 'test-model',
    status: overrides.status || 'completed',
  });

  if (Object.prototype.hasOwnProperty.call(overrides, 'output')) {
    taskCore.updateTask(task.id, { output: overrides.output });
  }

  return taskCore.getTask(task.id);
}

function seedValidationRules() {
  validationRules.saveValidationRule({
    id: 'rule-no-todo-stubs',
    name: 'No TODO stubs',
    description: 'Reject placeholder TODO implementations',
    rule_type: 'pattern',
    pattern: 'TODO',
    severity: 'error',
  });
  validationRules.saveValidationRule({
    id: 'rule-no-empty-files',
    name: 'No empty files',
    description: 'Reject empty files',
    rule_type: 'size',
    condition: 'size:0',
    severity: 'error',
  });
  validationRules.saveValidationRule({
    id: 'rule-min-js-size',
    name: 'Minimum JS file size',
    description: 'Catch suspiciously truncated JavaScript files',
    rule_type: 'size',
    condition: 'size:<12 extension:.js',
    severity: 'error',
  });
}

function createBuildFixture(name, scriptBody) {
  const fixtureDir = path.join(repoDir, name);
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, 'package.json'),
    JSON.stringify({
      name,
      private: true,
      scripts: {
        build: 'node build.js',
      },
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(fixtureDir, 'build.js'), scriptBody, 'utf8');
  return fixtureDir;
}

function getStagedDiffSnapshot() {
  const diff = gitSync(['diff', '--cached'], { cwd: repoDir });
  const numstatLine = gitSync(['diff', '--cached', '--numstat'], { cwd: repoDir })
    .split(/\r?\n/)
    .find(Boolean);

  const [linesAddedRaw, linesRemovedRaw] = numstatLine.split(/\t/);
  return {
    diff,
    filesChanged: 1,
    linesAdded: Number(linesAddedRaw),
    linesRemoved: Number(linesRemovedRaw),
  };
}

beforeAll(() => {
  setupTestDbOnly('validation-index');
  rawDb().pragma('foreign_keys = OFF');
  taskCore = require('../db/task-core');
  fileTracking = require('../db/file/tracking');
  validationRules = require('../db/validation-rules');
  costTracking = require('../db/cost-tracking');
  validationModule = require('../handlers/validation');
  if (typeof validationRules.setGetTask === 'function') validationRules.setGetTask(taskCore.getTask);
  if (typeof fileTracking.setGetTask === 'function') fileTracking.setGetTask(taskCore.getTask);
  if (typeof costTracking.setGetTask === 'function') costTracking.setGetTask(taskCore.getTask);
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  resetTables(TABLES_TO_RESET);

  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-validation-'));
  gitSync(['init'], { cwd: repoDir });
  gitSync(['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  gitSync(['config', 'user.name', 'Test'], { cwd: repoDir });

  writeRepoFile('src/app.js', 'module.exports = 1;\n');
  gitSync(['add', '.'], { cwd: repoDir });
  gitSync(['commit', '-m', 'initial commit', '--no-gpg-sign'], { cwd: repoDir });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupRepo(repoDir);
  repoDir = null;
});

describe('validation handler index', () => {
  describe('handleSetupPrecommitHook', () => {
    it('installs the hook files with expected content in a git repo', () => {
      const result = validationModule.handleSetupPrecommitHook({
        working_directory: repoDir,
        checks: ['validation', 'syntax', 'build'],
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Pre-Commit Hook Installed');

      const hooksDir = path.join(repoDir, '.git', 'hooks');
      const configPath = path.join(hooksDir, 'pre-commit.config.json');
      const hookPath = path.join(hooksDir, 'pre-commit');

      expect(fs.existsSync(configPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
        checks: ['validation', 'syntax', 'build'],
      });
      expect(fs.existsSync(hookPath)).toBe(true);

      if (process.platform === 'win32') {
        const psHookPath = path.join(hooksDir, 'pre-commit.ps1');
        const shim = fs.readFileSync(hookPath, 'utf8');
        const psScript = fs.readFileSync(psHookPath, 'utf8');

        expect(fs.existsSync(psHookPath)).toBe(true);
        expect(shim).toContain('powershell.exe');
        expect(shim).toContain('pre-commit.ps1');
        expect(psScript).toContain('Running Torque pre-commit checks...');
        expect(psScript).toContain("$runBuild = $true");
      } else {
        const hookScript = fs.readFileSync(hookPath, 'utf8');
        expect(hookScript).toContain('# Torque pre-commit hook');
        expect(hookScript).toContain('# Checks: validation, syntax, build');
        expect(hookScript).toContain('npm run build --if-present');
      }
    });

    it('rejects directories that are not git repositories', () => {
      const plainDir = path.join(repoDir, 'plain-folder');
      fs.mkdirSync(plainDir, { recursive: true });

      const result = validationModule.handleSetupPrecommitHook({
        working_directory: plainDir,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('Not a git repository');
    });

    it('rejects missing working_directory parameter', () => {
      const result = validationModule.handleSetupPrecommitHook({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('working_directory is required');
    });

    it('rejects paths containing ".." traversal segments', () => {
      const result = validationModule.handleSetupPrecommitHook({
        working_directory: path.join(repoDir, '..', 'evil'),
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('must not contain ".." path segments');
    });

    it('uses default checks (validation, syntax) when no checks arg provided', () => {
      const result = validationModule.handleSetupPrecommitHook({
        working_directory: repoDir,
      });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Pre-Commit Hook Installed');
      expect(text).toContain('validation');
      expect(text).toContain('syntax');

      const configPath = path.join(repoDir, '.git', 'hooks', 'pre-commit.config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.checks).toEqual(['validation', 'syntax']);
    });

    it('filters out unknown check names, keeping only valid ones', () => {
      const result = validationModule.handleSetupPrecommitHook({
        working_directory: repoDir,
        checks: ['validation', 'bogus', 'build', 'unknown'],
      });

      expect(result.isError).toBeFalsy();
      const configPath = path.join(repoDir, '.git', 'hooks', 'pre-commit.config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.checks).toEqual(['validation', 'build']);
    });

    it('deduplicates repeated check names', () => {
      const result = validationModule.handleSetupPrecommitHook({
        working_directory: repoDir,
        checks: ['syntax', 'syntax', 'SYNTAX', 'build'],
      });

      expect(result.isError).toBeFalsy();
      const configPath = path.join(repoDir, '.git', 'hooks', 'pre-commit.config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.checks).toEqual(['syntax', 'build']);
    });
  });

  describe('handleValidateTaskOutput', () => {
    it('passes clean staged code', async () => {
      seedValidationRules();
      stageRepoFile('src/app.js', 'module.exports = 42;\n');
      const task = createTask();

      const result = await validationModule.handleValidateTaskOutput({ task_id: task.id });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Validation Passed');
      expect(getText(result)).toContain(task.id);
    });

    it('does not diff against HEAD~1 when the repo has no parent commit', async () => {
      seedValidationRules();
      stageRepoFile('src/app.js', 'module.exports = 42;\n');
      const task = createTask();
      const execSpy = vi.spyOn(childProcess, 'execFileSync');

      const result = await validationModule.handleValidateTaskOutput({ task_id: task.id });

      expect(result.isError).toBeFalsy();
      expect(execSpy.mock.calls.some((call) => (
        call[0] === 'git'
          && Array.isArray(call[1])
          && call[1][0] === 'diff'
          && call[1][2] === 'HEAD~1'
      ))).toBe(false);
    });

    it.each([
      {
        title: 'stub output',
        content: '// TODO: implement this\n',
        expectedRule: 'No TODO stubs',
      },
      {
        title: 'empty output',
        content: '',
        expectedRule: 'No empty files',
      },
      {
        title: 'truncated output',
        content: 'x=1\n',
        expectedRule: 'Minimum JS file size',
      },
    ])('fails validation for $title', async ({ content, expectedRule }) => {
      seedValidationRules();
      stageRepoFile('src/app.js', content);
      const task = createTask();

      const result = await validationModule.handleValidateTaskOutput({ task_id: task.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Validation Results');
      expect(text).toContain(expectedRule);
    });

    it('returns error when task_id is missing', async () => {
      const result = await validationModule.handleValidateTaskOutput({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id');
    });

    it('returns error when task_id is empty string', async () => {
      const result = await validationModule.handleValidateTaskOutput({ task_id: '' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND for non-existent task', async () => {
      const result = await validationModule.handleValidateTaskOutput({ task_id: 'non-existent-task-xyz' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('non-existent-task-xyz');
    });

    it('passes validation when task has no working_directory', async () => {
      seedValidationRules();
      const task = createTask({ working_directory: null });

      const result = await validationModule.handleValidateTaskOutput({ task_id: task.id });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Validation Passed');
    });

    it('passes validation when working_directory does not exist on disk', async () => {
      seedValidationRules();
      const nonExistentDir = path.join(os.tmpdir(), `torque-no-exist-${randomUUID()}`);
      const task = createTask({ working_directory: nonExistentDir });

      const result = await validationModule.handleValidateTaskOutput({ task_id: task.id });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Validation Passed');
    });

    it('detects committed changes via HEAD~1 diff path', async () => {
      seedValidationRules();
      // Create a second commit so HEAD~1 exists
      stageRepoFile('src/app.js', '// TODO: stub committed\n');
      gitSync(['commit', '-m', 'second commit with stub', '--no-gpg-sign'], { cwd: repoDir });
      const task = createTask();

      const result = await validationModule.handleValidateTaskOutput({ task_id: task.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Validation Results');
      expect(text).toContain('No TODO stubs');
    });

    it('reports multiple severity levels in grouped output', async () => {
      // Seed rules at different severity levels
      validationRules.saveValidationRule({
        id: 'rule-critical-console',
        name: 'No console.error',
        description: 'Critical: no console.error in production',
        rule_type: 'pattern',
        pattern: 'console\\.error',
        severity: 'critical',
      });
      validationRules.saveValidationRule({
        id: 'rule-warn-console-log',
        name: 'No console.log',
        description: 'Warning: no console.log',
        rule_type: 'pattern',
        pattern: 'console\\.log',
        severity: 'warning',
      });
      validationRules.saveValidationRule({
        id: 'rule-info-fixme',
        name: 'FIXME marker',
        description: 'Info: FIXME comments detected',
        rule_type: 'pattern',
        pattern: 'FIXME',
        severity: 'info',
      });

      stageRepoFile('src/app.js', [
        'console.error("critical failure");',
        'console.log("debug info");',
        '// FIXME: cleanup later',
        '',
      ].join('\n'));
      const task = createTask();

      const result = await validationModule.handleValidateTaskOutput({ task_id: task.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Validation Results');
      expect(text).toContain('Critical (1)');
      expect(text).toContain('No console.error');
      expect(text).toContain('Warnings (1)');
      expect(text).toContain('No console.log');
      expect(text).toContain('Info (1)');
      expect(text).toContain('FIXME marker');
    });

    it('validates multiple changed files independently', async () => {
      seedValidationRules();
      // One file is clean, one has a TODO stub
      stageRepoFile('src/app.js', 'module.exports = { valid: true };\n');
      stageRepoFile('src/helper.js', '// TODO: implement helper\nmodule.exports = {};\n');
      gitSync(['commit', '-m', 'multi-file commit', '--no-gpg-sign'], { cwd: repoDir });
      const task = createTask();

      const result = await validationModule.handleValidateTaskOutput({ task_id: task.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Validation Results');
      expect(text).toContain('No TODO stubs');
      // The violation should reference the helper file, not app.js
      expect(text).toContain('src/helper.js');
    });
  });

  describe('handlePreviewTaskDiff', () => {
    it('returns diff preview details for a simple staged change', () => {
      stageRepoFile('src/app.js', 'module.exports = 2;\n');
      const snapshot = getStagedDiffSnapshot();
      const task = createTask({ output: snapshot.diff });

      fileTracking.createDiffPreview(
        task.id,
        snapshot.diff,
        snapshot.filesChanged,
        snapshot.linesAdded,
        snapshot.linesRemoved,
      );

      const result = validationModule.handlePreviewTaskDiff({ task_id: task.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain(`## Diff Preview for ${task.id}`);
      expect(text).toContain('**Status:** pending');
      expect(text).toContain('**Files Changed:** 1');
      expect(text).toContain(`**Lines Added:** +${snapshot.linesAdded}`);
      expect(text).toContain(`**Lines Removed:** -${snapshot.linesRemoved}`);
      expect(text).toContain('src/app.js');
      expect(text).toContain('```diff');
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const result = validationModule.handlePreviewTaskDiff({ task_id: 'missing-task-id' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('returns error when task_id is missing', () => {
      const result = validationModule.handlePreviewTaskDiff({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('creates a diff preview from task.output when none exists', () => {
      const diffContent = '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n';
      const task = createTask({ output: diffContent });

      const result = validationModule.handlePreviewTaskDiff({ task_id: task.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain(`## Diff Preview for ${task.id}`);
      expect(text).toContain('```diff');
      expect(text).toContain(diffContent.trim());
    });

    it('uses "No diff available" message when task has no output and no prior preview', () => {
      const task = createTask({ output: null });

      const result = validationModule.handlePreviewTaskDiff({ task_id: task.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('No diff available');
    });
  });

  describe('handleRunBuildCheck', () => {
    it('reports success for a passing fixture', async () => {
      const fixtureDir = createBuildFixture('passing-fixture', "console.log('build ok');\n");

      const result = await validationModule.handleRunBuildCheck({
        task_id: 'build-pass',
        working_directory: fixtureDir,
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('✅ PASSED');
      expect(text).toContain('npm run build');
      expect(text).toContain('**Exit Code:** 0');
    });

    it('reports failure for a broken fixture', async () => {
      const fixtureDir = createBuildFixture(
        'broken-fixture',
        "console.error('intentional build failure');\nprocess.exit(1);\n",
      );

      const result = await validationModule.handleRunBuildCheck({
        task_id: 'build-fail',
        working_directory: fixtureDir,
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('❌ FAILED');
      expect(text).toContain('npm run build');
      expect(text).toContain('intentional build failure');
    });
  });

  describe('handleGetBudgetStatus', () => {
    it('returns structured budget status data with the expected shape', () => {
      costTracking.setBudget('validation-budget-global', 100, null, 'monthly', 80);
      costTracking.setBudget('validation-budget-provider', 25, 'codex', 'weekly', 70);

      const result = validationModule.handleGetBudgetStatus({});

      expect(result.isError).toBeFalsy();
      expect(result.structuredData).toEqual(expect.objectContaining({
        count: 2,
        budgets: expect.any(Array),
      }));
      expect(result.structuredData.budgets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'validation-budget-global',
          budget_usd: 100,
          period: 'monthly',
        }),
        expect.objectContaining({
          name: 'validation-budget-provider',
          provider: 'codex',
          period: 'weekly',
        }),
      ]));
    });
  });

  describe('createValidationHandlers', () => {
    it('uses an injected database dependency for validation result reads', () => {
      const fakeDb = {
        getValidationResults: vi.fn(() => [{
          severity: 'error',
          rule_name: 'Injected validation rule',
          details: 'read through fake db',
        }]),
      };

      const handlers = validationModule.createValidationHandlers({ db: fakeDb });
      const result = handlers.handleGetValidationResults({ task_id: 'task-from-fake-db' });
      const text = getText(result);

      expect(fakeDb.getValidationResults).toHaveBeenCalledWith('task-from-fake-db', 'warning');
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Injected validation rule');
      expect(text).toContain('read through fake db');
    });

    it('exercises validation handlers without requiring the database facade directly', () => {
      const originalLoad = Module._load;
      const blockedRequests = [];
      delete require.cache[require.resolve('../handlers/validation')];

      Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = parent?.filename ? parent.filename.replace(/\\/g, '/') : '';
        if (request === '../../database' && parentFile.endsWith('server/handlers/validation/index.js')) {
          blockedRequests.push(request);
          throw new Error('validation handler should not require database facade');
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      try {
        const loadedHandlers = require('../handlers/validation');
        const result = loadedHandlers.handleConfigureDiffPreview({ required: true });

        expect(typeof loadedHandlers.handleGetValidationResults).toBe('function');
        expect(result.isError).toBeFalsy();
        expect(getText(result)).toContain('Required:** Yes');
        expect(blockedRequests).toEqual([]);
      } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../handlers/validation')];
        validationModule = require('../handlers/validation');
      }
    });

    it('returns the same public handler interface as the module exports', () => {
      const handlers = validationModule.createValidationHandlers();
      const expectedKeys = Object.keys(validationModule)
        .filter((key) => key !== 'createValidationHandlers' && key !== 'init')
        .sort();

      expect(Object.keys(handlers).sort()).toEqual(expectedKeys);
      for (const key of expectedKeys) {
        expect(handlers[key]).toBe(validationModule[key]);
      }
    });
  });
});
