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
