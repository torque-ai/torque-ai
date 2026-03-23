// server/tests/diffusion-handlers.test.js
'use strict';

const path = require('path');

const HANDLER_MODULE = '../handlers/diffusion-handlers';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../db/task-core',
  '../db/workflow-engine',
  '../task-manager',
  '../logger',
  '../diffusion/plan-schema',
  '../diffusion/planner',
  '../orchestrator/prompt-templates',
  '../handlers/error-codes',
  '../handlers/shared',
  'uuid',
];

// --- Mock objects ---

const mockTaskCore = {
  createTask: vi.fn(),
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(),
};

const mockWorkflowEngine = {
  createWorkflow: vi.fn((wf) => ({ id: wf.id, name: wf.name, status: 'pending', context: wf.context })),
  addTaskDependency: vi.fn(),
  updateWorkflow: vi.fn(),
  updateWorkflowCounts: vi.fn(),
  getWorkflow: vi.fn(),
  listWorkflows: vi.fn(() => []),
};

const mockTaskManager = {
  startTask: vi.fn(),
};

const mockLogger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};
mockLogger.child = vi.fn(() => mockLogger);

let uuidCounter = 0;
const mockUuid = {
  v4: vi.fn(() => `test-uuid-${++uuidCounter}`),
};

// --- Helpers ---

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore unloaded modules
    }
  }
}

function loadHandlers() {
  clearLoadedModules();
  uuidCounter = 0;
  mockTaskCore.createTask.mockClear();
  mockTaskCore.getTask.mockClear();
  mockTaskCore.updateTaskStatus.mockClear();
  mockWorkflowEngine.createWorkflow.mockClear();
  mockWorkflowEngine.addTaskDependency.mockClear();
  mockWorkflowEngine.updateWorkflow.mockClear();
  mockWorkflowEngine.updateWorkflowCounts.mockClear();
  mockWorkflowEngine.getWorkflow.mockClear();
  mockWorkflowEngine.listWorkflows.mockClear().mockReturnValue([]);
  mockTaskManager.startTask.mockClear();

  installCjsModuleMock('../db/task-core', mockTaskCore);
  installCjsModuleMock('../db/workflow-engine', mockWorkflowEngine);
  installCjsModuleMock('../task-manager', mockTaskManager);
  installCjsModuleMock('../logger', mockLogger);
  installCjsModuleMock('uuid', mockUuid);

  return require(HANDLER_MODULE);
}

// --- Tests ---

describe('handleSubmitScout', () => {
  let handlers;
  beforeEach(() => { handlers = loadHandlers(); });

  it('rejects when scope is missing', () => {
    const result = handlers.handleSubmitScout({ working_directory: '/proj' });
    expect(result.isError).toBe(true);
  });

  it('rejects when working_directory is missing', () => {
    const result = handlers.handleSubmitScout({ scope: 'analyze tests' });
    expect(result.isError).toBe(true);
  });

  it('rejects non-filesystem providers', () => {
    const result = handlers.handleSubmitScout({
      scope: 'analyze', working_directory: '/proj', provider: 'deepinfra',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('filesystem');
  });

  it('accepts codex provider', () => {
    const result = handlers.handleSubmitScout({
      scope: 'analyze tests', working_directory: '/proj', provider: 'codex',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Scout Task Submitted');
  });
});

describe('handleCreateDiffusionPlan', () => {
  let handlers;
  beforeEach(() => { handlers = loadHandlers(); });

  it('rejects invalid plan JSON', () => {
    const result = handlers.handleCreateDiffusionPlan({
      plan: { summary: '' },
      working_directory: '/proj',
    });
    expect(result.isError).toBe(true);
  });

  it('creates a workflow from a valid plan', () => {
    const plan = {
      summary: 'Migrate files',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 2 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }, { file: 'b.js', pattern: 'p1' }],
      shared_dependencies: [],
      estimated_subtasks: 2,
      isolation_confidence: 0.95,
    };
    const result = handlers.handleCreateDiffusionPlan({ plan, working_directory: '/proj' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Workflow ID');
  });
});

describe('handleDiffusionStatus', () => {
  let handlers;
  beforeEach(() => { handlers = loadHandlers(); });

  it('returns status without errors', () => {
    const result = handlers.handleDiffusionStatus({});
    expect(result.isError).toBeFalsy();
  });
});
