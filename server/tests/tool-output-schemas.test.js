'use strict';

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
});
