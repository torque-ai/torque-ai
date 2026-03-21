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

    it('Phase 1 declares exactly 8 schemas', () => {
      const expected = [
        'check_status', 'task_info', 'list_tasks', 'get_result',
        'get_progress', 'workflow_status', 'list_workflows', 'list_ollama_hosts',
      ];
      for (const name of expected) {
        expect(getOutputSchema(name)).toBeDefined();
      }
      expect(Object.keys(OUTPUT_SCHEMAS).length).toBe(8);
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
});
