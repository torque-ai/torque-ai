/**
 * BUG-001b: Workflow node `provider` field ignored — all tasks routed to default.
 *
 * Root cause: updateTaskStatus(id, 'queued') clears the provider column to null
 * whenever a task is requeued (capacity overflow) or unblocked (blocked -> queued).
 * This destroys the explicit provider set during workflow task creation, so
 * resolveProviderRouting falls through to the default provider for all tasks.
 *
 * Fix: updateTaskStatus now checks metadata.user_provider_override before
 * clearing the provider column. buildWorkflowTaskMetadata also stores
 * intended_provider as defense-in-depth so the routing fallback chain works.
 */

'use strict';

const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;
let testDir;

function parseMeta(task) {
  if (!task || !task.metadata) return {};
  if (typeof task.metadata === 'object') return task.metadata;
  try { return JSON.parse(task.metadata); } catch { return {}; }
}

function extractUUID(text) {
  const m = text.match(/([a-f0-9-]{36})/);
  return m ? m[1] : null;
}

describe('BUG-001b: workflow node provider override preserved through requeue', () => {
  beforeAll(() => {
    const env = setupTestDb('wf-provider-override');
    db = env.db;
    testDir = env.testDir;
    // Wire sub-modules so startTask / workflow runtime are functional
    require('../task-manager').initSubModules();
    // Enable cloud API providers used in tests (disabled by default in seeds)
    db.updateProvider('groq', { enabled: 1 });
    db.updateProvider('cerebras', { enabled: 1 });
    db.updateProvider('openrouter', { enabled: 1 });
  });
  afterAll(() => { teardownTestDb(); });

  // ── Core reproduction: create_workflow with per-node providers ──

  it('creates workflow tasks with correct provider and user_provider_override metadata', async () => {
    const result = await safeTool('create_workflow', {
      name: 'provider-override-test',
      working_directory: testDir,
      tasks: [
        { node_id: 'step-groq', task_description: 'Task for groq', provider: 'groq' },
        { node_id: 'step-cerebras', task_description: 'Task for cerebras', provider: 'cerebras' },
        { node_id: 'step-codex', task_description: 'Task for codex', provider: 'codex' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const workflowId = extractUUID(getText(result));
    expect(workflowId).toBeTruthy();

    const tasks = db.getWorkflowTasks(workflowId);
    expect(tasks).toHaveLength(3);

    for (const task of tasks) {
      const meta = parseMeta(task);
      expect(meta.user_provider_override).toBe(true);

      if (task.workflow_node_id === 'step-groq') {
        expect(task.provider).toBe('groq');
        expect(meta.intended_provider).toBe('groq');
      } else if (task.workflow_node_id === 'step-cerebras') {
        expect(task.provider).toBe('cerebras');
        expect(meta.intended_provider).toBe('cerebras');
      } else if (task.workflow_node_id === 'step-codex') {
        expect(task.provider).toBe('codex');
        expect(meta.intended_provider).toBe('codex');
      }
    }
  });

  it('persists crew kind metadata and synthesizes a task description from the crew objective', async () => {
    const result = await safeTool('create_workflow', {
      name: 'crew-metadata-test',
      working_directory: testDir,
      tasks: [
        {
          node_id: 'crew-plan',
          kind: 'crew',
          crew: {
            objective: 'Route planner, critic, and writer until done',
            roles: [
              { name: 'planner', description: 'Build the plan and hand off to the reviewer roles.' },
              { name: 'critic', description: 'Challenge weak points and request stronger output.' },
              { name: 'writer', description: 'Produce the final output after incorporating critique.' },
            ],
            max_rounds: 8,
            router: {
              mode: 'hybrid',
              code_fn: 'return turn.turn_count === 0 ? [\'planner\'] : [\'critic\', \'writer\'];',
              agent_model: 'gpt-5.3-codex-spark',
            },
          },
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    const workflowId = extractUUID(getText(result));
    const [task] = db.getWorkflowTasks(workflowId);
    expect(task.task_description).toBe('Crew objective: Route planner, critic, and writer until done');

    const meta = parseMeta(task);
    expect(meta.kind).toBe('crew');
    expect(meta.crew).toEqual({
      objective: 'Route planner, critic, and writer until done',
      roles: [
        { name: 'planner', description: 'Build the plan and hand off to the reviewer roles.' },
        { name: 'critic', description: 'Challenge weak points and request stronger output.' },
        { name: 'writer', description: 'Produce the final output after incorporating critique.' },
      ],
      max_rounds: 8,
      router: {
        mode: 'hybrid',
        code_fn: 'return turn.turn_count === 0 ? [\'planner\'] : [\'critic\', \'writer\'];',
        agent_model: 'gpt-5.3-codex-spark',
      },
    });
  });

  // ── BUG REPRODUCTION: provider survives requeue (updateTaskStatus 'queued') ──

  it('preserves provider when task is requeued via updateTaskStatus', () => {
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Explicit groq task that gets requeued',
      working_directory: testDir,
      status: 'pending',
      provider: 'groq',
      metadata: JSON.stringify({ user_provider_override: true, intended_provider: 'groq' }),
    });

    // Verify initial state
    let task = db.getTask(taskId);
    expect(task.provider).toBe('groq');

    // Simulate what happens when startTask can't claim a slot:
    // db.updateTaskStatus(taskId, 'queued') — this used to clear provider to null
    db.updateTaskStatus(taskId, 'queued');

    task = db.getTask(taskId);
    // BUG FIX: provider must survive the requeue because user_provider_override is true
    expect(task.provider).toBe('groq');
    const meta = parseMeta(task);
    expect(meta.user_provider_override).toBe(true);
    expect(meta.intended_provider).toBe('groq');
  });

  it('still clears provider on requeue for smart-routed tasks (no user override)', () => {
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Smart-routed task that gets requeued',
      working_directory: testDir,
      status: 'pending',
      provider: 'cerebras',
      metadata: JSON.stringify({ smart_routing: true }),
    });

    let task = db.getTask(taskId);
    expect(task.provider).toBe('cerebras');

    // Requeue — should clear provider for smart-routed tasks (existing behavior)
    db.updateTaskStatus(taskId, 'queued');

    task = db.getTask(taskId);
    expect(task.provider).toBeNull();
  });

  it('still clears provider on requeue when no metadata exists', () => {
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Task with no metadata',
      working_directory: testDir,
      status: 'pending',
      provider: 'groq',
    });

    db.updateTaskStatus(taskId, 'queued');

    const task = db.getTask(taskId);
    expect(task.provider).toBeNull();
  });

  // ── BUG REPRODUCTION: provider survives unblock (blocked -> queued) ──

  it('preserves provider when blocked workflow task is unblocked', async () => {
    // Create a workflow with a dependency chain
    const result = await safeTool('create_workflow', {
      name: 'unblock-provider-test',
      working_directory: testDir,
      tasks: [
        { node_id: 'first', task_description: 'First task', provider: 'cerebras' },
        { node_id: 'second', task_description: 'Second task depends on first', provider: 'groq', depends_on: ['first'] },
      ],
    });

    expect(result.isError).toBeFalsy();
    const workflowId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(workflowId);

    const secondTask = tasks.find(t => t.workflow_node_id === 'second');
    expect(secondTask).toBeTruthy();
    expect(secondTask.status).toBe('blocked');
    expect(secondTask.provider).toBe('groq');

    // Simulate unblock: this calls db.updateTaskStatus(taskId, 'queued')
    // which used to clear the provider
    db.updateTaskStatus(secondTask.id, 'queued');

    const updatedTask = db.getTask(secondTask.id);
    // BUG FIX: provider must survive the unblock
    expect(updatedTask.provider).toBe('groq');
    expect(updatedTask.status).toBe('queued');
    const meta = parseMeta(updatedTask);
    expect(meta.user_provider_override).toBe(true);
    expect(meta.intended_provider).toBe('groq');
  });

  // ── add_workflow_task also stores intended_provider ──

  it('add_workflow_task stores intended_provider in metadata', async () => {
    const wfResult = await safeTool('create_workflow', {
      name: 'add-task-provider-test',
      working_directory: testDir,
      tasks: [
        { node_id: 'seed', task_description: 'Seed task' },
      ],
    });
    expect(wfResult.isError).toBeFalsy();
    const workflowId = extractUUID(getText(wfResult));

    const addResult = await safeTool('add_workflow_task', {
      workflow_id: workflowId,
      node_id: 'added-openrouter',
      task_description: 'Task added with openrouter provider',
      provider: 'openrouter',
    });
    expect(addResult.isError).toBeFalsy();

    const tasks = db.getWorkflowTasks(workflowId);
    const addedTask = tasks.find(t => t.workflow_node_id === 'added-openrouter');
    expect(addedTask).toBeTruthy();
    expect(addedTask.provider).toBe('openrouter');

    const meta = parseMeta(addedTask);
    expect(meta.user_provider_override).toBe(true);
    expect(meta.intended_provider).toBe('openrouter');
  });

  it('add_workflow_task accepts crew nodes without an explicit task_description', async () => {
    const wfResult = await safeTool('create_workflow', {
      name: 'add-crew-task-test',
      working_directory: testDir,
      tasks: [
        { node_id: 'seed', task_description: 'Seed task' },
      ],
    });
    expect(wfResult.isError).toBeFalsy();
    const workflowId = extractUUID(getText(wfResult));

    const addResult = await safeTool('add_workflow_task', {
      workflow_id: workflowId,
      node_id: 'crew-node',
      kind: 'crew',
      crew: {
        objective: 'Have planner speak first',
        roles: [
          { name: 'planner', description: 'Start the discussion with the initial plan.' },
          { name: 'critic', description: 'Review the planner output and decide whether to stop.' },
        ],
        router: {
          mode: 'code',
          code_fn: 'return turn.turn_count === 0 ? \'planner\' : null;',
        },
      },
    });
    expect(addResult.isError).toBeFalsy();

    const tasks = db.getWorkflowTasks(workflowId);
    const addedTask = tasks.find((task) => task.workflow_node_id === 'crew-node');
    expect(addedTask).toBeTruthy();
    expect(addedTask.task_description).toBe('Crew objective: Have planner speak first');

    const meta = parseMeta(addedTask);
    expect(meta.kind).toBe('crew');
    expect(meta.crew).toEqual({
      objective: 'Have planner speak first',
      roles: [
        { name: 'planner', description: 'Start the discussion with the initial plan.' },
        { name: 'critic', description: 'Review the planner output and decide whether to stop.' },
      ],
      router: {
        mode: 'code',
        code_fn: 'return turn.turn_count === 0 ? \'planner\' : null;',
      },
    });
  });

  it('rejects crew nodes when a role description is missing', async () => {
    const result = await safeTool('create_workflow', {
      name: 'crew-missing-role-description',
      working_directory: testDir,
      tasks: [
        {
          node_id: 'crew-plan',
          kind: 'crew',
          crew: {
            objective: 'Route planner and critic until done',
            roles: [{ name: 'planner' }, { name: 'critic', description: 'Review the plan.' }],
          },
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/description/i);
  });

  it('rejects crew nodes with more than six roles', async () => {
    const result = await safeTool('create_workflow', {
      name: 'crew-too-many-roles',
      working_directory: testDir,
      tasks: [
        {
          node_id: 'crew-plan',
          kind: 'crew',
          crew: {
            objective: 'Coordinate a large crew',
            roles: [
              { name: 'r1', description: 'Role 1' },
              { name: 'r2', description: 'Role 2' },
              { name: 'r3', description: 'Role 3' },
              { name: 'r4', description: 'Role 4' },
              { name: 'r5', description: 'Role 5' },
              { name: 'r6', description: 'Role 6' },
              { name: 'r7', description: 'Role 7' },
            ],
          },
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/6|roles/i);
  });

  // ── Mixed queue: override + auto-routed tasks coexist correctly ──

  it('override and auto-routed tasks coexist in same workflow', async () => {
    const result = await safeTool('create_workflow', {
      name: 'mixed-provider-test',
      working_directory: testDir,
      tasks: [
        { node_id: 'explicit', task_description: 'Explicit groq task', provider: 'groq' },
        { node_id: 'auto', task_description: 'Auto-routed task (no provider)' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const workflowId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(workflowId);

    const explicitTask = tasks.find(t => t.workflow_node_id === 'explicit');
    const autoTask = tasks.find(t => t.workflow_node_id === 'auto');

    // Explicit task has provider and override flag
    expect(explicitTask.provider).toBe('groq');
    const explicitMeta = parseMeta(explicitTask);
    expect(explicitMeta.user_provider_override).toBe(true);
    expect(explicitMeta.intended_provider).toBe('groq');

    // Auto-routed task gets a default provider but NO override flag
    const autoMeta = parseMeta(autoTask);
    expect(autoMeta.user_provider_override).toBeFalsy();

    // Simulate requeue for both
    db.updateTaskStatus(explicitTask.id, 'queued');
    db.updateTaskStatus(autoTask.id, 'queued');

    // Explicit task preserves provider
    const requeuedExplicit = db.getTask(explicitTask.id);
    expect(requeuedExplicit.provider).toBe('groq');

    // Auto-routed task gets provider cleared (expected behavior)
    const requeuedAuto = db.getTask(autoTask.id);
    expect(requeuedAuto.provider).toBeNull();
  });

  // ── _preserveProvider flag still works as before ──

  it('_preserveProvider flag still preserves provider for non-override tasks', () => {
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Task with preserveProvider flag',
      working_directory: testDir,
      status: 'pending',
      provider: 'cerebras',
      metadata: JSON.stringify({ smart_routing: true }),
    });

    db.updateTaskStatus(taskId, 'queued', { _preserveProvider: true });

    const task = db.getTask(taskId);
    expect(task.provider).toBe('cerebras');
  });
});
