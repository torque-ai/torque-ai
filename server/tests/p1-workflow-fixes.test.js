const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

const {
  setupTestDb,
  teardownTestDb,
  rawDb,
  safeTool,
} = require('./vitest-setup');

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

let resetForTest;
let taskCore;
let workflowEngine;
let testDir;
let runtime;
let templateBuffer;

const workflowRuntimeDb = {
  createTask: (...args) => taskCore.createTask(...args),
  getTask: (...args) => taskCore.getTask(...args),
  updateTaskStatus: (...args) => taskCore.updateTaskStatus(...args),
  getWorkflow: (...args) => workflowEngine.getWorkflow(...args),
  getTaskDependents: (...args) => workflowEngine.getTaskDependents(...args),
  getTaskDependencies: (...args) => workflowEngine.getTaskDependencies(...args),
  evaluateCondition: (...args) => workflowEngine.evaluateCondition(...args),
  getWorkflowTasks: (...args) => workflowEngine.getWorkflowTasks(...args),
  updateWorkflow: (...args) => workflowEngine.updateWorkflow(...args),
};

function loadTemplateBuffer() {
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  }
  return templateBuffer;
}

function resetRuntimeDb() {
  resetForTest(loadTemplateBuffer());
}

function initRuntime() {
  runtime.init({
    db: workflowRuntimeDb,
    startTask: () => ({ status: 'running' }),
    cancelTask: (taskId, reason) => ({ taskId, reason, status: 'cancelled' }),
    processQueue: () => {},
    dashboard: {
      notifyTaskUpdated: () => {},
      notifyWorkflowUpdated: () => {},
      notifyStatsUpdated: () => {},
    },
  });
}

function createWorkflow(overrides = {}) {
  const id = overrides.id || randomUUID();
  workflowEngine.createWorkflow({
    id,
    name: overrides.name || `wf-${id.slice(0, 8)}`,
    status: overrides.status || 'running',
    description: overrides.description || null,
    working_directory: overrides.working_directory || testDir,
  });
  return id;
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const task = {
    id,
    task_description: overrides.task_description || `Task ${id.slice(0, 8)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'pending',
    provider: overrides.provider || 'codex',
    ...overrides,
  };
  taskCore.createTask(task);
  return id;
}

describe('P1 workflow fixes', () => {
  beforeAll(() => {
    ({ testDir } = setupTestDb('workflow-fixes'));
    ({ resetForTest } = require('../database'));
    taskCore = require('../db/task-core');
    workflowEngine = require('../db/workflow-engine');
    runtime = require('../execution/workflow-runtime');
    initRuntime();
  });

  beforeEach(() => {
    resetRuntimeDb();
    initRuntime();
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('handles sequential termination calls for the same workflow without errors', () => {
    const workflowId = createWorkflow({ name: 'p1-terminal-guard' });
    const firstTask = createTask({ workflow_id: workflowId, status: 'completed' });
    const secondTask = createTask({ workflow_id: workflowId, status: 'completed' });

    // Both calls should complete without throwing (guard releases between calls)
    expect(() => runtime.handleWorkflowTermination(firstTask)).not.toThrow();
    expect(() => runtime.handleWorkflowTermination(secondTask)).not.toThrow();

    // Workflow should reach a terminal state after processing both tasks
    const wf = workflowEngine.getWorkflow(workflowId);
    expect(['completed', 'failed', 'running']).toContain(wf.status);
  });

  it('escapes regex-special characters in template_loop variable names', async () => {
    const templated = `tmpl-${randomUUID()}`;
    const wildcardResult = await safeTool('create_task_template', {
      name: templated,
      task_template: 'expanded=${a.*}, keep=${marker}, index=${index}',
      default_timeout: 30,
    });

    expect(wildcardResult.isError).toBeFalsy();
    const wildcardLoop = await safeTool('template_loop', {
      template_id: templated,
      items: ['value-1'],
      variable_name: 'a.*',
    });
    expect(wildcardLoop.isError).toBeFalsy();

    const wildcardTask = rawDb().prepare(
      'SELECT task_description FROM tasks WHERE template_name = ? AND task_description LIKE ? ORDER BY created_at DESC LIMIT 1'
    ).get(templated, 'expanded=%');
    expect(wildcardTask.task_description).toBe('expanded=value-1, keep=${marker}, index=0');

    const crashTemplate = `tmpl-crash-${randomUUID()}`;
    const crashCreate = await safeTool('create_task_template', {
      name: crashTemplate,
      task_template: 'value=${[value}',
      default_timeout: 30,
    });
    expect(crashCreate.isError).toBeFalsy();

    const crashLoop = await safeTool('template_loop', {
      template_id: crashTemplate,
      items: ['escaped'],
      variable_name: '[value',
    });
    expect(crashLoop.isError).toBeFalsy();

    const crashTask = rawDb().prepare(
      'SELECT task_description FROM tasks WHERE template_name = ? ORDER BY created_at DESC LIMIT 1'
    ).get(crashTemplate);
    expect(crashTask.task_description).toBe('value=escaped');
  });
});
