import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mocks } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return {
    mocks: {
      taskEvents: new EventEmitter(),
      executeValidatedCommandSync: vi.fn(),
      safeExecChain: vi.fn(),
      handlePeekUi: vi.fn(),
    },
  };
});

describe('await tool definitions', () => {
  test('await_workflow has heartbeat_minutes parameter', async () => {
    const defs = await import('../tool-defs/workflow-defs.js');
    const tools = defs.default || defs;

    // Find await_workflow — check the export shape (may be array or object with .tools)
    const toolList = Array.isArray(tools) ? tools : tools.tools || [];
    const awaitWorkflow = toolList.find(t => t.name === 'await_workflow');

    expect(awaitWorkflow).toBeDefined();
    const props = awaitWorkflow.inputSchema?.properties || {};
    expect(props.heartbeat_minutes).toBeDefined();
    expect(props.heartbeat_minutes.type).toBe('number');
    expect(props.heartbeat_minutes.default).toBe(5);
  });

  test('await_task has heartbeat_minutes parameter', async () => {
    const defs = await import('../tool-defs/workflow-defs.js');
    const tools = defs.default || defs;

    const toolList = Array.isArray(tools) ? tools : tools.tools || [];
    const awaitTask = toolList.find(t => t.name === 'await_task');

    expect(awaitTask).toBeDefined();
    const props = awaitTask.inputSchema?.properties || {};
    expect(props.heartbeat_minutes).toBeDefined();
    expect(props.heartbeat_minutes.type).toBe('number');
    expect(props.heartbeat_minutes.default).toBe(5);
  });
});

describe('formatHeartbeat', () => {
  test('scheduled heartbeat includes reason and task progress', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const result = formatHeartbeat({
      taskId: 'abc123',
      reason: 'scheduled',
      elapsedMs: 272000,
      runningTasks: [{
        id: 'abc123',
        provider: 'codex',
        host: 'cloud',
        elapsedMs: 272000,
        description: 'Write unit tests for auth module'
      }],
      taskCounts: { completed: 2, failed: 0, running: 1, pending: 3 },
      partialOutput: 'Creating test file auth.test.js...\nWriting test cases...',
      alerts: []
    });

    expect(result).toContain('Heartbeat');
    expect(result).toContain('Await Task');
    expect(result).toContain('scheduled');
    expect(result).toContain('4m 32s');
    expect(result).toContain('2 completed');
    expect(result).toContain('abc123');
    expect(result).toContain('codex');
    expect(result).toContain('Writing test cases');
  });

  test('stall_warning heartbeat includes alert', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const result = formatHeartbeat({
      taskId: 'def456',
      reason: 'stall_warning',
      elapsedMs: 144000,
      runningTasks: [{
        id: 'def456',
        provider: 'ollama',
        host: 'local',
        elapsedMs: 144000,
        description: 'Generate data models'
      }],
      taskCounts: { completed: 0, failed: 0, running: 1, pending: 0 },
      partialOutput: null,
      alerts: ['Approaching stall threshold (144s / 180s)']
    });

    expect(result).toContain('stall_warning');
    expect(result).toContain('Approaching stall threshold');
    expect(result).toContain('No output captured yet');
  });

  test('heartbeat with no partial output says so', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const result = formatHeartbeat({
      taskId: 'ghi789',
      reason: 'task_started',
      elapsedMs: 1000,
      runningTasks: [{
        id: 'ghi789',
        provider: 'codex',
        host: 'cloud',
        elapsedMs: 1000,
        description: 'Test task'
      }],
      taskCounts: { completed: 0, failed: 0, running: 1, pending: 0 },
      partialOutput: null,
      alerts: []
    });

    expect(result).toContain('No output captured yet');
  });

  test('partial output is capped at 1500 chars', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const longOutput = 'x'.repeat(3000);
    const result = formatHeartbeat({
      taskId: 'jkl012',
      reason: 'scheduled',
      elapsedMs: 300000,
      runningTasks: [{
        id: 'jkl012',
        provider: 'ollama',
        host: 'local',
        elapsedMs: 300000,
        description: 'Long task'
      }],
      taskCounts: { completed: 0, failed: 0, running: 1, pending: 0 },
      partialOutput: longOutput,
      alerts: []
    });

    expect(result).not.toContain('x'.repeat(2000));
    expect(result).toContain('x'.repeat(100));
    expect(result).toContain('truncated');
  });

  test('workflow heartbeat says Await Workflow in header', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const result = formatHeartbeat({
      taskId: 'wf-001',
      isWorkflow: true,
      reason: 'scheduled',
      elapsedMs: 300000,
      runningTasks: [],
      taskCounts: { completed: 1, failed: 0, running: 0, pending: 2 },
      partialOutput: null,
      alerts: [],
      nextUpTasks: [{ id: 'task-a', description: 'Build the thing' }]
    });

    expect(result).toContain('Await Workflow');
    expect(result).toContain('Next Up');
    expect(result).toContain('Build the thing');
  });
});


