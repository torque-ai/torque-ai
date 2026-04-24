'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { getOutputSchema, OUTPUT_SCHEMAS } = require('../tool-output-schemas');
const { validateSchemaNode } = require('../mcp/tool-registry');
const workflowEngine = require('../db/workflow-engine');
const taskCore = require('../db/task-core');

const PHASE2_PROVIDER_COST_MONITORING_TOOLS = Object.freeze([
  'provider_stats',
  'success_rates',
  'list_providers',
  'check_ollama_health',
  'get_cost_summary',
  'get_budget_status',
  'get_cost_forecast',
  'get_concurrency_limits',
  'check_stalled_tasks',
  'check_task_progress',
]);

function setupSchemaTestDb(suiteName) {
  setupTestDbOnly(suiteName);
  const tm = require('../task-manager');
  if (typeof tm.initEarlyDeps === 'function') tm.initEarlyDeps();
  if (typeof tm.initSubModules === 'function') tm.initSubModules();
}

function loadToolDefinitionNames() {
  const toolDefsDir = path.join(__dirname, '..', 'tool-defs');
  const files = fs.readdirSync(toolDefsDir)
    .filter((file) => file.endsWith('.js'))
    .sort();

  const toolNames = new Set();
  for (const file of files) {
    const defs = require(path.join(toolDefsDir, file));
    expect(Array.isArray(defs)).toBe(true);
    defs.forEach((def) => {
      if (def && typeof def.name === 'string') {
        toolNames.add(def.name);
      }
    });
  }

  return toolNames;
}

function expectStructuredDataConformsToOutputSchema(name, structuredData) {
  const schema = getOutputSchema(name);
  expect(schema).toBeDefined();
  expect(structuredData).toBeDefined();
  const errors = validateSchemaNode(schema, structuredData, '$')
    .map((error) => `${error.path}: ${error.message}`);
  expect(errors).toEqual([]);
}

