import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { mocks } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return {
    mocks: {
      taskEvents: new EventEmitter(),
      executeValidatedCommandSync: vi.fn(),
      safeExecChain: vi.fn(),
      handlePeekUi: vi.fn(),
      appendRollbackReport: vi.fn((message, result) => (
        result?.report ? `${message}\n${result.report}` : message
      )),
      rollbackAgenticTaskChanges: vi.fn(() => ({ attempted: false, reverted: [], kept: [], report: '' })),
    },
  };
});

const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const serverConfig = require('../config');
const taskCore = require('../db/task-core');
const workflowEngine = require('../db/workflow-engine');
const taskMetadata = require('../db/task-metadata');
const fileTracking = require('../db/file-tracking');
const hostMonitoring = require('../utils/host-monitoring');
let handlers;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

function isVerifyExecutor(command) {
  return typeof command === 'string'
    && (
      command === 'torque-remote'
      || command === 'cmd'
      || command === 'sh'
      || /(?:^|[\\/])bash(?:\.exe)?$/i.test(command)
    );
}

function createWorkflow(overrides = {}) {
  const id = overrides.id || randomUUID();
  return workflowEngine.createWorkflow({
    id,
    name: 'Workflow Await Test',
    status: 'running',
    context: {},
    working_directory: process.cwd(),
    ...overrides,
  });
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  taskCore.createTask({
    id,
    task_description: 'Await task test',
    provider: 'codex',
    model: 'gpt-5',
    status: 'pending',
    working_directory: process.cwd(),
    ...overrides,
  });
  return id;
}

function finalizeTask(taskId, status = 'completed', overrides = {}) {
  const task = taskCore.getTask(taskId);
  if (!task) return;

  if (task.status === 'blocked') {
    taskCore.updateTaskStatus(taskId, 'pending');
  }

  const current = taskCore.getTask(taskId);
  if (current && ['pending', 'queued'].includes(current.status)) {
    taskCore.updateTaskStatus(taskId, 'running', {
      started_at: overrides.started_at || '2026-01-01T00:00:00.000Z',
    });
  }

  const extraFields = { ...overrides };
  delete extraFields.output;
  delete extraFields.error_output;
  delete extraFields.exit_code;
  delete extraFields.completed_at;
  delete extraFields.files_modified;

  taskCore.updateTaskStatus(taskId, status, {
    output: overrides.output ?? (status === 'completed' ? 'task output' : ''),
    error_output: overrides.error_output ?? (status === 'failed' ? 'task failed' : null),
    exit_code: overrides.exit_code
      ?? (status === 'completed' ? 0 : ['cancelled', 'skipped'].includes(status) ? null : 1),
    completed_at: overrides.completed_at || '2026-01-01T00:00:05.000Z',
    files_modified: overrides.files_modified ?? null,
    ...extraFields,
  });
}

function createWorkflowTask(workflowId, nodeId, overrides = {}) {
  return createTask({
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    task_description: `${nodeId} task`,
    ...overrides,
  });
}

function storePeekArtifact(taskId, name, contractVersion = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-peek-artifact-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, '{}', 'utf8');
  return taskMetadata.storeArtifact({
    id: randomUUID(),
    task_id: taskId,
    name,
    file_path: filePath,
    mime_type: 'application/json',
    size_bytes: 2,
    checksum: `sha-${name}`,
    metadata: {
      source: 'peek_diagnose',
      kind: name === 'bundle.json' ? 'bundle_json' : 'artifact_report',
      contract: { name: 'peek_investigation_bundle', version: contractVersion },
    },
  });
}