// ---------------------------------------------------------------------------
// Heartbeat integration tests for handleAwaitTask
// ---------------------------------------------------------------------------
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');
const workflowEngine = require('../db/workflow-engine');
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

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  taskCore.createTask({
    id,
    task_description: 'Heartbeat test task',
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

  taskCore.updateTaskStatus(taskId, status, {
    output: overrides.output ?? (status === 'completed' ? 'task output' : ''),
    error_output: overrides.error_output ?? (status === 'failed' ? 'task failed' : null),
    exit_code: overrides.exit_code
      ?? (status === 'completed' ? 0 : ['cancelled', 'skipped'].includes(status) ? null : 1),
    completed_at: overrides.completed_at || '2026-01-01T00:00:05.000Z',
    files_modified: overrides.files_modified ?? null,
  });
}

describe('handleAwaitTask heartbeat integration', () => {
  beforeEach(() => {
    setupTestDb(`await-heartbeat-${Date.now()}`);
    installCjsModuleMock('../hooks/event-dispatch', {
      taskEvents: mocks.taskEvents,
      NOTABLE_EVENTS: ['started', 'stall_warning', 'retry', 'fallback'],
    });
    installCjsModuleMock('../execution/command-policy', {
      executeValidatedCommandSync: mocks.executeValidatedCommandSync,
    });
    installCjsModuleMock('../utils/safe-exec', {
      safeExecChain: mocks.safeExecChain,
    });
    installCjsModuleMock('../plugins/snapscope/handlers/capture', {
      handlePeekUi: mocks.handlePeekUi,
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
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    handlers = loadFresh('../handlers/workflow/await');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.executeValidatedCommandSync.mockReset();
    mocks.safeExecChain.mockReset();
    mocks.handlePeekUi.mockReset();
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    vi.useRealTimers();
    teardownTestDb();
  });

  test('heartbeat fires on timer after heartbeat_minutes elapses', async () => {
    vi.useFakeTimers();
    const taskId = createTask({ status: 'running' });
    // Set started_at so elapsed calc works
    taskCore.updateTaskStatus(taskId, 'running', {
      started_at: new Date(Date.now() - 10000).toISOString(),
    });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 1, // 60 seconds
      poll_interval_ms: 5000,
      timeout_minutes: 5,
    });

    // Advance past the heartbeat interval (61 seconds)
    await vi.advanceTimersByTimeAsync(61000);
    const result = await promise;

    expect(textOf(result)).toContain('Heartbeat');
    expect(textOf(result)).toContain('scheduled');
    expect(textOf(result)).toContain('Re-invoke to continue waiting');
  });

  test('heartbeat_minutes=0 disables heartbeats, falls through to terminal or timeout', async () => {
    vi.useFakeTimers();
    const taskId = createTask({ status: 'running' });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 0,
      poll_interval_ms: 50,
      timeout_minutes: 0.01, // 600ms
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    // Should timeout, NOT heartbeat
    expect(textOf(result)).toContain('Task Timed Out');
    expect(textOf(result)).not.toContain('Heartbeat');
  });

  test('notable event (task:started) triggers immediate heartbeat', async () => {
    const taskId = createTask({ status: 'running' });
    taskCore.updateTaskStatus(taskId, 'running', {
      started_at: new Date().toISOString(),
    });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    // Allow the Promise to register listeners
    await new Promise(r => setImmediate(r));

    // Emit a notable event for this task
    mocks.taskEvents.emit('task:started', { id: taskId, status: 'running' });

    const result = await promise;

    expect(textOf(result)).toContain('Heartbeat');
    expect(textOf(result)).toContain('task_started');
  });

  test('terminal event returns completion, not heartbeat', async () => {
    const taskId = createTask({ status: 'running' });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    await new Promise(r => setImmediate(r));

    // Complete the task and emit terminal event
    finalizeTask(taskId, 'completed', { output: 'done here' });
    mocks.taskEvents.emit('task:completed', { id: taskId, status: 'completed' });

    const result = await promise;

    expect(textOf(result)).toContain('Task Completed');
    expect(textOf(result)).toContain('done here');
    // Should NOT contain a heartbeat header — only the terminal result
    expect(textOf(result)).not.toContain('## Heartbeat');
  });

  test('notable event for wrong task_id is ignored', async () => {
    vi.useFakeTimers();
    const taskId = createTask({ status: 'running' });
    const otherTaskId = randomUUID();

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 5,  // heartbeat at 5 min, but timeout at 600ms
      poll_interval_ms: 200,
      timeout_minutes: 0.01, // 600ms timeout
    });

    // Let the loop start
    await vi.advanceTimersByTimeAsync(0);

    // Emit notable event for a DIFFERENT task — should be ignored
    mocks.taskEvents.emit('task:started', { id: otherTaskId, status: 'running' });

    // Advance until timeout
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    // Should timeout, not heartbeat — the event was for a different task
    expect(textOf(result)).toContain('Task Timed Out');
    expect(textOf(result)).not.toContain('Heartbeat');
  });

  test('heartbeat includes partial_output from DB', async () => {
    const taskId = createTask({ status: 'running' });
    taskCore.updateTaskStatus(taskId, 'running', {
      started_at: new Date().toISOString(),
      partial_output: 'Working on files...',
    });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    await new Promise(r => setImmediate(r));

    // Trigger notable event to get heartbeat
    mocks.taskEvents.emit('task:started', { id: taskId, status: 'running' });
    const result = await promise;

    expect(textOf(result)).toContain('Heartbeat');
    // partial_output from the DB should appear if the column exists
    // The test validates the heartbeat path includes it
    expect(textOf(result)).toContain('Working on files...');
  });

  test('task:retry triggers heartbeat, not completion', async () => {
    const taskId = createTask({ status: 'running' });
    taskCore.updateTaskStatus(taskId, 'running', {
      started_at: new Date().toISOString(),
    });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    await new Promise(r => setImmediate(r));

    // Emit retry notable event
    mocks.taskEvents.emit('task:retry', { id: taskId, status: 'running' });
    const result = await promise;

    expect(textOf(result)).toContain('Heartbeat');
    expect(textOf(result)).toContain('task_retried');
    expect(textOf(result)).not.toContain('Task Completed');
  });

  test('heartbeat timer clamped to remaining timeout', async () => {
    vi.useFakeTimers();
    const taskId = createTask({ status: 'running' });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 10, // 600s heartbeat
      poll_interval_ms: 5000,
      timeout_minutes: 0.05, // 3 seconds timeout — much shorter than heartbeat
    });

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    // Should timeout since timeout < heartbeat interval
    expect(textOf(result)).toContain('Task Timed Out');
  });
});


