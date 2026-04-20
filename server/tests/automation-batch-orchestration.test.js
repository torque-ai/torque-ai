import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { gitSync } = require('./git-test-utils');

const handlers = require('../handlers/automation-batch-orchestration');
const automationHandlers = require('../handlers/automation-handlers');
const configCore = require('../db/config-core');
const schedulingAutomation = require('../db/scheduling-automation');
const taskCore = require('../db/task-core');
const fileTracking = require('../db/file-tracking');
const workflowEngine = require('../db/workflow-engine');
const projectConfigCore = require('../db/project-config-core');
const mockTaskManager = require('../task-manager');
const { ErrorCodes: _ErrorCodes } = require('../handlers/shared');
const { createConfigMock } = require('./test-helpers');

function setDbDefaults() {
  vi.spyOn(configCore, 'getConfig').mockImplementation(createConfigMock());
  vi.spyOn(configCore, 'setConfig').mockImplementation(() => undefined);
  vi.spyOn(schedulingAutomation, 'listScheduledTasks').mockReturnValue([]);
  vi.spyOn(schedulingAutomation, 'createCronScheduledTask').mockImplementation((name) => ({ id: 'sched-1', name }));
  vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
  vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([]);
  vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([]);
  vi.spyOn(taskCore, 'listTasks').mockReturnValue({ tasks: [], pagination: {} });
  vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);
  vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue(null);
  vi.spyOn(projectConfigCore, 'getProjectFromPath').mockReturnValue('project-1');
  vi.spyOn(projectConfigCore, 'getProjectMetadata').mockReturnValue(null);
  vi.spyOn(taskCore, 'createTask').mockImplementation((task) => ({ ...task, id: task.id }));

  vi.spyOn(mockTaskManager, 'startTask').mockImplementation(() => undefined);
}

const tempRoots = [];