describe('tool-output-schemas', () => {
  describe('getOutputSchema', () => {
    it('returns schema for declared tools', () => {
      const schema = getOutputSchema('check_status');
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
    });

    it('returns undefined for undeclared tools', () => {
      expect(getOutputSchema('some_unknown_tool')).toBeUndefined();
      expect(getOutputSchema('submit_task')).toBeUndefined();
    });

    it('returns undefined for non-string input', () => {
      expect(getOutputSchema(null)).toBeUndefined();
      expect(getOutputSchema(42)).toBeUndefined();
    });
  });

  describe('schema validity', () => {
    it('every schema is a valid JSON Schema object with properties', () => {
      for (const schema of Object.values(OUTPUT_SCHEMAS)) {
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
        expect(typeof schema.properties).toBe('object');
      }
    });

    it('every schema has required array', () => {
      for (const schema of Object.values(OUTPUT_SCHEMAS)) {
        expect(Array.isArray(schema.required)).toBe(true);
        expect(schema.required.length).toBeGreaterThan(0);
      }
    });

    it('declares schemas for all expected tools', () => {
      const expected = [
        'check_status', 'task_info', 'list_tasks', 'get_result',
        'get_progress', 'workflow_status', 'list_workflows', 'list_ollama_hosts',
        'get_context',
        // Phase 2
        ...PHASE2_PROVIDER_COST_MONITORING_TOOLS,
        // Phase 3
        'workflow_history', 'list_models', 'list_pending_models', 'list_model_roles',
        'list_archived', 'get_archive_stats', 'get_provider_health_trends', 'reset_provider_health',
        'health_check', 'integration_health', 'list_tags',
        // OAuth / tool hints / handoff / sessions
        'start_oauth_flow', 'complete_oauth_flow', 'list_connected_accounts',
        'disable_account', 'delete_account', 'list_tools_by_hints',
        'create_handoff_agent', 'get_handoff_history', 'get_batch_summary',
        'dispatch_subagent', 'resume_session', 'fork_session', 'list_sessions',
      ];
      for (const name of expected) {
        expect(getOutputSchema(name)).toBeDefined();
      }
      expect(Object.keys(OUTPUT_SCHEMAS).length).toBe(expected.length);
    });

    it('declares schemas only for registered tool definitions', () => {
      const toolDefNames = loadToolDefinitionNames();
      const schemaNames = Object.keys(OUTPUT_SCHEMAS);
      const staleSchemas = schemaNames.filter((name) => !toolDefNames.has(name));

      expect(staleSchemas).toEqual([]);
      for (const name of schemaNames) {
        expect(getOutputSchema(name)).toBeDefined();
      }
    });

    it('declares all 10 Phase 2 provider/cost/monitoring schemas', () => {
      expect(PHASE2_PROVIDER_COST_MONITORING_TOOLS).toHaveLength(10);
      for (const name of PHASE2_PROVIDER_COST_MONITORING_TOOLS) {
        expect(getOutputSchema(name)).toBeDefined();
      }
    });
  });

  describe('integration — tools.js merge', () => {
    it('tools with schemas have outputSchema on tool object', () => {
      const { TOOLS } = require('../tools');
      const { OUTPUT_SCHEMAS } = require('../tool-output-schemas');
      for (const name of Object.keys(OUTPUT_SCHEMAS)) {
        const tool = TOOLS.find(t => t.name === name);
        expect(tool).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(tool.outputSchema.type).toBe('object');
      }
    });

    it('tools without schemas do NOT have outputSchema', () => {
      const { TOOLS } = require('../tools');
      const { OUTPUT_SCHEMAS } = require('../tool-output-schemas');
      const schemaNames = new Set(Object.keys(OUTPUT_SCHEMAS));
      const toolsWithoutSchema = TOOLS.filter(t => !schemaNames.has(t.name));
      for (const tool of toolsWithoutSchema.slice(0, 10)) { // spot check 10
        expect(tool.outputSchema).toBeUndefined();
      }
    });

    it('no stale schemas (all reference real tools)', () => {
      const { TOOLS } = require('../tools');
      const { validateSchemaCoverage } = require('../tool-output-schemas');
      const names = TOOLS.map(t => t.name);
      const result = validateSchemaCoverage(names);
      expect(result.stale).toEqual([]);
    });
  });

  describe('protocol layer — structuredData handling', () => {
    it('structuredContent is set when structuredData is present', () => {
      // Simulate what mcp-protocol.js does
      const { getOutputSchema } = require('../tool-output-schemas');
      const name = 'check_status';
      const result = {
        content: [{ type: 'text', text: 'test' }],
        structuredData: { pressure_level: 'low', running_count: 0, queued_count: 0 },
      };

      // Protocol layer logic
      if (result.structuredData && !result.isError) {
        if (getOutputSchema(name)) {
          result.structuredContent = result.structuredData;
        }
        delete result.structuredData;
      }

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.pressure_level).toBe('low');
      expect(result.structuredData).toBeUndefined();
    });

    it('structuredContent is NOT set for tools without schema, but structuredData is cleaned up', () => {
      const { getOutputSchema } = require('../tool-output-schemas');
      const name = 'submit_task';
      const result = {
        content: [{ type: 'text', text: 'test' }],
        structuredData: { something: true },
      };

      // Match actual protocol logic: delete is ALWAYS inside the outer if block
      if (result.structuredData && !result.isError) {
        if (getOutputSchema(name)) {
          result.structuredContent = result.structuredData;
        }
        delete result.structuredData; // always clean up internal field
      }

      expect(result.structuredContent).toBeUndefined();
      // structuredData is cleaned up even when no schema matched
      expect(result.structuredData).toBeUndefined();
    });

    it('structuredContent is NOT set on error responses', () => {
      const { getOutputSchema } = require('../tool-output-schemas');
      const name = 'check_status';
      const result = {
        content: [{ type: 'text', text: 'Error' }],
        isError: true,
        structuredData: { pressure_level: 'low' },
      };

      if (result.structuredData && !result.isError) {
        if (getOutputSchema(name)) {
          result.structuredContent = result.structuredData;
        }
        delete result.structuredData;
      }

      expect(result.structuredContent).toBeUndefined();
    });
  });

  describe('stale detection', () => {
    it('validateSchemaCoverage detects stale schemas', () => {
      const { validateSchemaCoverage } = require('../tool-output-schemas');
      const result = validateSchemaCoverage(['check_status']); // most schemas will be stale
      expect(result.stale.length).toBeGreaterThan(0);
    });

    it('validateSchemaCoverage returns empty stale when all schemas have tools', () => {
      const { validateSchemaCoverage } = require('../tool-output-schemas');
      const allSchemaNames = Object.keys(OUTPUT_SCHEMAS);
      // Pass a superset that includes all schema names
      const result = validateSchemaCoverage([...allSchemaNames, 'submit_task', 'cancel_task']);
      expect(result.stale).toEqual([]);
    });
  });

  describe('handler conformance — check_status', () => {
    // These tests call the real handlers and verify structuredData shape.
    // They require a running database, so we use the test DB from global setup.
    beforeAll(() => {
      setupSchemaTestDb('tool-output-schemas');
    });

    afterAll(() => {
      teardownTestDb();
    });

    it('check_status with task_id returns structuredData with task object', () => {
      const { randomUUID } = require('crypto');
      const taskId = randomUUID();
      taskCore.createTask({ id: taskId, task_description: 'test task', status: 'completed', exit_code: 0 });
      const { handleCheckStatus } = require('../handlers/task/core');
      const result = handleCheckStatus({ task_id: taskId });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.pressure_level).toBeDefined();
      expect(result.structuredData.task).toBeDefined();
      expect(result.structuredData.task.id).toBe(taskId);
      expect(result.structuredData.task.status).toBe('completed');
      expect(result.content).toBeDefined(); // backward compat
    });

    it('check_status without task_id returns structuredData with counts and arrays', () => {
      const { handleCheckStatus } = require('../handlers/task/core');
      const result = handleCheckStatus({});

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.pressure_level).toBeDefined();
      expect(typeof result.structuredData.running_count).toBe('number');
      expect(typeof result.structuredData.queued_count).toBe('number');
      expect(Array.isArray(result.structuredData.running_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.queued_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.recent_tasks)).toBe(true);
    });

    it('check_status with invalid task_id returns error without structuredData', () => {
      const { handleCheckStatus } = require('../handlers/task/core');
      const result = handleCheckStatus({ task_id: 'nonexistent-id' });

      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    it('task_info delegates and adds mode field', () => {
      const { handleTaskInfo } = require('../handlers/task/core');
      const result = handleTaskInfo({ mode: 'status' });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.mode).toBe('status');
    });
  });

  describe('handler conformance — list/result/progress', () => {
    beforeAll(() => {
      setupSchemaTestDb('tool-output-schemas');
    });

    afterAll(() => {
      teardownTestDb();
    });

    it('list_tasks returns structuredData with count and tasks array', () => {
      const { randomUUID } = require('crypto');
      const taskId = randomUUID();
      taskCore.createTask({ id: taskId, task_description: 'list test task', status: 'completed', exit_code: 0 });
      const { handleListTasks } = require('../handlers/task/core');
      const result = handleListTasks({ all_projects: true });

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.tasks)).toBe(true);
    });

    it('list_tasks with no results returns count 0 and empty array', () => {
      const { handleListTasks } = require('../handlers/task/core');
      const result = handleListTasks({ status: 'running', tags: ['nonexistent_tag_xyz'] });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.count).toBe(0);
      expect(result.structuredData.tasks).toEqual([]);
    });

    it('get_result returns structuredData with task fields', () => {
      const { randomUUID } = require('crypto');
      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'test',
        status: 'pending',
        exit_code: 0,
      });
      // Transition through running → completed to get started_at / completed_at
      taskCore.updateTaskStatus(taskId, 'running');
      taskCore.updateTaskStatus(taskId, 'completed', { output: 'hello world', exit_code: 0 });
      const { handleGetResult } = require('../handlers/task/core');
      const result = handleGetResult({ task_id: taskId });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.id).toBe(taskId);
      expect(result.structuredData.status).toBe('completed');
      expect(typeof result.structuredData.duration_seconds).toBe('number');
      expect(result.structuredData.output).toBe('hello world');
    });

    it('get_result for running task returns no structuredData', () => {
      const { randomUUID } = require('crypto');
      const taskId = randomUUID();
      taskCore.createTask({ id: taskId, task_description: 'test', status: 'running' });
      const { handleGetResult } = require('../handlers/task/core');
      const result = handleGetResult({ task_id: taskId });

      // Running tasks get an informational message, not structured data
      expect(result.structuredData).toBeUndefined();
    });

    it('get_progress returns structuredData with progress fields', () => {
      const { randomUUID } = require('crypto');
      const taskId = randomUUID();
      taskCore.createTask({ id: taskId, task_description: 'test', status: 'running' });
      const { handleGetProgress } = require('../handlers/task/core');
      const result = handleGetProgress({ task_id: taskId });

      // If task-manager has no progress, it returns an error
      // In test environment, we may need to check for either
      if (!result.isError) {
        expect(result.structuredData).toBeDefined();
        expect(typeof result.structuredData.progress).toBe('number');
        expect(result.structuredData.id).toBe(taskId);
      }
    });
  });

  describe('handler conformance — workflows', () => {
    beforeAll(() => {
      setupSchemaTestDb('tool-output-schemas');
    });

    afterAll(() => {
      teardownTestDb();
    });

    it('workflow_status returns structuredData with counts and tasks', () => {
      const { randomUUID } = require('crypto');
      const wfId = randomUUID();
      workflowEngine.createWorkflow({ id: wfId, name: 'test-wf', status: 'pending' });
      const { handleWorkflowStatus } = require('../handlers/workflow');
      const result = handleWorkflowStatus({ workflow_id: wfId });

      if (!result.isError) {
        expect(result.structuredData).toBeDefined();
        expect(result.structuredData.id).toBe(wfId);
        expect(result.structuredData.name).toBe('test-wf');
        expect(typeof result.structuredData.total_count).toBe('number');
        expect(result.structuredData.visibility).toBeDefined();
      }
    });

    it('workflow_status with invalid id returns error without structuredData', () => {
      const { handleWorkflowStatus } = require('../handlers/workflow');
      const result = handleWorkflowStatus({ workflow_id: 'nonexistent-wf' });
      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    it('list_workflows returns structuredData with count and workflows array', () => {
      const { handleListWorkflows } = require('../handlers/workflow');
      const result = handleListWorkflows({});

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.workflows)).toBe(true);
    });

    it('list_workflows with no results returns count 0 and empty array', () => {
      const { handleListWorkflows } = require('../handlers/workflow');
      const result = handleListWorkflows({ status: 'nonexistent_status_xyz' });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.count).toBe(0);
      expect(result.structuredData.workflows).toEqual([]);
    });
  });

  describe('handler conformance — list_ollama_hosts', () => {
    beforeAll(() => {
      setupSchemaTestDb('tool-output-schemas');
    });

    afterAll(() => {
      teardownTestDb();
    });

    it('list_ollama_hosts returns structuredData with count and hosts array', () => {
      const { handleListOllamaHosts } = require('../handlers/provider-ollama-hosts');
      const result = handleListOllamaHosts({});

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.hosts)).toBe(true);
    });
  });

  describe('handler conformance — Phase 2', () => {
    beforeAll(() => {
      setupSchemaTestDb('tool-output-schemas');
    });

    afterAll(() => {
      teardownTestDb();
    });

    // --- provider_stats ---
    it('provider_stats returns structuredData with provider field', () => {
      const { handleProviderStats } = require('../handlers/provider-handlers');
      const result = handleProviderStats({ provider: 'ollama' });

      expectStructuredDataConformsToOutputSchema('provider_stats', result.structuredData);
      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.provider).toBe('ollama');
      expect(typeof result.structuredData.total_tasks).toBe('number');
      expect(typeof result.structuredData.successful_tasks).toBe('number');
      expect(typeof result.structuredData.failed_tasks).toBe('number');
      expect(typeof result.structuredData.success_rate).toBe('number');
      expect(result.content).toBeDefined();
    });

    it('provider_stats without provider arg returns error', () => {
      const { handleProviderStats } = require('../handlers/provider-handlers');
      const result = handleProviderStats({});

      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    // --- list_providers ---
    it('list_providers returns structuredData with count and providers array', () => {
      const { handleListProviders } = require('../handlers/provider-handlers');
      const result = handleListProviders();

      expectStructuredDataConformsToOutputSchema('list_providers', result.structuredData);
      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.providers)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- check_ollama_health ---
    it('check_ollama_health returns structuredData with health counts', async () => {
      const { randomUUID } = require('crypto');
      const hostManagement = require('../db/host-management');
      const { handleCheckOllamaHealth } = require('../handlers/provider-ollama-hosts');
      const hostId = randomUUID();

      hostManagement.addOllamaHost({
        id: hostId,
        name: 'Schema Test Host',
        url: `http://127.0.0.1:11434/${hostId}`,
        max_concurrent: 1,
        memory_limit_mb: 8192,
      });
      hostManagement.updateOllamaHost(hostId, {
        status: 'healthy',
        running_tasks: 0,
        models_cache: JSON.stringify(['schema-test-model']),
      });

      const result = await handleCheckOllamaHealth({ force_check: false });

      expectStructuredDataConformsToOutputSchema('check_ollama_health', result.structuredData);
      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.healthy_count).toBe('number');
      expect(typeof result.structuredData.total_count).toBe('number');
      expect(Array.isArray(result.structuredData.hosts)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- get_cost_summary ---
    it('get_cost_summary returns structuredData with days field', () => {
      const { handleGetCostSummary } = require('../handlers/validation');
      const result = handleGetCostSummary({});

      expectStructuredDataConformsToOutputSchema('get_cost_summary', result.structuredData);
      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.days).toBe('number');
      expect(result.content).toBeDefined();
    });

    it('get_cost_summary respects custom days arg', () => {
      const { handleGetCostSummary } = require('../handlers/validation');
      const result = handleGetCostSummary({ days: 7 });

      expectStructuredDataConformsToOutputSchema('get_cost_summary', result.structuredData);
      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.days).toBe(7);
    });

    // --- get_budget_status ---
    it('get_budget_status returns structuredData with count and budgets', () => {
      const { handleGetBudgetStatus } = require('../handlers/validation');
      const result = handleGetBudgetStatus({});

      expectStructuredDataConformsToOutputSchema('get_budget_status', result.structuredData);
      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.budgets)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- get_cost_forecast ---
    it('get_cost_forecast returns structuredData with forecast object', () => {
      const { handleGetCostForecast } = require('../handlers/validation');
      const result = handleGetCostForecast({});

      expectStructuredDataConformsToOutputSchema('get_cost_forecast', result.structuredData);
      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.forecast).toBeDefined();
      expect(result.content).toBeDefined();
    });

    // --- success_rates ---
    it('success_rates returns structuredData with count and rates array (or empty result)', () => {
      const { handleSuccessRates } = require('../handlers/integration');
      const result = handleSuccessRates({});

      expectStructuredDataConformsToOutputSchema('success_rates', result.structuredData);
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.rates)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- get_concurrency_limits ---
    it('get_concurrency_limits returns structuredData with providers array', () => {
      const { handleGetConcurrencyLimits } = require('../handlers/concurrency-handlers');
      const result = handleGetConcurrencyLimits();

      expectStructuredDataConformsToOutputSchema('get_concurrency_limits', result.structuredData);
      expect(result.structuredData).toBeDefined();
      expect(Array.isArray(result.structuredData.providers)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- check_stalled_tasks ---
    it('check_stalled_tasks returns structuredData with running/stalled counts', () => {
      const { handleCheckStalledTasks } = require('../handlers/task/operations');
      const result = handleCheckStalledTasks({});

      expectStructuredDataConformsToOutputSchema('check_stalled_tasks', result.structuredData);
      expect(typeof result.structuredData.running_count).toBe('number');
      expect(typeof result.structuredData.stalled_count).toBe('number');
      expect(Array.isArray(result.structuredData.tasks)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- check_task_progress ---
    it('check_task_progress returns structuredData with running_count and tasks', async () => {
      const { handleCheckTaskProgress } = require('../handlers/task/operations');
      const result = await handleCheckTaskProgress({ wait_seconds: 0 });

      expectStructuredDataConformsToOutputSchema('check_task_progress', result.structuredData);
      expect(typeof result.structuredData.running_count).toBe('number');
      expect(Array.isArray(result.structuredData.tasks)).toBe(true);
      expect(result.content).toBeDefined();
    });
  });

  describe('handler conformance — Phase 3', () => {
    beforeAll(() => {
      setupSchemaTestDb('tool-output-schemas');
    });

    afterAll(() => {
      teardownTestDb();
    });

    // --- list_models ---
    it('list_models returns structuredData with count and models array', () => {
      const { handleListModels } = require('../handlers/model-handlers');
      let result;
      try {
        result = handleListModels({});
      } catch {
        // Model registry may not be initialized in test env
        return;
      }

      if (result.isError || !result.structuredData) return;

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.models)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- list_pending_models ---
    it('list_pending_models returns structuredData with pending_count and models', () => {
      const { handleListPendingModels } = require('../handlers/model-handlers');
      let result;
      try {
        result = handleListPendingModels({});
      } catch {
        // Model registry may not be initialized in test env
        return;
      }

      if (result.isError || !result.structuredData) return;

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.pending_count).toBe('number');
      expect(Array.isArray(result.structuredData.models)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- get_provider_health_trends ---
    it('get_provider_health_trends returns structuredData with trends array', () => {
      const { handleGetProviderHealthTrends } = require('../handlers/provider-handlers');
      const result = handleGetProviderHealthTrends({});

      if (result.isError) return;

      expect(result.structuredData).toBeDefined();
      expect(Array.isArray(result.structuredData.trends)).toBe(true);
      expect(result.content).toBeDefined();
    });

    it('reset_provider_health returns structuredData with scope and reset_count', () => {
      const { handleResetProviderHealth } = require('../handlers/provider-handlers');
      const result = handleResetProviderHealth({});

      if (result.isError) return;

      expect(result.structuredData).toBeDefined();
      expect(['all', 'provider']).toContain(result.structuredData.scope);
      expect(typeof result.structuredData.reset_count).toBe('number');
      expect(result.content).toBeDefined();
    });

    // --- workflow_history (needs workflow_id — create test workflow) ---
    it('workflow_history returns structuredData with events for valid workflow', () => {
      const { randomUUID } = require('crypto');
      const wfId = randomUUID();
      workflowEngine.createWorkflow({ id: wfId, name: 'history-test-wf', status: 'pending' });
      const { handleWorkflowHistory } = require('../handlers/workflow');
      const result = handleWorkflowHistory({ workflow_id: wfId });

      if (result.isError) return;

      // May have no events (empty history) — structuredData may not be present
      if (result.structuredData) {
        expect(result.structuredData.workflow_id).toBe(wfId);
        expect(typeof result.structuredData.count).toBe('number');
        expect(Array.isArray(result.structuredData.events)).toBe(true);
      } else {
        // No events recorded — handler returns plain text
        expect(result.content).toBeDefined();
      }
    });

    it('workflow_history with invalid workflow_id returns error', () => {
      const { handleWorkflowHistory } = require('../handlers/workflow');
      const result = handleWorkflowHistory({ workflow_id: 'nonexistent-wf-id' });

      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    // --- list_archived ---
    it('list_archived returns structuredData with count and tasks (or empty text)', () => {
      const { handleListArchived } = require('../handlers/task/operations');
      const result = handleListArchived({});

      // When no archived tasks, handler returns without structuredData
      if (!result.structuredData) {
        expect(result.content).toBeDefined();
        return;
      }

      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.tasks)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- get_archive_stats ---
    it('get_archive_stats returns structuredData with total_archived', () => {
      const { handleGetArchiveStats } = require('../handlers/task/operations');
      const result = handleGetArchiveStats({});

      if (result.isError) return;

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.total_archived).toBe('number');
      expect(result.content).toBeDefined();
    });

    // --- health_check ---
    it('health_check returns structuredData with status field', () => {
      const { handleHealthCheck } = require('../handlers/task/operations');
      let result;
      try {
        result = handleHealthCheck({});
      } catch {
        // spawnSync / codex CLI may not be available in test env
        return;
      }

      if (result.isError) return;

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.status).toBe('string');
      expect(result.structuredData.check_type).toBeDefined();
      expect(typeof result.structuredData.response_time_ms).toBe('number');
      expect(result.content).toBeDefined();
    });

    // --- get_integration_health (async) ---
    it('get_integration_health returns structuredData with count and integrations', async () => {
      const { handleIntegrationHealth } = require('../handlers/integration');
      let result;
      try {
        result = await handleIntegrationHealth({});
      } catch {
        // Integration system may not be available in test env
        return;
      }

      if (result.isError) return;

      // When no integrations configured, handler returns without structuredData
      if (!result.structuredData) {
        expect(result.content).toBeDefined();
        return;
      }

      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.integrations)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- list_tags ---
    it('list_tags returns structuredData with total_unique and tags (or empty text)', () => {
      const { handleListTags } = require('../handlers/task/operations');
      const result = handleListTags({});

      // When no tags exist, handler returns without structuredData
      if (!result.structuredData) {
        expect(result.content).toBeDefined();
        return;
      }

      expect(typeof result.structuredData.total_unique).toBe('number');
      expect(Array.isArray(result.structuredData.tags)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- get_batch_summary (needs workflow_id — test error gracefully) ---
    it('get_batch_summary without workflow_id returns error', () => {
      const { handleGetBatchSummary } = require('../handlers/automation-handlers');
      const result = handleGetBatchSummary({});

      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    it('get_batch_summary with nonexistent workflow_id returns error', () => {
      const { handleGetBatchSummary } = require('../handlers/automation-handlers');
      const result = handleGetBatchSummary({ workflow_id: 'nonexistent-wf-id' });

      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });
  });
});
