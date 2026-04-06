const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const _path = require('path');
const os = require('os');
const { TEST_MODELS } = require('./test-helpers');

describe('Per-Step Provider Routing', () => {
  let db;

  beforeAll(() => {
    const env = setupTestDb('step-providers');
    db = env.db;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: extract workflow ID from create_feature_workflow output
  function extractWorkflowId(text) {
    const m = text.match(/\*\*ID:\*\*\s*([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  describe('add_workflow_task', () => {
    let workflowId;

    beforeAll(async () => {
      workflowId = randomUUID();
      db.createWorkflow({
        id: workflowId,
        name: 'provider-test-wf'
      });
    });

    it('stores provider when specified', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        task_description: 'test task with provider',
        node_id: 'node-with-provider',
        provider: 'ollama',
        working_directory: os.tmpdir(),
      });
      expect(result.isError).toBeFalsy();

      // Verify in DB
      const tasks = db.getWorkflowTasks(workflowId);
      const task = tasks.find(t => t.workflow_node_id === 'node-with-provider');
      expect(task).toBeDefined();
      expect(task.provider).toBe('ollama');
    });

    it('stores model when specified', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        task_description: 'test task with model',
        node_id: 'node-with-model',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        working_directory: os.tmpdir(),
      });
      expect(result.isError).toBeFalsy();

      const tasks = db.getWorkflowTasks(workflowId);
      const task = tasks.find(t => t.workflow_node_id === 'node-with-model');
      expect(task).toBeDefined();
      expect(task.provider).toBe('ollama');
      expect(task.model).toBe(TEST_MODELS.DEFAULT);
    });

    it('defaults to null (deferred) when provider omitted', async () => {
      const result = await safeTool('add_workflow_task', {
        workflow_id: workflowId,
        task_description: 'test task no provider',
        node_id: 'node-no-provider',
        working_directory: os.tmpdir(),
      });
      expect(result.isError).toBeFalsy();

      const tasks = db.getWorkflowTasks(workflowId);
      const task = tasks.find(t => t.workflow_node_id === 'node-no-provider');
      expect(task).toBeDefined();
      // Provider is now deferred (null) — assigned at slot-claim time
      expect(task.provider).toBeNull();
    });
  });

  describe('create_feature_workflow', () => {
    it('assigns per-step providers from step_providers', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'StepTest',
        working_directory: os.tmpdir(),
        types_task: 'Create types',
        events_task: 'Add events',
        data_task: 'Create data',
        system_task: 'Build system',
        tests_task: 'Write tests',
        wire_task: 'Wire system',
        step_providers: {
          types: 'ollama',
          events: 'ollama',
          data: 'ollama',
          system: 'codex',
          tests: 'ollama',
          wire: 'ollama',
        },
      });
      expect(result.isError).toBeFalsy();

      const text = getText(result);
      const wfId = extractWorkflowId(text);
      expect(wfId).toBeTruthy();

      const tasks = db.getWorkflowTasks(wfId);
      const byNode = {};
      for (const t of tasks) {
        if (t.workflow_node_id) byNode[t.workflow_node_id] = t;
      }

      expect(byNode['step-test-types'].provider).toBe('ollama');
      expect(byNode['step-test-events'].provider).toBe('ollama');
      expect(byNode['step-test-data'].provider).toBe('ollama');
      expect(byNode['step-test-system'].provider).toBe('codex');
      expect(byNode['step-test-tests'].provider).toBe('ollama');
      expect(byNode['step-test-wire'].provider).toBe('ollama');
    });

    it('falls through to codex when step not in step_providers', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'FallbackTest',
        working_directory: os.tmpdir(),
        types_task: 'Create types',
        system_task: 'Build system',
        step_providers: {
          system: 'claude-cli',
        },
      });
      expect(result.isError).toBeFalsy();

      const wfId = extractWorkflowId(getText(result));
      const tasks = db.getWorkflowTasks(wfId);
      const byNode = {};
      for (const t of tasks) {
        if (t.workflow_node_id) byNode[t.workflow_node_id] = t;
      }

      // types has no step_providers entry → provider is null (deferred assignment)
      expect(byNode['fallback-test-types'].provider).toBeNull();
      // system was explicitly set
      expect(byNode['fallback-test-system'].provider).toBe('claude-cli');
    });

    it('stores workflow_node_id correctly (bug fix)', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'NodeIdTest',
        working_directory: os.tmpdir(),
        types_task: 'Create types',
        events_task: 'Add events',
      });
      expect(result.isError).toBeFalsy();

      const wfId = extractWorkflowId(getText(result));
      const tasks = db.getWorkflowTasks(wfId);

      // All tasks should have workflow_node_id populated
      for (const t of tasks) {
        expect(t.workflow_node_id).toBeTruthy();
      }
      expect(tasks.some(t => t.workflow_node_id === 'node-id-test-types')).toBe(true);
      expect(tasks.some(t => t.workflow_node_id === 'node-id-test-events')).toBe(true);
    });

    it('parallel_tasks accept per-task provider', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'ParallelProvTest',
        working_directory: os.tmpdir(),
        types_task: 'Create types',
        parallel_tasks: [
          { task: 'Test A', node_id: 'test-a', provider: 'claude-cli' },
          { task: 'Test B', node_id: 'test-b' },  // should fall back to stepProviders.parallel
        ],
        step_providers: {
          parallel: 'ollama',
        },
      });
      expect(result.isError).toBeFalsy();

      const wfId = extractWorkflowId(getText(result));
      const tasks = db.getWorkflowTasks(wfId);
      const byNode = {};
      for (const t of tasks) {
        if (t.workflow_node_id) byNode[t.workflow_node_id] = t;
      }

      expect(byNode['test-a'].provider).toBe('claude-cli');
      expect(byNode['test-b'].provider).toBe('ollama');
    });

    it('shows provider column in DAG output', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'DagOutput',
        working_directory: os.tmpdir(),
        types_task: 'Create types',
        step_providers: { types: 'ollama' },
      });
      const text = getText(result);
      expect(text).toContain('| Node | Step | Provider | Status |');
      expect(text).toContain('ollama');
    });
  });

  describe('backward compatibility', () => {
    it('omitting step_providers uses deferred provider assignment', async () => {
      const result = await safeTool('create_feature_workflow', {
        feature_name: 'BackCompat',
        working_directory: os.tmpdir(),
        types_task: 'Create types',
        data_task: 'Create data',
        system_task: 'Build system',
      });
      expect(result.isError).toBeFalsy();

      const wfId = extractWorkflowId(getText(result));
      const tasks = db.getWorkflowTasks(wfId);

      // All should have null provider (deferred assignment)
      for (const t of tasks) {
        expect(t.provider).toBeNull();
      }
    });
  });
});
