import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const vitestSetup = require('./vitest-setup');
const validationHandlers = require('../handlers/validation');
const advIntelligence = require('../handlers/advanced/intelligence');
const postToolHooks = require('../hooks/post-tool-hooks');
const taskManager = require('../task-manager');
const taskCore = require('../db/task-core');
const fileTracking = require('../db/file-tracking');
const validationRules = require('../db/validation-rules');

const { setupTestDb, teardownTestDb, safeTool } = vitestSetup;

function createTask(overrides = {}) {
  return taskCore.createTask({
    id: randomUUID(),
    task_description: overrides.task_description || 'post-tool hook test task',
    working_directory: overrides.working_directory || testDir,
    provider: overrides.provider || 'codex',
    status: overrides.status || 'queued',
    ...overrides,
  });
}

let db;
let testDir;

describe('post-tool hooks', () => {
  beforeEach(() => {
    ({ db, testDir } = setupTestDb('post-tool-hooks'));
    postToolHooks.resetHooksForTest();
    taskManager._testing.resetForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    postToolHooks.resetHooksForTest();
    teardownTestDb();
  });

  it('lists built-in hooks and supports remove/register via MCP tools', async () => {
    const initialList = await safeTool('list_hooks', {});
    expect(initialList.hooks.map((hook) => hook.id)).toEqual(expect.arrayContaining([
      'file_write:syntax_check',
      'task_complete:validate_task_output',
      'task_fail:learn_failure_pattern',
    ]));

    const removeResult = await safeTool('remove_hook', { hook_id: 'file_write:syntax_check' });
    expect(removeResult.hook.id).toBe('file_write:syntax_check');

    const afterRemove = await safeTool('list_hooks', { event_type: 'file_write' });
    expect(afterRemove.hooks).toEqual([]);

    const registerResult = await safeTool('register_hook', {
      event_type: 'file_write',
      hook_name: 'syntax_check',
    });
    expect(registerResult.hook.id).toBe('file_write:syntax_check');

    const afterRegister = await safeTool('list_hooks', { event_type: 'file_write' });
    expect(afterRegister.hooks.map((hook) => hook.id)).toEqual(['file_write:syntax_check']);
  });

  it('fires the built-in callbacks for each supported event type', async () => {
    const syntaxSpy = vi.spyOn(validationHandlers, 'handleRunSyntaxCheck').mockResolvedValue({
      content: [{ type: 'text', text: 'syntax ok' }],
    });
    const validationSpy = vi.spyOn(validationHandlers, 'handleValidateTaskOutput').mockReturnValue({
      content: [{ type: 'text', text: 'validation ok' }],
    });
    const failureSpy = vi.spyOn(advIntelligence, 'handleLearnFailurePattern').mockReturnValue({
      content: [{ type: 'text', text: 'failure learned' }],
    });

    await postToolHooks.fireHook('file_write', {
      file_path: path.join(testDir, 'sample.ts'),
      working_directory: testDir,
    });
    await postToolHooks.fireHook('task_complete', { taskId: 'task-complete-1' });
    await postToolHooks.fireHook('task_fail', { taskId: 'task-fail-1', error: 'boom' });

    expect(syntaxSpy).toHaveBeenCalledWith({
      file_path: path.join(testDir, 'sample.ts'),
      working_directory: testDir,
    });
    expect(validationSpy).toHaveBeenCalledWith({ task_id: 'task-complete-1' });
    expect(failureSpy).toHaveBeenCalledWith(expect.objectContaining({
      task_id: 'task-fail-1',
      name: 'auto_failure_task-fai',
    }));
  });

  it('fires file_write hooks after mutating file tools run', async () => {
    const targetFile = path.join(testDir, 'sample.ts');
    fs.writeFileSync(targetFile, 'const value = 1;\n', 'utf8');

    const syntaxSpy = vi.spyOn(validationHandlers, 'handleRunSyntaxCheck').mockResolvedValue({
      content: [{ type: 'text', text: 'syntax ok' }],
    });

    const result = await safeTool('add_import_statement', {
      file_path: targetFile,
      import_statement: 'import fs from "fs";',
    });

    expect(result.isError).not.toBe(true);
    expect(fs.readFileSync(targetFile, 'utf8')).toContain('import fs from "fs";');
    expect(syntaxSpy).toHaveBeenCalledWith({
      file_path: targetFile,
      working_directory: testDir,
    });
  });

  it('reports approval-gate failures for empty output, validation failures, and destructive shrink', async () => {
    const task = createTask({
      task_description: 'approval gate task',
      status: 'queued',
    });
    taskCore.updateTaskStatus(task.id, 'completed', { output: '   ' });

    const trackedFile = path.join(testDir, 'gate.js');
    fs.writeFileSync(
      trackedFile,
      'const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst delta = 4;\n',
      'utf8'
    );
    fileTracking.captureFileBaseline('gate.js', testDir, task.id);

    fs.writeFileSync(trackedFile, 'const alpha = 1;\n', 'utf8');
    fileTracking.recordFileChange(task.id, trackedFile, 'modified', {
      workingDirectory: testDir,
      fileSizeBytes: fs.statSync(trackedFile).size,
    });
    validationRules.saveValidationRule({
      id: 'rule-1',
      name: 'No TODOs',
      description: 'Reject TODO markers',
      rule_type: 'pattern',
      pattern: 'TODO',
      severity: 'error',
    });
    validationRules.recordValidationResult(task.id, 'rule-1', 'No TODOs', 'fail', 'error', 'TODO marker found', 'gate.js', null);

    const result = await safeTool('check_approval_gate', { task_id: task.id });

    expect(result.approved).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'Task output is empty',
      'Validation failure: No TODOs (gate.js)',
      expect.stringContaining('gate.js shrank by'),
    ]));
  });

  it('fires terminal task hooks from handlePostCompletion', () => {
    const fireSpy = vi.spyOn(postToolHooks, 'fireHook').mockResolvedValue([]);

    const completedTask = createTask({
      task_description: 'completed task',
      status: 'queued',
    });
    taskCore.updateTaskStatus(completedTask.id, 'completed', { output: 'done' });

    const failedTask = createTask({
      task_description: 'failed task',
      status: 'queued',
    });
    taskCore.updateTaskStatus(failedTask.id, 'failed', { error_output: 'boom' });

    taskManager.handlePostCompletion({
      taskId: completedTask.id,
      code: 0,
      status: 'completed',
      task: taskCore.getTask(completedTask.id),
      output: 'done',
      errorOutput: '',
      proc: { output: 'done', errorOutput: '' },
    });

    taskManager.handlePostCompletion({
      taskId: failedTask.id,
      code: 1,
      status: 'failed',
      task: taskCore.getTask(failedTask.id),
      output: '',
      errorOutput: 'boom',
      proc: { output: '', errorOutput: 'boom' },
    });

    expect(fireSpy).toHaveBeenCalledWith('task_complete', expect.objectContaining({
      taskId: completedTask.id,
      exitCode: 0,
      output: 'done',
    }));
    expect(fireSpy).toHaveBeenCalledWith('task_fail', expect.objectContaining({
      taskId: failedTask.id,
      error: 'boom',
    }));
  });
});
