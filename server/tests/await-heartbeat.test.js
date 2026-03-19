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
const db = require('../database');
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
  db.createTask({
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
  const task = db.getTask(taskId);
  if (!task) return;

  if (task.status === 'blocked') {
    db.updateTaskStatus(taskId, 'pending');
  }

  const current = db.getTask(taskId);
  if (current && ['pending', 'queued'].includes(current.status)) {
    db.updateTaskStatus(taskId, 'running', {
      started_at: overrides.started_at || '2026-01-01T00:00:00.000Z',
    });
  }

  db.updateTaskStatus(taskId, status, {
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
    installCjsModuleMock('../handlers/peek-handlers', {
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
    db.updateTaskStatus(taskId, 'running', {
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
    db.updateTaskStatus(taskId, 'running', {
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
    db.updateTaskStatus(taskId, 'running', {
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
    db.updateTaskStatus(taskId, 'running', {
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