describe('workflow-await handlers with DB-backed state', () => {
  beforeEach(() => {
    setupTestDbOnly(`workflow-await-${Date.now()}`);
    installCjsModuleMock('../hooks/event-dispatch', { taskEvents: mocks.taskEvents });
    installCjsModuleMock('../execution/command-policy', {
      executeValidatedCommandSync: mocks.executeValidatedCommandSync,
    });
    installCjsModuleMock('../utils/safe-exec', {
      safeExecChain: mocks.safeExecChain,
    });
    installCjsModuleMock('../plugins/snapscope/handlers/capture', {
      handlePeekUi: mocks.handlePeekUi,
    });
    installCjsModuleMock('../execution/agentic-orphan-rollback', {
      appendRollbackReport: mocks.appendRollbackReport,
      rollbackAgenticTaskChanges: mocks.rollbackAgenticTaskChanges,
    });
    mocks.executeValidatedCommandSync.mockReset();
    mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
      if (command === 'git' && args[0] === 'rev-parse') return 'abc123\n';
      if (command === 'git' && args[0] === 'diff') return '';
      return '';
    });
    mocks.safeExecChain.mockReset();
    mocks.safeExecChain.mockReturnValue({ exitCode: 0, output: 'verify ok' });
    mocks.handlePeekUi.mockReset();
    mocks.handlePeekUi.mockResolvedValue({ content: [] });
    mocks.appendRollbackReport.mockReset();
    mocks.appendRollbackReport.mockImplementation((message, result) => (
      result?.report ? `${message}\n${result.report}` : message
    ));
    mocks.rollbackAgenticTaskChanges.mockReset();
    mocks.rollbackAgenticTaskChanges.mockReturnValue({ attempted: false, reverted: [], kept: [], report: '' });
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    handlers = loadFresh('../handlers/workflow/await');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.executeValidatedCommandSync.mockReset();
    mocks.safeExecChain.mockReset();
    mocks.handlePeekUi.mockReset();
    mocks.appendRollbackReport.mockReset();
    mocks.rollbackAgenticTaskChanges.mockReset();
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    serverConfig.setEpoch(0);
    vi.useRealTimers();
    teardownTestDb();
  });

  describe('handleAwaitTask', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', async () => {
      const result = await handlers.handleAwaitTask({ task_id: randomUUID() });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(textOf(result)).toContain('Task not found');
    });

    it('returns immediately for an already-completed task', async () => {
      const taskId = createTask();
      finalizeTask(taskId, 'completed', {
        output: 'already done',
        files_modified: ['src/ready.js'],
      });

      const result = await handlers.handleAwaitTask({
        task_id: taskId,
        verify_command: 'npx vitest run',
        auto_commit: true,
      });

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('already done');
      expect(textOf(result)).not.toContain('Verify Command');
      expect(textOf(result)).not.toContain('Auto-Commit');
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('includes persisted Peek bundle artifacts in await_task output', async () => {
      const taskId = createTask();
      finalizeTask(taskId, 'completed', {
        output: 'diagnose complete',
      });
      const bundleArtifact = storePeekArtifact(taskId, 'bundle.json');

      const result = await handlers.handleAwaitTask({
        task_id: taskId,
      });

      expect(textOf(result)).toContain('### Bundle Artifacts');
      expect(textOf(result)).toContain(`bundle.json: ${bundleArtifact.file_path}`);
    });

    it('returns immediately for an already-cancelled task', async () => {
      const taskId = createTask();
      finalizeTask(taskId, 'cancelled');

      const result = await handlers.handleAwaitTask({ task_id: taskId });

      expect(textOf(result)).toContain('Task Finished');
      expect(textOf(result)).toContain('Status:** cancelled');
    });

    it('returns restart recovery guidance for restart-cancelled tasks', async () => {
      const taskId = createTask();
      finalizeTask(taskId, 'cancelled', {
        cancel_reason: 'server_restart',
        output: 'partial progress before shutdown',
      });

      const result = await handlers.handleAwaitTask({ task_id: taskId });

      expect(textOf(result)).toContain('Task Cancelled by Server Restart');
      expect(textOf(result)).toContain('Cancel Reason:** server_restart');
      expect(textOf(result)).toContain('partial progress before shutdown');
      expect(textOf(result)).toContain('auto_resubmit_on_restart: true');
    });

    it('auto-resubmits restart-cancelled tasks and waits on the replacement task', async () => {
      const taskId = createTask();
      finalizeTask(taskId, 'cancelled', {
        cancel_reason: 'server_restart',
        output: 'partial progress before shutdown',
      });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        auto_resubmit_on_restart: true,
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      const originalTask = taskCore.getTask(taskId);
      const replacementId = originalTask.metadata.resubmitted_as;
      const replacementTask = taskCore.getTask(replacementId);

      expect(replacementId).toBeTruthy();
      expect(replacementTask).toMatchObject({
        status: 'queued',
        workflow_id: null,
        workflow_node_id: null,
      });
      expect(replacementTask.task_description.startsWith('## Previous Attempt (failed)')).toBe(true);
      expect(replacementTask.task_description).toContain(originalTask.task_description);
      expect(replacementTask.metadata.resubmitted_from).toBe(taskId);
      expect(replacementTask.metadata.restart_resubmit_count).toBe(1);

      finalizeTask(replacementId, 'completed', {
        output: 'replacement task completed',
      });
      mocks.taskEvents.emit('task:completed', replacementId);

      const result = await promise;

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('replacement task completed');
    });

    it('marks stale running tasks as orphaned when the server epoch advances', async () => {
      serverConfig.setEpoch(1);
      const taskId = createTask({ status: 'running', max_retries: 0 });
      taskCore.updateTask(taskId, { output: 'partial orphaned output' });
      serverConfig.setEpoch(2);
      mocks.rollbackAgenticTaskChanges.mockReturnValue({
        attempted: true,
        reverted: ['src/partial.js'],
        kept: [],
        report: 'Reverted 1 interrupted task change: src/partial.js',
      });

      const result = await handlers.handleAwaitTask({ task_id: taskId });
      const updatedTask = taskCore.getTask(taskId);

      expect(updatedTask.status).toBe('cancelled');
      expect(updatedTask.cancel_reason).toBe('orphan_cleanup');
      expect(updatedTask.error_output).toContain('Reverted 1 interrupted task change: src/partial.js');
      expect(mocks.rollbackAgenticTaskChanges).toHaveBeenCalledWith(
        expect.objectContaining({ id: taskId }),
        expect.objectContaining({ logger: expect.any(Object) })
      );
      expect(textOf(result)).toContain('Task Cancelled by Server Restart');
      expect(textOf(result)).toContain('Cancel Reason:** orphan_cleanup');
      expect(textOf(result)).toContain('Server Epoch:** 1 -> 2');
      expect(textOf(result)).toContain('partial orphaned output');
    });

    it('times out when the task remains running', async () => {
      vi.useFakeTimers();
      const taskId = createTask({ status: 'running' });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        poll_interval_ms: 50,
        timeout_minutes: 0.01,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Task Timed Out');
      expect(textOf(result)).toContain(taskId);
    });

    it('wakes on a matching task event instead of waiting for the full poll interval', async () => {
      const taskId = createTask({ status: 'running' });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      finalizeTask(taskId, 'completed', { output: 'event wakeup' });
      mocks.taskEvents.emit('task:completed', taskId);
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('event wakeup');
    });

    it('runs verify_command after a task completes', async () => {
      const taskId = createTask({ status: 'running' });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (isVerifyExecutor(command)) return 'verify ok\n';
        if (command === 'git' && args[0] === 'rev-parse') return 'abc123\n';
        if (command === 'git' && args[0] === 'diff') return '';
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        verify_command: 'npx vitest run server/tests/workflow-await.test.js',
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      finalizeTask(taskId, 'completed');
      mocks.taskEvents.emit('task:completed', taskId);
      const result = await promise;

      expect(textOf(result)).toContain('### Verify Command');
      expect(textOf(result)).toContain('Passed');
      expect(textOf(result)).toContain('verify ok');
      // Windows may route through a resolved bash.exe path; other environments use bash/cmd/sh.
      const verifyCall = mocks.executeValidatedCommandSync.mock.calls.find(
        ([command]) => isVerifyExecutor(command)
      );
      expect(verifyCall).toBeTruthy();
      expect(verifyCall[2]).toEqual(expect.objectContaining({ cwd: process.cwd() }));
    });

    it('captures verify_command failures without aborting the task result', async () => {
      const taskId = createTask({ status: 'running' });
      mocks.executeValidatedCommandSync.mockImplementation((command) => {
        if (isVerifyExecutor(command)) {
          const error = new Error('verify failed');
          error.stderr = 'failing test output';
          throw error;
        }
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        verify_command: 'npx vitest run broken.test.js',
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      finalizeTask(taskId, 'completed');
      mocks.taskEvents.emit('task:completed', taskId);
      const result = await promise;

      expect(textOf(result)).toContain('### Verify Command');
      expect(textOf(result)).toContain('Failed');
      expect(textOf(result)).toContain('failing test output');
    });

    it('reports overloaded host instead of running task verify_command', async () => {
      const taskId = createTask({ status: 'running' });
      hostMonitoring.hostActivityCache.set('busy-host', {
        gpuMetrics: { cpuPercent: 91, ramPercent: 88 },
      });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        host_id: 'busy-host',
        verify_command: 'npx vitest run server/tests/workflow-await.test.js',
        auto_commit: true,
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      finalizeTask(taskId, 'completed');
      mocks.taskEvents.emit('task:completed', taskId);
      const result = await promise;

      expect(textOf(result)).toContain('### Verify Command');
      expect(textOf(result)).toContain('Verify skipped: Host overloaded');
      expect(textOf(result)).not.toContain('### Auto-Commit');
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('auto-commits tracked task files and pushes when requested', async () => {
      const taskId = createTask({ status: 'running' });
      vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([
        { relative_path: 'src/one.js', is_outside_workdir: 0 },
        { relative_path: 'src/two.js', is_outside_workdir: 0 },
      ]);

      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'rev-parse') return 'c0ffee\n';
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        auto_commit: true,
        auto_push: true,
        commit_message: 'feat: await task commit',
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      finalizeTask(taskId, 'completed');
      mocks.taskEvents.emit('task:completed', taskId);
      const result = await promise;

      expect(textOf(result)).toContain('### Auto-Commit');
      expect(textOf(result)).toContain('Committed: c0ffee');
      expect(textOf(result)).toContain('Pushed');
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/one.js', 'src/two.js'],
        expect.objectContaining({ cwd: process.cwd() })
      );
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'feat: await task commit', '--', 'src/one.js', 'src/two.js'],
        expect.objectContaining({ cwd: process.cwd() })
      );
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['push'],
        expect.objectContaining({ cwd: process.cwd() })
      );
    });

    it('falls back to git diff paths when tracked task files are unavailable', async () => {
      const taskId = createTask({ status: 'running' });
      vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([]);

      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff') return 'src/fallback.js\n';
        if (args[0] === 'rev-parse') return 'fade00\n';
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        auto_commit: true,
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      finalizeTask(taskId, 'completed');
      mocks.taskEvents.emit('task:completed', taskId);
      const result = await promise;

      expect(textOf(result)).toContain('Committed: fade00');
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['diff', '--name-only', '--relative', 'HEAD', '--', '.'],
        expect.objectContaining({ cwd: process.cwd() })
      );
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/fallback.js'],
        expect.objectContaining({ cwd: process.cwd() })
      );
    });

    it('reports when there are no changed files to commit', async () => {
      const taskId = createTask({ status: 'running' });
      vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([]);
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command === 'git' && args[0] === 'diff') return '';
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        auto_commit: true,
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      finalizeTask(taskId, 'completed');
      mocks.taskEvents.emit('task:completed', taskId);
      const result = await promise;

      expect(textOf(result)).toContain('No changed files to commit');
    });

    it('falls back to timer polling when the event bus listener fails', async () => {
      const taskId = createTask({ status: 'running' });
      vi.spyOn(mocks.taskEvents, 'on').mockImplementation(() => {
        throw new Error('event bus offline');
      });

      const promise = handlers.handleAwaitTask({
        task_id: taskId,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask(taskId, 'completed', { output: 'timer fallback' });
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('timer fallback');
    });
  });

  describe('handleAwaitWorkflow', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', async () => {
      const result = await handlers.handleAwaitWorkflow({ workflow_id: randomUUID() });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow not found');
    });

    it('yields the first unacknowledged terminal task and persists acknowledged_tasks', async () => {
      const workflow = createWorkflow({ name: 'Incremental Workflow' });
      const buildId = createWorkflowTask(workflow.id, 'build');
      const testId = createWorkflowTask(workflow.id, 'test', { status: 'running' });
      finalizeTask(buildId, 'completed', { output: 'build done' });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Task Completed: build');
      expect(textOf(result)).toContain('Workflow Progress: Incremental Workflow');
      expect(textOf(result)).not.toContain('Workflow Completed');

      const updatedWorkflow = workflowEngine.getWorkflow(workflow.id);
      expect(updatedWorkflow.context.acknowledged_tasks).toEqual([buildId]);
      expect(updatedWorkflow.context.acknowledged_tasks).not.toContain(testId);
    });

    it('surfaces persisted Peek bundle artifacts in workflow yields and final summaries', async () => {
      const workflow = createWorkflow({ name: 'Peek Workflow' });
      const buildId = createWorkflowTask(workflow.id, 'build');
      finalizeTask(buildId, 'completed', { output: 'bundle captured' });
      const bundleArtifact = storePeekArtifact(buildId, 'bundle.json');

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Task Completed: build');
      expect(textOf(result)).toContain('### Bundle Artifacts');
      expect(textOf(result)).toContain(`build: bundle.json: ${bundleArtifact.file_path}`);
      expect(textOf(result)).toContain('Workflow Completed: Peek Workflow');
    });

    it('returns a final summary for a multi-task workflow and runs verify only on the last call', async () => {
      const workflow = createWorkflow({ name: 'Final Workflow' });
      const buildId = createWorkflowTask(workflow.id, 'build');
      const testId = createWorkflowTask(workflow.id, 'test', { status: 'running' });
      finalizeTask(buildId, 'completed', { output: 'build output' });

      const firstResult = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        verify_command: 'node --check server/tools.js',
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(firstResult)).toContain('Task Completed: build');
      expect(textOf(firstResult)).not.toContain('### Verification');
      expect(mocks.safeExecChain).not.toHaveBeenCalled();

      finalizeTask(testId, 'completed', { output: 'test output' });
      const secondResult = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        verify_command: 'node --check server/tools.js',
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(secondResult)).toContain('Task Completed: test');
      expect(textOf(secondResult)).toContain('Workflow Completed: Final Workflow');
      expect(textOf(secondResult)).toContain('### Verification');
      expect(textOf(secondResult)).toContain('verify ok');
      expect(mocks.safeExecChain).toHaveBeenCalledTimes(1);
      // When scripts/torque-test.sh exists in cwd, the command is prefixed with
      // "bash <scriptPath> ". When absent, the raw verify_command is used.
      expect(mocks.safeExecChain).toHaveBeenCalledWith(
        expect.stringContaining('node --check server/tools.js'),
        expect.objectContaining({ cwd: process.cwd() })
      );
    });

    it('reports overloaded host instead of running workflow verify_command', async () => {
      const workflow = createWorkflow({ name: 'Gated Workflow' });
      createWorkflowTask(workflow.id, 'build');
      hostMonitoring.hostActivityCache.set('busy-host', {
        gpuMetrics: { cpuPercent: 92, ramPercent: 87 },
      });

      const taskId = workflowEngine.getWorkflowTasks(workflow.id)[0].id;
      finalizeTask(taskId, 'completed', { output: 'build output' });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        host_id: 'busy-host',
        verify_command: 'node --check server/tools.js',
        auto_commit: true,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Workflow Completed: Gated Workflow');
      expect(textOf(result)).toContain('### Verification');
      expect(textOf(result)).toContain('Verify skipped: Host overloaded');
      expect(textOf(result)).not.toContain('### Auto-Commit');
      expect(mocks.safeExecChain).not.toHaveBeenCalled();
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('auto-commits tracked workflow files and pushes when requested', async () => {
      const taskA = randomUUID();
      const taskB = randomUUID();
      const workflow = createWorkflow({
        name: 'Commit Workflow',
        context: { acknowledged_tasks: [taskA, taskB] },
      });

      taskCore.createTask({
        id: taskA,
        workflow_id: workflow.id,
        workflow_node_id: 'a',
        task_description: 'a task',
        provider: 'codex',
        status: 'completed',
        working_directory: process.cwd(),
      });
      taskCore.createTask({
        id: taskB,
        workflow_id: workflow.id,
        workflow_node_id: 'b',
        task_description: 'b task',
        provider: 'codex',
        status: 'completed',
        working_directory: process.cwd(),
      });

      vi.spyOn(fileTracking, 'getTaskFileChanges').mockImplementation((taskId) => {
        if (taskId === taskA) {
          return [{ relative_path: 'src/workflow-a.js', is_outside_workdir: 0 }];
        }
        if (taskId === taskB) {
          return [
            { relative_path: 'src/workflow-b.js', is_outside_workdir: 0 },
            { relative_path: '../escape.js', is_outside_workdir: 1 },
          ];
        }
        return [];
      });

      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/workflow-a.js\nsrc/workflow-b.js\n';
        if (args[0] === 'rev-parse') return 'beaded\n';
        return '';
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        auto_commit: true,
        auto_push: true,
        commit_message: 'feat: workflow done',
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Workflow Completed: Commit Workflow');
      expect(textOf(result)).toContain('Committed:** beaded');
      expect(textOf(result)).toContain('Pushed to remote');
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/workflow-a.js', 'src/workflow-b.js'],
        expect.objectContaining({ cwd: process.cwd() })
      );
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'feat: workflow done', '--', 'src/workflow-a.js', 'src/workflow-b.js'],
        expect.objectContaining({ cwd: process.cwd() })
      );
    });

    it('times out when no workflow task reaches a terminal state', async () => {
      vi.useFakeTimers();
      const workflow = createWorkflow({ name: 'Slow Workflow' });
      createWorkflowTask(workflow.id, 'slow-step', { status: 'running' });

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 50,
        timeout_minutes: 0.01,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Workflow Timed Out: Slow Workflow');
      expect(textOf(result)).toContain('0 / 1 tasks');
    });

    it('treats cancelled workflow tasks as terminal results', async () => {
      const workflow = createWorkflow({ name: 'Cancelled Workflow' });
      const taskId = createWorkflowTask(workflow.id, 'cancelled-step');
      finalizeTask(taskId, 'cancelled');

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Task Completed: cancelled-step');
      expect(textOf(result)).toContain('Status:** cancelled');
      expect(textOf(result)).toContain('Workflow Completed: Cancelled Workflow');
    });

    it('returns restart recovery guidance for restart-cancelled workflow tasks and acknowledges them', async () => {
      const workflow = createWorkflow({ name: 'Restart Recovery Workflow' });
      const taskId = createWorkflowTask(workflow.id, 'build');
      createWorkflowTask(workflow.id, 'test', { status: 'running' });
      finalizeTask(taskId, 'cancelled', {
        cancel_reason: 'server_restart',
        output: 'workflow partial output',
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Workflow Task Cancelled by Server Restart');
      expect(textOf(result)).toContain(`**Task ID:** ${taskId}`);
      expect(textOf(result)).toContain('workflow partial output');
      expect(textOf(result)).toContain('auto_resubmit_on_restart: true');

      const updatedWorkflow = workflowEngine.getWorkflow(workflow.id);
      expect(updatedWorkflow.context.acknowledged_tasks).toEqual([taskId]);
    });

    it('auto-resubmits restart-cancelled workflow tasks and completes on the replacement task', async () => {
      const workflow = createWorkflow({ name: 'Restart Resubmit Workflow' });
      const taskId = createWorkflowTask(workflow.id, 'build');
      finalizeTask(taskId, 'cancelled', {
        cancel_reason: 'server_restart',
        output: 'workflow partial output',
      });

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        auto_resubmit_on_restart: true,
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await new Promise((resolve) => setImmediate(resolve));
      const originalTask = taskCore.getTask(taskId);
      const replacementId = originalTask.metadata.resubmitted_as;
      const replacementTask = taskCore.getTask(replacementId);

      expect(replacementId).toBeTruthy();
      expect(replacementTask.workflow_id).toBe(workflow.id);
      expect(replacementTask.workflow_node_id).toBe('build');
      expect(replacementTask.metadata.resubmitted_from).toBe(taskId);
      expect(replacementTask.metadata.restart_resubmit_count).toBe(1);

      finalizeTask(replacementId, 'completed', {
        output: 'replacement workflow task completed',
      });
      mocks.taskEvents.emit('task:completed', replacementId);

      const result = await promise;
      const updatedWorkflow = workflowEngine.getWorkflow(workflow.id);

      expect(textOf(result)).toContain('Task Completed: build');
      expect(textOf(result)).toContain('replacement workflow task completed');
      expect(textOf(result)).toContain('Workflow Completed: Restart Resubmit Workflow');
      expect(updatedWorkflow.context.acknowledged_tasks).toEqual([taskId, replacementId]);
    });

    it('falls back to timer polling when workflow event listeners cannot be registered', async () => {
      const workflow = createWorkflow({ name: 'Workflow Bus Fallback' });
      const taskId = createWorkflowTask(workflow.id, 'delayed-step', { status: 'running' });
      vi.spyOn(mocks.taskEvents, 'once').mockImplementation(() => {
        throw new Error('event bus offline');
      });

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask(taskId, 'completed', { output: 'completed via timer' });
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed: delayed-step');
      expect(textOf(result)).toContain('completed via timer');
    });

    it('returns WORKFLOW_NOT_FOUND if the workflow task list disappears during polling', async () => {
      const workflow = createWorkflow({ name: 'Vanishing Workflow' });
      createWorkflowTask(workflow.id, 'step-1', { status: 'running' });
      const getWorkflowTasksSpy = vi.spyOn(workflowEngine, 'getWorkflowTasks');
      getWorkflowTasksSpy
        .mockReturnValueOnce([{ id: randomUUID(), status: 'running', workflow_node_id: 'step-1' }])
        .mockReturnValueOnce(null);

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow disappeared');
    });
  });
});
