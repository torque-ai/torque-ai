// server/tests/diffusion-handlers.test.js
'use strict';

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

  it('tags starvation recovery scouts with project context', () => {
    const result = handlers.handleSubmitScout({
      scope: 'Factory starvation recovery scout.',
      working_directory: '/proj',
      provider: 'codex',
      reason: 'factory_starvation_recovery',
      project_id: 'project-1',
    });

    expect(result.isError).toBeFalsy();
    expect(mockTaskCore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      tags: expect.arrayContaining([
        'factory:scout',
        'factory:reason=factory_starvation_recovery',
        'factory:project_id=project-1',
        'factory:starvation_recovery',
      ]),
    }));
  });
});

describe('handleCreateDiffusionPlan', () => {
  let handlers;
  beforeEach(() => { handlers = loadHandlers(); });

  it('rejects invalid plan JSON', () => {
    const result = handlers.handleCreateDiffusionPlan({
      plan: { summary: '' },
      working_directory: '/proj',
      verify_command: 'echo ok',
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
    const result = handlers.handleCreateDiffusionPlan({ plan, working_directory: '/proj', verify_command: 'echo ok' });
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

describe('full pipeline: scout output → create_diffusion_plan → workflow', () => {
  let handlers;
  beforeEach(() => { handlers = loadHandlers(); });

  it('creates a valid workflow from a scout-produced plan', () => {
    const scoutOutput = {
      summary: 'Migrate 15 test files from direct DB import to DI container',
      patterns: [
        {
          id: 'direct-db-import',
          description: 'Files using require("../database") directly',
          transformation: 'Replace with container.get("taskCore")',
          exemplar_files: ['server/tests/task-manager.test.js'],
          exemplar_diff: '- const db = require("../database");\n+ const { taskCore } = container;',
          file_count: 15,
        },
      ],
      manifest: Array.from({ length: 15 }, (_, i) => ({
        file: `server/tests/test-${i}.test.js`,
        pattern: 'direct-db-import',
      })),
      shared_dependencies: [],
      estimated_subtasks: 15,
      isolation_confidence: 0.95,
      recommended_batch_size: 3,
    };

    const result = handlers.handleCreateDiffusionPlan({
      plan: scoutOutput,
      working_directory: '/project',
      batch_size: 3,
      verify_command: 'echo ok',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Workflow ID');
    expect(result.content[0].text).toContain('optimistic');
    expect(result.content[0].text).toContain('Fan-out tasks');
  });

  it('creates DAG workflow when shared dependencies exist', () => {
    const plan = {
      summary: 'Refactor handlers to use new base class',
      patterns: [
        {
          id: 'handler-refactor',
          description: 'Handler files extending old BaseHandler',
          transformation: 'Extend NewBaseHandler instead',
          exemplar_files: ['server/handlers/task.js'],
          exemplar_diff: '- class TaskHandler extends BaseHandler\n+ class TaskHandler extends NewBaseHandler',
          file_count: 8,
        },
      ],
      manifest: Array.from({ length: 8 }, (_, i) => ({
        file: `server/handlers/handler-${i}.js`,
        pattern: 'handler-refactor',
      })),
      shared_dependencies: [
        { file: 'server/handlers/new-base-handler.js', change: 'Create the new base handler class' },
      ],
      estimated_subtasks: 9,
      isolation_confidence: 0.4,
    };

    const result = handlers.handleCreateDiffusionPlan({
      plan,
      working_directory: '/project',
      verify_command: 'echo ok',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('dag');
    expect(result.content[0].text).toContain('Anchor tasks');
  });
});

describe('compute→apply pipeline', () => {
  let handlers;
  beforeEach(() => { handlers = loadHandlers(); });

  it('passes compute_provider to buildWorkflowTasks', () => {
    const plan = {
      summary: 'Test',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = handlers.handleCreateDiffusionPlan({
      plan,
      working_directory: '/proj',
      verify_command: 'echo ok',
      compute_provider: 'cerebras',
      apply_provider: 'ollama',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Workflow ID');
  });
});

describe('mandatory verify_command', () => {
  let handlers;
  beforeEach(() => { handlers = loadHandlers(); });

  it('rejects create_diffusion_plan without verify_command', () => {
    const plan = {
      summary: 'Test',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = handlers.handleCreateDiffusionPlan({
      plan,
      working_directory: '/proj',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('verify_command');
  });

  it('accepts create_diffusion_plan with explicit verify_command', () => {
    const plan = {
      summary: 'Test',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = handlers.handleCreateDiffusionPlan({
      plan,
      working_directory: '/proj',
      verify_command: 'dotnet build',
    });
    expect(result.isError).toBeFalsy();
  });
});
