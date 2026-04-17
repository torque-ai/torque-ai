/**
 * Remote Workstation Routing — Await Verify Routing Tests
 *
 * Tests that await_task and await_workflow verify commands route through
 * torque-remote when it is available on PATH, and fall back to direct
 * execution when it is not.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

import { afterEach as afterEachV, beforeEach as beforeEachV, describe as describeV, expect as expectV, it as itV, vi as viV } from 'vitest';

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

// Hoisted mocks (must be set up before require() of the module under test)
const awaitMocks = viV.hoisted(() => ({
  taskEvents: new EventEmitter(),
  executeValidatedCommandSync: viV.fn(),
  safeExecChain: viV.fn(),
  handlePeekUi: viV.fn(),
}));

function installAwaitMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadAwaitFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function textOfResult(result) {
  return result?.content?.[0]?.text || '';
}

describeV('await verify routing', () => {
  const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
  const taskCore = require('../db/task-core');
  const workflowEngine = require('../db/workflow-engine');
  const hostMonitoring = require('../utils/host-monitoring');
  let tmpDir;
  let handlers;

  function createTestTask(overrides = {}) {
    const id = overrides.id || randomUUID();
    taskCore.createTask({
      id,
      task_description: 'Routing test task',
      provider: 'codex',
      model: 'gpt-5',
      status: 'pending',
      working_directory: tmpDir,
      ...overrides,
    });
    return id;
  }

  function finalizeTestTask(taskId, status = 'completed', overrides = {}) {
    const task = taskCore.getTask(taskId);
    if (!task) return;
    if (task.status === 'blocked') taskCore.updateTaskStatus(taskId, 'pending');
    const current = taskCore.getTask(taskId);
    if (current && ['pending', 'queued'].includes(current.status)) {
      taskCore.updateTaskStatus(taskId, 'running', { started_at: '2026-01-01T00:00:00.000Z' });
    }
    taskCore.updateTaskStatus(taskId, status, {
      output: overrides.output ?? (status === 'completed' ? 'task output' : ''),
      error_output: overrides.error_output ?? (status === 'failed' ? 'task failed' : null),
      exit_code: overrides.exit_code ?? (status === 'completed' ? 0 : 1),
      completed_at: '2026-01-01T00:00:05.000Z',
      files_modified: overrides.files_modified ?? null,
    });
  }

  beforeEachV(() => {
    tmpDir = path.join(os.tmpdir(), `torque-await-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    setupTestDbOnly(`await-routing-${Date.now()}`);

    installAwaitMock('../hooks/event-dispatch', { taskEvents: awaitMocks.taskEvents });
    installAwaitMock('../execution/command-policy', {
      executeValidatedCommandSync: awaitMocks.executeValidatedCommandSync,
    });
    installAwaitMock('../utils/safe-exec', {
      safeExecChain: awaitMocks.safeExecChain,
    });
    installAwaitMock('../plugins/snapscope/handlers/capture', {
      handlePeekUi: awaitMocks.handlePeekUi,
    });

    awaitMocks.executeValidatedCommandSync.mockReset();
    awaitMocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
      if (command === 'git' && args[0] === 'rev-parse') return 'abc123\n';
      if (command === 'git' && args[0] === 'diff') return '';
      return 'verify ok\n';
    });
    awaitMocks.safeExecChain.mockReset();
    awaitMocks.safeExecChain.mockReturnValue({ exitCode: 0, output: 'verify ok' });
    awaitMocks.handlePeekUi.mockReset();
    awaitMocks.handlePeekUi.mockResolvedValue({ content: [] });
    awaitMocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();

    handlers = loadAwaitFresh('../handlers/workflow/await');
  });

  afterEachV(() => {
    viV.restoreAllMocks();
    awaitMocks.executeValidatedCommandSync.mockReset();
    awaitMocks.safeExecChain.mockReset();
    awaitMocks.handlePeekUi.mockReset();
    awaitMocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    viV.useRealTimers();
    teardownTestDb();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  itV('handleAwaitTask routes through torque-remote when it is on PATH', async () => {
    viV.spyOn(require('child_process'), 'execFileSync').mockImplementation((cmd, args) => {
      if (cmd === 'which' && args[0] === 'torque-remote') return '/usr/local/bin/torque-remote';
      throw new Error('unexpected execFileSync call');
    });

    const taskId = createTestTask({ status: 'running', working_directory: tmpDir });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      verify_command: 'npx vitest run',
      working_directory: tmpDir,
      poll_interval_ms: 30000,
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));
    finalizeTestTask(taskId, 'completed');
    awaitMocks.taskEvents.emit('task:completed', taskId);
    const result = await promise;

    expectV(textOfResult(result)).toContain('### Verify Command');
    expectV(textOfResult(result)).toContain('Passed');

    expectV(awaitMocks.executeValidatedCommandSync).toHaveBeenCalledWith(
      'torque-remote',
      expectV.arrayContaining(['npx vitest run']),
      expectV.objectContaining({ cwd: tmpDir })
    );
    const verifyCalls = awaitMocks.executeValidatedCommandSync.mock.calls.filter(
      ([cmd]) => cmd === 'sh' || cmd === 'cmd'
    );
    expectV(verifyCalls.length).toBe(0);
  });

  itV('handleAwaitTask falls back to direct execution when torque-remote is not on PATH', async () => {
    viV.spyOn(require('child_process'), 'execFileSync').mockImplementation(() => {
      throw new Error('not found');
    });

    const taskId = createTestTask({ status: 'running', working_directory: tmpDir });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      verify_command: 'npx vitest run',
      working_directory: tmpDir,
      poll_interval_ms: 30000,
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));
    finalizeTestTask(taskId, 'completed');
    awaitMocks.taskEvents.emit('task:completed', taskId);
    const result = await promise;

    expectV(textOfResult(result)).toContain('### Verify Command');
    expectV(textOfResult(result)).toContain('Passed');

    expectV(awaitMocks.executeValidatedCommandSync).toHaveBeenCalledWith(
      expectV.stringMatching(/^(cmd|sh)$/),
      expectV.arrayContaining(['npx vitest run']),
      expectV.objectContaining({ cwd: tmpDir })
    );
    const torqueRemoteCalls = awaitMocks.executeValidatedCommandSync.mock.calls.filter(
      ([cmd]) => cmd === 'torque-remote'
    );
    expectV(torqueRemoteCalls.length).toBe(0);
  });

  itV('handleAwaitWorkflow routes through torque-remote when it is on PATH', async () => {
    viV.spyOn(require('child_process'), 'execFileSync').mockImplementation((cmd, args) => {
      if (cmd === 'which' && args[0] === 'torque-remote') return '/usr/local/bin/torque-remote';
      throw new Error('unexpected execFileSync call');
    });

    const wfId = randomUUID();
    workflowEngine.createWorkflow({
      id: wfId,
      name: 'Routing workflow test',
      status: 'completed',
      context: {},
      working_directory: tmpDir,
    });

    const taskId = randomUUID();
    taskCore.createTask({
      id: taskId,
      workflow_id: wfId,
      workflow_node_id: 'build',
      task_description: 'build task',
      provider: 'codex',
      model: 'gpt-5',
      status: 'pending',
      working_directory: tmpDir,
    });
    taskCore.updateTaskStatus(taskId, 'running', { started_at: '2026-01-01T00:00:00.000Z' });
    taskCore.updateTaskStatus(taskId, 'completed', {
      output: 'build done',
      exit_code: 0,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    const result = await handlers.handleAwaitWorkflow({
      workflow_id: wfId,
      verify_command: 'npx vitest run',
      working_directory: tmpDir,
      poll_interval_ms: 10,
      timeout_minutes: 1,
    });

    const text = textOfResult(result);
    expectV(text).toContain('### Verification');

    expectV(awaitMocks.safeExecChain).toHaveBeenCalledWith(
      expectV.stringContaining('torque-remote'),
      expectV.objectContaining({ cwd: tmpDir })
    );
    expectV(awaitMocks.safeExecChain).toHaveBeenCalledWith(
      expectV.stringContaining('npx vitest run'),
      expectV.any(Object)
    );
  });

  itV('handleAwaitWorkflow falls back to direct command when torque-remote is not on PATH', async () => {
    viV.spyOn(require('child_process'), 'execFileSync').mockImplementation(() => {
      throw new Error('not found');
    });

    const wfId = randomUUID();
    workflowEngine.createWorkflow({
      id: wfId,
      name: 'Routing workflow fallback test',
      status: 'completed',
      context: {},
      working_directory: tmpDir,
    });

    const taskId = randomUUID();
    taskCore.createTask({
      id: taskId,
      workflow_id: wfId,
      workflow_node_id: 'build',
      task_description: 'build task',
      provider: 'codex',
      model: 'gpt-5',
      status: 'pending',
      working_directory: tmpDir,
    });
    taskCore.updateTaskStatus(taskId, 'running', { started_at: '2026-01-01T00:00:00.000Z' });
    taskCore.updateTaskStatus(taskId, 'completed', {
      output: 'build done',
      exit_code: 0,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    const result = await handlers.handleAwaitWorkflow({
      workflow_id: wfId,
      verify_command: 'npx vitest run',
      working_directory: tmpDir,
      poll_interval_ms: 10,
      timeout_minutes: 1,
    });

    const text = textOfResult(result);
    expectV(text).toContain('### Verification');

    expectV(awaitMocks.safeExecChain).toHaveBeenCalledWith(
      'npx vitest run',
      expectV.objectContaining({ cwd: tmpDir })
    );
  });
});