// ---------------------------------------------------------------------------
// Heartbeat integration tests for handleAwaitWorkflow
// ---------------------------------------------------------------------------

function createWorkflowWithTasks(taskDefs) {
  const workflowId = randomUUID();
  workflowEngine.createWorkflow({
    id: workflowId,
    name: 'heartbeat-wf-test',
  });

  const taskIds = {};
  for (const def of taskDefs) {
    const taskId = randomUUID();
    taskCore.createTask({
      id: taskId,
      task_description: def.description || 'Workflow task',
      provider: def.provider || 'codex',
      model: def.model || 'gpt-5',
      status: def.status || 'pending',
      working_directory: process.cwd(),
      workflow_id: workflowId,
      workflow_node_id: def.node_id || def.name || taskId.substring(0, 8),
    });
    taskIds[def.name || def.node_id || taskId.substring(0, 8)] = taskId;
  }

  return { workflowId, taskIds };
}

describe('handleAwaitWorkflow heartbeat integration', () => {
  beforeEach(() => {
    setupTestDb(`await-wf-heartbeat-${Date.now()}`);
    installCjsModuleMock('../hooks/event-dispatch', {
      taskEvents: mocks.taskEvents,
      NOTABLE_EVENTS: ['started', 'stall_warning', 'retry', 'fallback'],
    });
    installCjsModuleMock('../execution/command-policy', {
      executeValidatedCommandSync: mocks.executeValidatedCommandSync,
    });
    installCjsModuleMock('../utils/safe-exec', {
      safeExecChain: mocks.safeExecChain,
    });
    installCjsModuleMock('../plugins/snapscope/handlers/capture', {
      handlePeekUi: mocks.handlePeekUi,
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
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    handlers = loadFresh('../handlers/workflow/await');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.executeValidatedCommandSync.mockReset();
    mocks.safeExecChain.mockReset();
    mocks.handlePeekUi.mockReset();
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    vi.useRealTimers();
    teardownTestDb();
  });

  test('workflow heartbeat includes all running tasks', async () => {
    // Create workflow: 1 completed, 1 running, 1 pending
    const { workflowId, taskIds } = createWorkflowWithTasks([
      { name: 'done', description: 'Completed step', status: 'pending' },
      { name: 'active', description: 'Running step', status: 'pending' },
      { name: 'waiting', description: 'Pending step', status: 'pending' },
    ]);

    // Transition done -> completed
    finalizeTask(taskIds.done, 'completed', { output: 'done output' });

    // Transition active -> running
    taskCore.updateTaskStatus(taskIds.active, 'running', {
      started_at: new Date(Date.now() - 30000).toISOString(),
      provider: 'codex',
    });

    // Acknowledge the completed task so yield doesn't fire
    const wf = workflowEngine.getWorkflow(workflowId);
    workflowEngine.updateWorkflow(workflowId, {
      context: { ...wf.context, acknowledged_tasks: [taskIds.done] },
    });

    const promise = handlers.handleAwaitWorkflow({
      workflow_id: workflowId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    await new Promise(r => setImmediate(r));

    // Emit notable event for a workflow task
    mocks.taskEvents.emit('task:started', { id: taskIds.active, status: 'running' });

    const result = await promise;
    const text = textOf(result);

    expect(text).toContain('Heartbeat');
    expect(text).toContain('Await Workflow');
    expect(text).toContain('1 completed');
    expect(text).toContain('1 running');
    expect(text).toContain('1 pending');
  });

  test('task yield takes priority over scheduled heartbeat', async () => {
    const { workflowId, taskIds } = createWorkflowWithTasks([
      { name: 'step1', description: 'First step', status: 'pending' },
      { name: 'step2', description: 'Second step', status: 'pending' },
    ]);

    // Transition step1 running -> completed
    taskCore.updateTaskStatus(taskIds.step1, 'running', {
      started_at: new Date().toISOString(),
    });

    // Start step2 running
    taskCore.updateTaskStatus(taskIds.step2, 'running', {
      started_at: new Date().toISOString(),
    });

    // Complete step1 — this should cause a task yield, not a heartbeat
    finalizeTask(taskIds.step1, 'completed', { output: 'step1 done' });

    const result = await handlers.handleAwaitWorkflow({
      workflow_id: workflowId,
      heartbeat_minutes: 0.001, // Very short heartbeat to ensure it fires quickly
      poll_interval_ms: 50,
      timeout_minutes: 1,
    });

    const text = textOf(result);

    // Task yield should take priority
    expect(text).toContain('Task Completed');
    expect(text).toContain('step1');
    expect(text).not.toContain('## Heartbeat');
  });

  test('workflow heartbeat shows next-up tasks', async () => {
    const { workflowId, taskIds } = createWorkflowWithTasks([
      { name: 'running1', description: 'Active task', status: 'pending' },
      { name: 'queued1', description: 'Queued build step', status: 'pending' },
      { name: 'queued2', description: 'Queued test step', status: 'pending' },
    ]);

    // running1 -> running
    taskCore.updateTaskStatus(taskIds.running1, 'running', {
      started_at: new Date(Date.now() - 60000).toISOString(),
    });

    const promise = handlers.handleAwaitWorkflow({
      workflow_id: workflowId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    await new Promise(r => setImmediate(r));

    // Trigger heartbeat via notable event
    mocks.taskEvents.emit('task:started', { id: taskIds.running1, status: 'running' });

    const result = await promise;
    const text = textOf(result);

    expect(text).toContain('Heartbeat');
    expect(text).toContain('Next Up');
    expect(text).toContain('Queued build step');
    expect(text).toContain('Queued test step');
  });

  test('notable events for any workflow task trigger heartbeat', async () => {
    const { workflowId, taskIds } = createWorkflowWithTasks([
      { name: 'taskA', description: 'Task A', status: 'pending' },
      { name: 'taskB', description: 'Task B', status: 'pending' },
    ]);

    // Both running
    taskCore.updateTaskStatus(taskIds.taskA, 'running', {
      started_at: new Date().toISOString(),
    });
    taskCore.updateTaskStatus(taskIds.taskB, 'running', {
      started_at: new Date().toISOString(),
    });

    const promise = handlers.handleAwaitWorkflow({
      workflow_id: workflowId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    await new Promise(r => setImmediate(r));

    // Emit notable event for taskB (not taskA) — should still trigger heartbeat
    mocks.taskEvents.emit('task:started', { id: taskIds.taskB, status: 'running' });

    const result = await promise;
    const text = textOf(result);

    expect(text).toContain('Heartbeat');
    expect(text).toContain('Await Workflow');
  });

  test('notable events for non-workflow tasks are ignored', async () => {
    vi.useFakeTimers();
    const { workflowId } = createWorkflowWithTasks([
      { name: 'wfTask', description: 'WF task', status: 'pending' },
    ]);

    taskCore.updateTaskStatus(
      workflowEngine.getWorkflowTasks(workflowId)[0].id,
      'running',
      { started_at: new Date(Date.now()).toISOString() }
    );

    const promise = handlers.handleAwaitWorkflow({
      workflow_id: workflowId,
      heartbeat_minutes: 5,
      poll_interval_ms: 200,
      timeout_minutes: 0.01, // 600ms
    });

    await vi.advanceTimersByTimeAsync(0);

    // Emit notable event for a task NOT in this workflow
    const otherTaskId = randomUUID();
    mocks.taskEvents.emit('task:started', { id: otherTaskId, status: 'running' });

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    // Should timeout, not heartbeat — the event was for a non-workflow task
    expect(textOf(result)).toContain('Timed Out');
    expect(textOf(result)).not.toContain('Heartbeat');
  });

  test('rapid notable events are coalesced', async () => {
    const { workflowId, taskIds } = createWorkflowWithTasks([
      { name: 'a', description: 'Task A', status: 'pending' },
      { name: 'b', description: 'Task B', status: 'pending' },
      { name: 'c', description: 'Task C', status: 'pending' },
    ]);

    // All three running
    for (const name of ['a', 'b', 'c']) {
      taskCore.updateTaskStatus(taskIds[name], 'running', {
        started_at: new Date(Date.now() - 10000).toISOString(),
      });
    }

    const promise = handlers.handleAwaitWorkflow({
      workflow_id: workflowId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    await new Promise(r => setImmediate(r));

    // Rapidly emit task:started for all three tasks
    mocks.taskEvents.emit('task:started', { id: taskIds.a, status: 'running' });
    mocks.taskEvents.emit('task:started', { id: taskIds.b, status: 'running' });
    mocks.taskEvents.emit('task:started', { id: taskIds.c, status: 'running' });

    const result = await promise;
    const text = textOf(result);

    // Should get ONE heartbeat (first event wins), showing all 3 running
    expect(text).toContain('Heartbeat');
    expect(text).toContain('3 running');
  });
});


// ---------------------------------------------------------------------------
// End-to-end heartbeat integration scenarios
// ---------------------------------------------------------------------------

describe('heartbeat integration', () => {
  beforeEach(() => {
    setupTestDb(`await-e2e-heartbeat-${Date.now()}`);
    installCjsModuleMock('../hooks/event-dispatch', {
      taskEvents: mocks.taskEvents,
      NOTABLE_EVENTS: ['started', 'stall_warning', 'retry', 'fallback'],
    });
    installCjsModuleMock('../execution/command-policy', {
      executeValidatedCommandSync: mocks.executeValidatedCommandSync,
    });
    installCjsModuleMock('../utils/safe-exec', {
      safeExecChain: mocks.safeExecChain,
    });
    installCjsModuleMock('../plugins/snapscope/handlers/capture', {
      handlePeekUi: mocks.handlePeekUi,
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
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    handlers = loadFresh('../handlers/workflow/await');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.executeValidatedCommandSync.mockReset();
    mocks.safeExecChain.mockReset();
    mocks.handlePeekUi.mockReset();
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    vi.useRealTimers();
    teardownTestDb();
  });

  test('full cycle: heartbeat then completion', async () => {
    // 1. Create a running task
    vi.useFakeTimers();
    const taskId = createTask({ status: 'running' });
    taskCore.updateTaskStatus(taskId, 'running', {
      started_at: new Date(Date.now() - 10000).toISOString(),
    });

    // 2. First call: handleAwaitTask with heartbeat_minutes: 1
    const firstPromise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 1, // 60 seconds
      poll_interval_ms: 5000,
      timeout_minutes: 5,
    });

    // 3. Advance 61 seconds — heartbeat fires with reason 'scheduled'
    await vi.advanceTimersByTimeAsync(61000);
    const firstResult = await firstPromise;

    expect(textOf(firstResult)).toContain('Heartbeat');
    expect(textOf(firstResult)).toContain('scheduled');
    expect(textOf(firstResult)).toContain('Re-invoke to continue waiting');

    // 4. Switch to real timers for the second call so event listeners register
    vi.useRealTimers();

    // 5. Re-invoke handleAwaitTask with the same params (second call)
    const secondPromise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 1,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    // Allow the event loop to register listeners before emitting
    await new Promise(r => setImmediate(r));

    // 6. Complete the task and emit terminal event
    finalizeTask(taskId, 'completed', { output: 'all done' });
    mocks.taskEvents.emit('task:completed', { id: taskId, status: 'completed' });

    // 7. Second call should return completion, not heartbeat
    const secondResult = await secondPromise;
    expect(textOf(secondResult)).toContain('Task Completed');
    expect(textOf(secondResult)).toContain('all done');
    expect(textOf(secondResult)).not.toContain('## Heartbeat');
  });

  test('stall_warning event includes correct alert text', async () => {
    // 1. Create a running task
    const taskId = createTask({ status: 'running' });
    taskCore.updateTaskStatus(taskId, 'running', {
      started_at: new Date().toISOString(),
    });

    // 2. Call handleAwaitTask with heartbeat_minutes: 10
    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 10,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    // Allow the loop to register listeners
    await new Promise(r => setImmediate(r));

    // 3. Emit task:stall_warning with elapsed and threshold
    mocks.taskEvents.emit('task:stall_warning', {
      id: taskId,
      elapsed: 144,
      threshold: 180,
    });

    const result = await promise;
    const text = textOf(result);

    // 4. Verify heartbeat has reason 'stall_warning'
    expect(text).toContain('Heartbeat');
    expect(text).toContain('stall_warning');

    // 5. Verify alert text contains '144s / 180s'
    expect(text).toContain('144s / 180s');
  });

  test('partial_output from DB included in heartbeat', async () => {
    // 1. Create running task, set partial_output in DB to 'test output data'
    const taskId = createTask({ status: 'running' });
    taskCore.updateTaskStatus(taskId, 'running', {
      started_at: new Date().toISOString(),
      partial_output: 'test output data',
    });

    // 2. Call handleAwaitTask, trigger heartbeat via notable event
    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      heartbeat_minutes: 5,
      poll_interval_ms: 30000,
      timeout_minutes: 5,
    });

    await new Promise(r => setImmediate(r));

    mocks.taskEvents.emit('task:started', { id: taskId, status: 'running' });
    const result = await promise;

    // 3. Verify heartbeat text contains 'test output data'
    expect(textOf(result)).toContain('Heartbeat');
    expect(textOf(result)).toContain('test output data');
  });
});