function createTempDir(prefix = 'torque-batch-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function extractJsonBlock(text) {
  const match = text.match(/```json\n([\s\S]+?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function createFeatureFixture(workingDir) {
  const srcDir = path.join(workingDir, 'src');
  const typesDir = path.join(srcDir, 'types');
  const systemsDir = path.join(srcDir, 'systems');
  const dataDir = path.join(srcDir, 'data');
  const testsDir = path.join(systemsDir, '__tests__');

  [typesDir, systemsDir, dataDir, testsDir].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });

  fs.writeFileSync(
    path.join(systemsDir, 'IntegrationContracts.ts'),
    `export interface AppMessages {
  app_started: {
    userId: string;
  };
  order_completed: {
    orderId: string;
  };
}
`
  );

  fs.writeFileSync(
    path.join(systemsDir, 'SampleBridge.ts'),
    `export type NotificationEvent = 'order_completed' | 'order_canceled';`
  );

  fs.writeFileSync(
    path.join(systemsDir, 'SampleSystem.ts'),
    `export class SampleSystem { }`
  );

  fs.writeFileSync(
    path.join(typesDir, 'order-flow.ts'),
    `export interface OrderFlowEntity { id: string; }`
  );

  fs.writeFileSync(
    path.join(dataDir, 'order-flows.ts'),
    `export const seed = []`
  );

  fs.writeFileSync(
    path.join(testsDir, 'sample-system.test.ts'),
    `import { describe, it, expect } from 'vitest';`
  );
}


function createJsSource(workingDir, relativePath, lines = 24) {
  const fullPath = path.join(workingDir, 'src', relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const content = Array.from({ length: lines }).map((_, i) => `export const value${i} = ${i};`).join('\n');
  fs.writeFileSync(fullPath, content);
  return path.relative(workingDir, fullPath).replace(/\\/g, '/');
}

function initGitRepo(workingDir) {
  gitSync(['init'], { cwd: workingDir });
  gitSync(['config', 'user.name', 'Test User'], { cwd: workingDir });
  gitSync(['config', 'user.email', 'test@example.com'], { cwd: workingDir });
}

function commitAll(workingDir, message = 'init') {
  gitSync(['add', '--all'], { cwd: workingDir });
  gitSync(['commit', '-m', message, '--no-gpg-sign'], { cwd: workingDir });
}

function isUnderGitDirectory(testDir) {
  let cursor = path.resolve(testDir);
  while (cursor) {
    if (fs.existsSync(path.join(cursor, '.git'))) {
      return true;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return false;
}

function createNonGitDir() {
  // Try os.tmpdir() first (always writable), then filesystem root as fallback
  const candidates = [os.tmpdir(), path.parse(process.cwd()).root];
  for (const base of candidates) {
    let nonGit;
    try {
      nonGit = fs.mkdtempSync(path.join(base, 'torque-non-git-'));
    } catch {
      continue; // base not writable (e.g., filesystem root on Linux CI)
    }
    if (!isUnderGitDirectory(nonGit)) {
      tempRoots.push(nonGit);
      return nonGit;
    }
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
  throw new Error('Unable to create non-git directory in current environment');
}

describe('automation-batch-orchestration handlers', () => {
  beforeEach(() => {
    setDbDefaults();
  });

  afterEach(() => {
    cleanupTempDirs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('handleGenerateFeatureTasks', () => {
    it('returns error when working_directory is missing', () => {
      const result = handlers.handleGenerateFeatureTasks({});
      expect(result.content[0].text).toMatch(/working_directory/i);
      expect(result.isError).toBe(true);
    });

    it('returns error when feature_name is missing', () => {
      const result = handlers.handleGenerateFeatureTasks({ working_directory: '/tmp' });
      expect(result.content[0].text).toMatch(/feature_name/i);
      expect(result.isError).toBe(true);
    });

    it('generates five task descriptions for a valid feature with reference project files', () => {
      const workingDir = createTempDir();
      createFeatureFixture(workingDir);

      const result = handlers.handleGenerateFeatureTasks({
        working_directory: workingDir,
        feature_name: 'OrderFlow',
        feature_description: 'Track and score customer orders',
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;

      expect(result._tasks).toBeDefined();
      expect(text).toContain('Generated Task Descriptions: OrderFlow');
      expect(text).toContain('#### types');
      expect(text).toContain('#### events');
      expect(text).toContain('#### data');
      expect(text).toContain('#### system');
      expect(text).toContain('#### tests');

      const sections = Object.keys(result._tasks);
      expect(sections).toEqual(expect.arrayContaining([
        'types',
        'events',
        'data',
        'system',
        'tests',
      ]));
      expect(sections).not.toContain('wire');
      expect((text.match(/#### /g) || []).length).toBe(5);
      for (const section of sections) {
        expect(typeof result._tasks[section]).toBe('string');
        expect(result._tasks[section].trim().length).toBeGreaterThan(0);
      }

      expect(result._tasks.types).toContain('Track and score customer orders');
      expect(result._tasks.system).toContain('Implement the runtime behavior for the OrderFlow feature');
      expect(result._tasks.events).toContain('Define or update integration events');
      expect(result._tasks.events).toContain('contracts needed for this feature');
    });

    it('generates non-empty task descriptions with no optional reference files', () => {
      const workingDir = createTempDir();
      // Keep only required structure to verify fallback behavior
      fs.mkdirSync(path.join(workingDir, 'src', 'types'), { recursive: true });

      const result = handlers.handleGenerateFeatureTasks({
        working_directory: workingDir,
        feature_name: 'QuickShip',
        feature_description: 'Minimal feature fixture',
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;

      expect(text).toContain('Generated Task Descriptions: QuickShip');
      expect(result._tasks.types).toContain('QuickShip');
      expect(result._tasks.events).toContain('closest equivalent integration point');
      expect(result._tasks.system).toContain('Implement the runtime behavior for the QuickShip feature');
      expect(result._tasks.tests).toContain('Add or update tests for the QuickShip feature');
    });
  });


  describe('handleDetectFileConflicts', () => {
    it('returns error when workflow_id is missing', () => {
      const result = handlers.handleDetectFileConflicts({});
      expect(result.content[0].text).toMatch(/workflow_id/i);
      expect(result.isError).toBe(true);
    });

  it('returns error when workflow is missing', () => {
      const result = handlers.handleDetectFileConflicts({ workflow_id: 'missing-workflow' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/i);
    });

    it('detects conflicts when completed tasks touch same file', () => {
      const workingDir = createTempDir();
      const workflowId = 'workflow-conflict-1';

      workflowEngine.getWorkflow.mockReturnValue({
        id: workflowId,
        working_directory: workingDir,
      });

      workflowEngine.getWorkflowStatus.mockReturnValue({
        name: 'Feature Workflow',
        tasks: {
          t1: {
            id: 'task-11111111',
            status: 'completed',
            node_id: 'order-system',
          },
          t2: {
            id: 'task-22222222',
            status: 'completed',
            node_id: 'wire-step',
          },
        },
      });

      taskCore.getTask.mockImplementation((id) => {
        if (id === 'task-11111111') {
          return { files_modified: JSON.stringify(['src/systems/Shared.ts']) };
        }
        if (id === 'task-22222222') {
          return { files_modified: JSON.stringify([{ path: 'src/systems/Shared.ts' }]) };
        }
        return null;
      });

      const result = handlers.handleDetectFileConflicts({ workflow_id: workflowId });
      const text = result.content[0].text;

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Potential Conflict');
      expect(text).toContain('src/systems/Shared.ts');
      expect(text).toContain('order-system');
      expect(text).toContain('wire-step');
    });

    it('reports no conflicts when completed tasks modify disjoint files', () => {
      const workingDir = createTempDir();
      const workflowId = 'workflow-clean-1';

      workflowEngine.getWorkflow.mockReturnValue({
        id: workflowId,
        working_directory: workingDir,
      });

      workflowEngine.getWorkflowStatus.mockReturnValue({
        name: 'Feature Workflow',
        tasks: {
          t1: {
            id: 'task-11111111',
            status: 'completed',
            node_id: 'task-a',
          },
          t2: {
            id: 'task-22222222',
            status: 'pending',
            node_id: 'task-b',
          },
          t3: {
            id: 'task-33333333',
            status: 'completed',
            node_id: 'task-c',
          },
        },
      });

      taskCore.getTask.mockImplementation((id) => {
        if (id === 'task-11111111') {
          return { files_modified: JSON.stringify(['src/systems/Flow.ts']) };
        }
        if (id === 'task-33333333') {
          return { files_modified: JSON.stringify(['src/systems/Order.ts']) };
        }
        return null;
      });

      const result = handlers.handleDetectFileConflicts({ workflow_id: workflowId });
      const text = result.content[0].text;

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Result: No Conflicts');
      expect(text).toContain('Task | Files');
      expect(text).toContain('No files were modified by multiple tasks');
    });

    it('includes completed-task file summary even with conflicts', () => {
      const workingDir = createTempDir();
      const workflowId = 'workflow-summary-1';

      workflowEngine.getWorkflow.mockReturnValue({
        id: workflowId,
        working_directory: workingDir,
      });

      workflowEngine.getWorkflowStatus.mockReturnValue({
        name: 'Feature Workflow',
        tasks: {
          t1: { id: 'task-aaaa1111', status: 'completed', node_id: 'node-a' },
          t2: { id: 'task-bbbb2222', status: 'completed', node_id: 'node-b' },
        },
      });

      taskCore.getTask.mockReturnValue({ files_modified: JSON.stringify(['src/data/shared.ts']) });

      const result = handlers.handleDetectFileConflicts({ workflow_id: workflowId });
      const text = result.content[0].text;

      expect(text).toContain('node-a');
      expect(text).toContain('node-b');
    });
  });

  describe('handleAutoCommitBatch', () => {
    it('returns error when working_directory is missing', async () => {
      const result = await handlers.handleAutoCommitBatch({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/working_directory/i);
    });

    it('rejects path traversal stage paths', async () => {
      const workingDir = createTempDir();
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workingDir, 'src', 'safe.ts'), 'export const safe = true;');

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        verify: false,
        push: false,
        stage_paths: ['../../etc/passwd'],
        test_count_command: 'node --version',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(result.content[0].text).toContain('Invalid stage path: ../../etc/passwd');
    });

    it('rejects absolute paths outside working_directory for stage_paths', async () => {
      const workingDir = createTempDir();
      // Create outsidePath under os.tmpdir() to avoid permission issues on CI
      const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-autocommit-root-'));
      tempRoots.push(outsidePath);
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workingDir, 'src', 'safe.ts'), 'export const safe = true;');

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        verify: false,
        push: false,
        stage_paths: [outsidePath],
        test_count_command: 'node --version',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(result.content[0].text).toContain(`Invalid stage path: ${outsidePath}`);
    });

    it('rejects non-git working_directory', async () => {
      const workingDir = createNonGitDir();
      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        verify: false,
        push: false,
        test_count_command: 'node --version',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/git/i);
    });

    it('truncates commit messages over 4096 characters', async () => {
      const workingDir = createTempDir();
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      const filePath = path.join(workingDir, 'src', 'long-message-test.ts');
      fs.writeFileSync(filePath, 'export const x = 1;');
      commitAll(workingDir);
      fs.writeFileSync(filePath, 'export const x = 2;');

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        verify: false,
        push: false,
        commit_message: 'a'.repeat(5000),
        test_count_command: 'node --version',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Warning: commit_message exceeded 4096 characters and was truncated.');
      expect(result.content[0].text).toContain(`Committed: "${'a'.repeat(4096)}"`);
    });

    it('commits only task-tracked files and leaves unrelated changes uncommitted', async () => {
      const workingDir = createTempDir();
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      const intendedPath = path.join(workingDir, 'src', 'intended.ts');
      const unrelatedPath = path.join(workingDir, 'src', 'unrelated.ts');
      fs.writeFileSync(intendedPath, 'export const intended = 1;');
      fs.writeFileSync(unrelatedPath, 'export const unrelated = 1;');
      commitAll(workingDir);

      fs.writeFileSync(intendedPath, 'export const intended = 2;');
      fs.writeFileSync(unrelatedPath, 'export const unrelated = 2;');
      fileTracking.getTaskFileChanges.mockImplementation((taskId) => (
        taskId === 'task-commit-1'
          ? [{ relative_path: 'src/intended.ts', is_outside_workdir: 0 }]
          : []
      ));
      taskCore.getTask.mockReturnValue({ files_modified: [] });

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        batch_name: 'scoped-batch',
        verify: false,
        push: false,
        task_id: 'task-commit-1',
        commit_message: 'feat: scoped batch commit',
        test_count_command: 'node --version',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Committed: "feat: scoped batch commit"');

      const committedFiles = gitSync(['show', '--pretty=', '--name-only', 'HEAD'], {
        cwd: workingDir,
      }).split(/\r?\n/).filter(Boolean);
      expect(committedFiles).toContain('src/intended.ts');
      expect(committedFiles).not.toContain('src/unrelated.ts');

      const statusOutput = gitSync(['status', '--porcelain'], {
        cwd: workingDir,
      });
      expect(statusOutput).toContain('src/unrelated.ts');
      expect(statusOutput).not.toContain('src/intended.ts');
    });

    it('does not push by default after committing tracked changes', async () => {
      const workingDir = createTempDir();
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      const filePath = path.join(workingDir, 'src', 'no-push.ts');
      fs.writeFileSync(filePath, 'export const value = 1;');
      commitAll(workingDir);
      fs.writeFileSync(filePath, 'export const value = 2;');

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        batch_name: 'default-no-push',
        verify: false,
        commit_message: 'feat: commit without push',
        test_count_command: 'node --version',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Committed: "feat: commit without push"');
      expect(result.content[0].text).toContain('- **Pushed:** No');
      expect(result.content[0].text).not.toContain('### Step 4: Push');
    });
  });


  describe('handleGenerateTestTasks', () => {
    it('returns error when working_directory is missing', () => {
      const result = automationHandlers.handleGenerateTestTasks({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/working_directory/i);
    });

    it('generates test task descriptions for untested js files', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/order-service.js', 24);
      createJsSource(workingDir, 'core/validation.js', 30);
      createJsSource(workingDir, 'core/format.js', 32);

      const result = automationHandlers.handleGenerateTestTasks({ working_directory: workingDir });
      const json = extractJsonBlock(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(json).toBeInstanceOf(Array);
      expect(json.length).toBe(3);
      expect(json[0]).toMatchObject({ node_id: expect.any(String), task: expect.any(String) });
      expect(json[0].task).toContain('Create ');
      expect(json[1].task).toContain('test');
    });

    it('respects source file exclusion by line count', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/tiny.js', 3);
      createJsSource(workingDir, 'core/large.js', 30);

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        min_lines: 20,
      });
      const json = extractJsonBlock(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(json).toBeInstanceOf(Array);
      expect(json.length).toBe(1);
      expect(json[0].task).toContain('large');
    });

    it('respects requested count limit', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/alpha.js', 30);
      createJsSource(workingDir, 'core/beta.js', 30);
      createJsSource(workingDir, 'core/gamma.js', 30);

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        count: 2,
      });
      const json = extractJsonBlock(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(json).toBeInstanceOf(Array);
      expect(json.length).toBe(2);
      expect(json[0].node_id).not.toBe(json[1].node_id);
    });

    it('auto-submits test tasks and starts task manager when requested', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/submit-me.js', 25);

      taskCore.createTask.mockImplementation((task) => ({ ...task, id: 'test-task-1' }));
      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        auto_submit: true,
        count: 1,
        provider: 'codex',
      });

      expect(result.isError).toBeFalsy();
      expect(taskCore.createTask).toHaveBeenCalled();
      expect(mockTaskManager.startTask).toHaveBeenCalled();
      const startedTaskId = mockTaskManager.startTask.mock.calls[0]?.[0];
      expect(startedTaskId).toBe('test-task-1');
      expect(result.content[0].text).toContain('submitted');
      expect(result.content[0].text).toContain('`test-tas`');
    });

    it('does not include duplicate tasks when matching test files exist', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/existing.js', 40);
      createJsSource(workingDir, 'core/only-source.js', 40);

      // Matching test for existing.js
      fs.mkdirSync(path.join(workingDir, 'src', 'core', '__tests__'), { recursive: true });
      fs.writeFileSync(path.join(workingDir, 'src', 'core', '__tests__', 'existing.test.ts'), 'export {}');

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        source_dirs: ['src'],
        count: 5,
      });
      const json = extractJsonBlock(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(json).toBeInstanceOf(Array);
      expect(json).toHaveLength(1);
      expect(json[0].node_id).toContain('only-source');
      expect(json[0].testPath).toBeUndefined();
    });

    it('extends an existing related test file outside __tests__ instead of creating a new one', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'handlers/task-pipeline.js', 40);

      fs.mkdirSync(path.join(workingDir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(workingDir, 'tests', 'handler-task-pipeline.test.js'), 'export {};');

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        source_dirs: ['src/handlers', 'tests'],
        test_pattern: '.test.js',
        count: 5,
      });
      const text = result.content[0].text;

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Extend the existing test file tests/handler-task-pipeline.test.js');
      expect(text).not.toContain('Create tests/handler-task-pipeline.test.js');
    });

    it('returns ready-to-use json when auto_submit is false', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/manual-review.js', 40);

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        auto_submit: false,
      });
      const text = result.content[0].text;

      expect(text).toContain('Generated Task Descriptions');
      expect(text).toContain('Use these with `add_workflow_task` or `submit_task`:');
      expect(text).toMatch(/```json/);
      expect(text).toContain('manual-review');
    });
  });


  describe('handleRunBatch', () => {
    it('returns error when working_directory is missing', async () => {
      const result = await handlers.handleRunBatch({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/working_directory/i);
    });

    it('returns error when feature_name is missing', async () => {
      const result = await handlers.handleRunBatch({ working_directory: '/tmp' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/feature_name/i);
    });
  });

});
