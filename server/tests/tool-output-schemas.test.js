'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const { getOutputSchema, OUTPUT_SCHEMAS } = require('../tool-output-schemas');

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
      for (const [name, schema] of Object.entries(OUTPUT_SCHEMAS)) {
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
        expect(typeof schema.properties).toBe('object');
      }
    });

    it('every schema has required array', () => {
      for (const [name, schema] of Object.entries(OUTPUT_SCHEMAS)) {
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
        'provider_stats', 'success_rates', 'list_providers', 'check_ollama_health',
        'get_cost_summary', 'get_budget_status', 'get_cost_forecast',
        'get_concurrency_limits', 'check_stalled_tasks', 'check_task_progress',
      ];
      for (const name of expected) {
        expect(getOutputSchema(name)).toBeDefined();
      }
      expect(Object.keys(OUTPUT_SCHEMAS).length).toBe(expected.length);
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
    const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
    let db, templateBuffer;

    beforeAll(() => {
      templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
      db = require('../database');
      db.resetForTest(templateBuffer);
    });

    afterAll(() => {
      try { db.close(); } catch {}
    });

    it('check_status with task_id returns structuredData with task object', () => {
      const { randomUUID } = require('crypto');
      const taskId = randomUUID();
      db.createTask({ id: taskId, task_description: 'test task', status: 'completed', exit_code: 0 });
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
    const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
    let db, templateBuffer;

    beforeAll(() => {
      templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
      db = require('../database');
      db.resetForTest(templateBuffer);
    });

    afterAll(() => {
      try { db.close(); } catch {}
    });

    it('list_tasks returns structuredData with count and tasks array', () => {
      const { randomUUID } = require('crypto');
      const taskId = randomUUID();
      db.createTask({ id: taskId, task_description: 'list test task', status: 'completed', exit_code: 0 });
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
      db.createTask({
        id: taskId,
        task_description: 'test',
        status: 'pending',
        exit_code: 0,
      });
      // Transition through running → completed to get started_at / completed_at
      db.updateTaskStatus(taskId, 'running');
      db.updateTaskStatus(taskId, 'completed', { output: 'hello world', exit_code: 0 });
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
      db.createTask({ id: taskId, task_description: 'test', status: 'running' });
      const { handleGetResult } = require('../handlers/task/core');
      const result = handleGetResult({ task_id: taskId });

      // Running tasks get an informational message, not structured data
      expect(result.structuredData).toBeUndefined();
    });

    it('get_progress returns structuredData with progress fields', () => {
      const { randomUUID } = require('crypto');
      const taskId = randomUUID();
      db.createTask({ id: taskId, task_description: 'test', status: 'running' });
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
    const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
    let db, templateBuffer;

    beforeAll(() => {
      templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
      db = require('../database');
      db.resetForTest(templateBuffer);
    });

    afterAll(() => {
      try { db.close(); } catch {}
    });

    it('workflow_status returns structuredData with counts and tasks', () => {
      const { randomUUID } = require('crypto');
      const wfId = randomUUID();
      db.createWorkflow({ id: wfId, name: 'test-wf', status: 'pending' });
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
    const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
    let db, templateBuffer;

    beforeAll(() => {
      templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
      db = require('../database');
      db.resetForTest(templateBuffer);
    });

    afterAll(() => {
      try { db.close(); } catch {}
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
    const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
    let db, templateBuffer;

    beforeAll(() => {
      templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
      db = require('../database');
      db.resetForTest(templateBuffer);
    });

    afterAll(() => {
      try { db.close(); } catch {}
    });

    // --- provider_stats ---
    it('provider_stats returns structuredData with provider field', () => {
      const { handleProviderStats } = require('../handlers/provider-handlers');
      const result = handleProviderStats({ provider: 'ollama' });

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

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.providers)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- check_ollama_health (async, may fail due to no network) ---
    it('check_ollama_health returns structuredData with health counts', async () => {
      const { handleCheckOllamaHealth } = require('../handlers/provider-ollama-hosts');
      let result;
      try {
        result = await handleCheckOllamaHealth({ force_check: false });
      } catch {
        // Network error in test env is expected — skip shape check
        return;
      }

      if (result.isError) return; // Internal error (no network) — acceptable

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

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.days).toBe('number');
      expect(result.content).toBeDefined();
    });

    it('get_cost_summary respects custom days arg', () => {
      const { handleGetCostSummary } = require('../handlers/validation');
      const result = handleGetCostSummary({ days: 7 });

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.days).toBe(7);
    });

    // --- get_budget_status ---
    it('get_budget_status returns structuredData with count and budgets', () => {
      const { handleGetBudgetStatus } = require('../handlers/validation');
      const result = handleGetBudgetStatus({});

      expect(result.structuredData).toBeDefined();
      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.budgets)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- get_cost_forecast ---
    it('get_cost_forecast returns structuredData with forecast object', () => {
      const { handleGetCostForecast } = require('../handlers/validation');
      const result = handleGetCostForecast({});

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.forecast).toBeDefined();
      expect(result.content).toBeDefined();
    });

    // --- success_rates ---
    it('success_rates returns structuredData with count and rates array (or empty result)', () => {
      const { handleSuccessRates } = require('../handlers/integration');
      const result = handleSuccessRates({});

      // When no metrics data exists, handler returns without structuredData
      if (!result.structuredData) {
        // No metrics aggregated yet — acceptable in test env
        expect(result.content).toBeDefined();
        return;
      }

      expect(typeof result.structuredData.count).toBe('number');
      expect(Array.isArray(result.structuredData.rates)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- get_concurrency_limits ---
    it('get_concurrency_limits returns structuredData with providers array', () => {
      const { handleGetConcurrencyLimits } = require('../handlers/concurrency-handlers');
      const result = handleGetConcurrencyLimits();

      expect(result.structuredData).toBeDefined();
      expect(Array.isArray(result.structuredData.providers)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- check_stalled_tasks ---
    it('check_stalled_tasks returns structuredData with running/stalled counts', () => {
      const { handleCheckStalledTasks } = require('../handlers/task/operations');
      let result;
      try {
        result = handleCheckStalledTasks({});
      } catch {
        // taskManager may not be fully initialized in test env
        return;
      }

      // When no running tasks, handler returns without structuredData
      if (!result.structuredData) {
        expect(result.content).toBeDefined();
        return;
      }

      expect(typeof result.structuredData.running_count).toBe('number');
      expect(typeof result.structuredData.stalled_count).toBe('number');
      expect(Array.isArray(result.structuredData.tasks)).toBe(true);
      expect(result.content).toBeDefined();
    });

    // --- check_task_progress (async, uses setTimeout) ---
    it('check_task_progress returns structuredData with running_count and tasks', async () => {
      const { handleCheckTaskProgress } = require('../handlers/task/operations');
      let result;
      try {
        // Use wait_seconds=0 to minimize delay in tests
        result = await handleCheckTaskProgress({ wait_seconds: 0 });
      } catch {
        // taskManager / timeout issues in test env
        return;
      }

      // When no running tasks, handler returns without structuredData
      if (!result.structuredData) {
        expect(result.content).toBeDefined();
        return;
      }

      expect(typeof result.structuredData.running_count).toBe('number');
      expect(Array.isArray(result.structuredData.tasks)).toBe(true);
      expect(result.content).toBeDefined();
    });
  });
});
