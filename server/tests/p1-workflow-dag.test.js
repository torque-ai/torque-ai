/**
 * P1 Batch 3 — Workflow DAG output injection fix
 *
 * #40  workflow-runtime.js  Output injection regex only matches \w+ — misses dashed node IDs
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

let workflowRuntime;

describe('P1 workflow DAG output injection', () => {
  beforeAll(() => {
    workflowRuntime = require('../execution/workflow-runtime');
  });

  describe('#40: Output injection supports dashed node IDs', () => {
    it('replaces {{step-1.output}} template vars with dashed node IDs', () => {
      const depTasks = {
        'step-1': { output: 'Hello from step-1', error_output: '', exit_code: 0 },
        'build-and-test': { output: 'All tests passed', error_output: '', exit_code: 0 },
      };

      const description = 'Prior output: {{step-1.output}} | Also: {{build-and-test.output}}';
      const result = workflowRuntime.injectDependencyOutputs(description, depTasks);

      expect(result).toBe('Prior output: Hello from step-1 | Also: All tests passed');
    });

    it('replaces {{node-id.exit_code}} for dashed node IDs', () => {
      const depTasks = {
        'lint-check': { output: '', error_output: 'lint failed', exit_code: 1 },
      };

      const description = 'Lint exit code: {{lint-check.exit_code}}, errors: {{lint-check.error_output}}';
      const result = workflowRuntime.injectDependencyOutputs(description, depTasks);

      expect(result).toBe('Lint exit code: 1, errors: lint failed');
    });

    it('still works for underscore node IDs (backward compat)', () => {
      const depTasks = {
        'step_1': { output: 'underscore works', error_output: '', exit_code: 0 },
      };

      const description = 'Result: {{step_1.output}}';
      const result = workflowRuntime.injectDependencyOutputs(description, depTasks);

      expect(result).toBe('Result: underscore works');
    });

    it('leaves unknown dashed node IDs as placeholders', () => {
      const depTasks = {};
      const description = 'Missing: {{no-such-node.output}}';
      const result = workflowRuntime.injectDependencyOutputs(description, depTasks);

      expect(result).toContain("[ERROR: output unavailable from node 'no-such-node'");
    });

    it('handles UUID-style node IDs with hyphens', () => {
      const depTasks = {
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890': { output: 'UUID result', error_output: '', exit_code: 0 },
      };

      const description = 'Got: {{a1b2c3d4-e5f6-7890-abcd-ef1234567890.output}}';
      const result = workflowRuntime.injectDependencyOutputs(description, depTasks);

      expect(result).toBe('Got: UUID result');
    });
  });
});
