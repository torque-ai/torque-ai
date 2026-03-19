import { describe, test, expect } from 'vitest';

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
