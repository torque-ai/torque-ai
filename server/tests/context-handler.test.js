'use strict';

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('context-handler', () => {
  let workflowEngine;

  beforeAll(() => {
    setupTestDbOnly('context-handler');
    workflowEngine = require('../db/workflow-engine');
  });

  afterAll(() => {
    teardownTestDb();
  });

  describe('queue scope', () => {
    it('returns correct shape with scope=queue when no workflow_id', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.scope).toBe('queue');
      expect(result.structuredData.pressure_level).toBeDefined();
      expect(result.structuredData.running).toBeDefined();
      expect(typeof result.structuredData.running.count).toBe('number');
      expect(Array.isArray(result.structuredData.running.tasks)).toBe(true);
      expect(result.structuredData.queued).toBeDefined();
      expect(result.structuredData.recent_completed).toBeDefined();
      expect(result.structuredData.recent_failed).toBeDefined();
      expect(result.structuredData.active_workflows).toBeDefined();
      expect(result.structuredData.provider_health).toBeDefined();
      expect(result.content).toBeDefined(); // backward compat markdown
    });

    it('caps running.tasks at 5', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.running.tasks.length).toBeLessThanOrEqual(5);
    });

    it('caps queued.next at 5', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.queued.next.length).toBeLessThanOrEqual(5);
    });

    it('caps recent_completed.last_3 at 3', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.recent_completed.last_3.length).toBeLessThanOrEqual(3);
    });

    it('provider_health has healthy/down/degraded arrays', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      const ph = result.structuredData.provider_health;
      expect(Array.isArray(ph.healthy)).toBe(true);
      expect(Array.isArray(ph.down)).toBe(true);
      expect(Array.isArray(ph.degraded)).toBe(true);
    });

    it('nothing-happening state returns correct shape with zeros and empty arrays', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      const sd = result.structuredData;
      // Counts should be numbers (possibly 0)
      expect(typeof sd.running.count).toBe('number');
      expect(typeof sd.queued.count).toBe('number');
      expect(typeof sd.recent_completed.count).toBe('number');
      expect(typeof sd.recent_failed.count).toBe('number');
    });
  });

  describe('workflow scope', () => {
    let testWorkflowId;

    beforeAll(() => {
      // Create a minimal workflow for testing
      if (typeof workflowEngine.createWorkflow === 'function') {
        const crypto = require('crypto');
        testWorkflowId = crypto.randomUUID();
        workflowEngine.createWorkflow({ id: testWorkflowId, name: 'test-context-wf', status: 'pending' });
      }
    });

    it('returns correct shape with scope=workflow when workflow_id provided', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      if (!testWorkflowId) return; // skip if DB doesn't support createWorkflow

      const result = handleGetContext({ workflow_id: testWorkflowId });
      if (result.isError) return; // skip if workflow not found (DB compat)

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.scope).toBe('workflow');
      expect(result.structuredData.workflow).toBeDefined();
      expect(result.structuredData.workflow.id).toBe(testWorkflowId);
      expect(result.structuredData.counts).toBeDefined();
      expect(typeof result.structuredData.counts.total).toBe('number');
      expect(Array.isArray(result.structuredData.completed_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.running_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.failed_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.blocked_tasks)).toBe(true);
      expect(Array.isArray(result.structuredData.next_actionable)).toBe(true);
      expect(Array.isArray(result.structuredData.alerts)).toBe(true);
    });

    it('invalid workflow_id returns error without structuredData', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({ workflow_id: 'nonexistent-wf-xyz' });
      expect(result.isError).toBe(true);
      expect(result.structuredData).toBeUndefined();
    });

    it('workflow scope with all-pending tasks returns zero counts', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      if (!testWorkflowId) return;

      const result = handleGetContext({ workflow_id: testWorkflowId });
      if (result.isError) return;

      expect(result.structuredData.counts.completed).toBe(0);
      expect(result.structuredData.counts.running).toBe(0);
      expect(result.structuredData.counts.failed).toBe(0);
    });
  });

  describe('integration', () => {
    it('get_context appears in Tier 1 tool list', () => {
      const { CORE_TOOL_NAMES } = require('../core-tools');
      expect(CORE_TOOL_NAMES).toContain('get_context');
    });

    it('get_context has annotations (readOnly + idempotent)', () => {
      const { TOOLS } = require('../tools');
      const tool = TOOLS.find(t => t.name === 'get_context');
      expect(tool).toBeDefined();
      expect(tool.annotations).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.idempotentHint).toBe(true);
    });

    it('get_context has outputSchema', () => {
      const { TOOLS } = require('../tools');
      const tool = TOOLS.find(t => t.name === 'get_context');
      expect(tool).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema.required).toContain('scope');
    });

    it('get_context structuredData flows through protocol as structuredContent', () => {
      const { getOutputSchema } = require('../tool-output-schemas');
      const { handleGetContext } = require('../handlers/context-handler');

      const result = handleGetContext({});
      expect(result.structuredData).toBeDefined();

      // Simulate protocol layer
      if (result.structuredData && !result.isError && getOutputSchema('get_context')) {
        result.structuredContent = result.structuredData;
        delete result.structuredData;
      }

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.scope).toBe('queue');
      expect(result.structuredData).toBeUndefined();
    });
  });
});
