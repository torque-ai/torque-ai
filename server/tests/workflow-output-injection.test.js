const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let mod;

let startCalls;
let cancelCalls;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-wf-output-inj-${Date.now()}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  mod = require('../execution/workflow-runtime');
  initRuntime();
}

function initRuntime() {
  startCalls = [];
  cancelCalls = [];

  mod.init({
    db,
    startTask: (taskId) => {
      startCalls.push(taskId);
      return { status: 'running' };
    },
    cancelTask: (taskId, reason) => {
      cancelCalls.push({ taskId, reason });
      return { status: 'cancelled' };
    },
    processQueue: () => {},
    dashboard: {
      broadcast: () => {},
      notifyTaskUpdated: () => {},
      notifyWorkflowUpdated: () => {},
      notifyStatsUpdated: () => {},
    },
  });
}

function teardown() {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  if (testDir) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const payload = {
    task_description: overrides.task_description || `Task ${id.slice(0, 8)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'pending',
    provider: overrides.provider || 'codex',
    ...overrides,
    id,
  };
  db.createTask(payload);
  return id;
}

function createWorkflow(overrides = {}) {
  const id = overrides.id || randomUUID();
  db.createWorkflow({
    id,
    name: overrides.name || `wf-${id.slice(0, 8)}`,
    status: overrides.status || 'running',
    description: overrides.description || null,
  });
  return id;
}

function createWorkflowTask(workflowId, nodeId, status = 'blocked', overrides = {}) {
  return createTask({
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    status,
    ...overrides,
  });
}


describe('workflow-output-injection', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    initRuntime();
    db.setConfig('max_concurrent', '1000');
  });

  // =========================================================================
  // Unit tests: injectDependencyOutputs
  // =========================================================================
  describe('injectDependencyOutputs', () => {
    it('replaces {{node_id.output}} with dependency output', () => {
      const result = mod.injectDependencyOutputs(
        'Use this: {{step1.output}}',
        { step1: { output: 'hello world', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('Use this: hello world');
    });

    it('replaces {{node_id.error_output}} with dependency error_output', () => {
      const result = mod.injectDependencyOutputs(
        'Errors: {{build.error_output}}',
        { build: { output: '', error_output: 'compile failed', exit_code: 1 } }
      );
      expect(result).toContain('Errors: compile failed');
    });

    it('replaces {{node_id.exit_code}} with dependency exit_code', () => {
      const result = mod.injectDependencyOutputs(
        'Exit: {{build.exit_code}}',
        { build: { output: '', error_output: '', exit_code: 42 } }
      );
      expect(result).toContain('Exit: 42');
    });

    it('defaults exit_code to 0 when undefined', () => {
      const result = mod.injectDependencyOutputs(
        'Exit: {{step.exit_code}}',
        { step: { output: '', error_output: '' } }
      );
      expect(result).toContain('Exit: 0');
    });

    it('replaces multiple template variables from different deps', () => {
      const result = mod.injectDependencyOutputs(
        'A: {{a.output}}, B: {{b.output}}, A-code: {{a.exit_code}}',
        {
          a: { output: 'alpha', error_output: '', exit_code: 0 },
          b: { output: 'beta', error_output: '', exit_code: 1 },
        }
      );
      expect(result).toContain('A: alpha, B: beta, A-code: 0');
    });

    it('leaves placeholder when dependency is missing', () => {
      const result = mod.injectDependencyOutputs(
        'Got: {{missing_step.output}}',
        { other: { output: 'x', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain("[ERROR: output unavailable from node 'missing_step'");
    });

    it('caps output at 5KB', () => {
      const bigOutput = 'x'.repeat(10000);
      const result = mod.injectDependencyOutputs(
        '{{step.output}}',
        { step: { output: bigOutput, error_output: '', exit_code: 0 } }
      );
      expect(result.length).toBe(mod.OUTPUT_CAP_BYTES);
    });

    it('escapes template markers in injected output', () => {
      const result = mod.injectDependencyOutputs(
        'Result: {{step.output}}',
        { step: { output: 'alpha {{step.output}} omega', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('Result: alpha { {step.output} } omega');
    });

    it('strips ANSI sequences from injected output', () => {
      const result = mod.injectDependencyOutputs(
        'Result: {{step.output}}',
        { step: { output: '\x1b[31mred\x1b[0m', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('Result: red');
    });

    it('truncates injected output to 5KB', () => {
      const bigOutput = 'x'.repeat(10000);
      const result = mod.injectDependencyOutputs(
        '{{step.output}}',
        { step: { output: bigOutput, error_output: '', exit_code: 0 } }
      );
      expect(result.length).toBe(mod.OUTPUT_CAP_BYTES);
      expect(result).toBe('x'.repeat(mod.OUTPUT_CAP_BYTES));
    });

    it('caps error_output at 5KB', () => {
      const bigError = 'e'.repeat(10000);
      const result = mod.injectDependencyOutputs(
        '{{step.error_output}}',
        { step: { output: '', error_output: bigError, exit_code: 0 } }
      );
      expect(result.length).toBe(mod.OUTPUT_CAP_BYTES);
    });

    it('returns original description when depTasks is null', () => {
      expect(mod.injectDependencyOutputs('hello {{x.output}}', null)).toContain('hello');
    });

    it('returns empty string for null description', () => {
      expect(mod.injectDependencyOutputs(null, {})).toBe('');
    });

    it('handles empty output gracefully', () => {
      const result = mod.injectDependencyOutputs(
        'Output: {{step.output}}',
        { step: { output: '', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('Output: ');
    });

    it('does not recursively expand injected template markers', () => {
      const result = mod.injectDependencyOutputs(
        'Run: {{step.output}}',
        { step: { output: 'inner {{step.output}} payload', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('Run: inner { {step.output} } payload');
      expect(result).not.toContain('{{step.output}}');
    });
  });

  // =========================================================================
  // Unit tests: applyContextFrom
  // =========================================================================
  describe('applyContextFrom', () => {
    it('prepends context section with dependency outputs', () => {
      const result = mod.applyContextFrom(
        'Do the next thing',
        ['step1'],
        { step1: { output: 'step1 result', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('Prior step results:');
      expect(result).toContain('### step1');
      expect(result).toContain('step1 result');
      expect(result).toContain('Do the next thing');
      // Context should come before the description
      expect(result.indexOf('Prior step results:')).toBeLessThan(result.indexOf('Do the next thing'));
    });

    it('includes multiple dependency outputs in order', () => {
      const result = mod.applyContextFrom(
        'Final step',
        ['a', 'b'],
        {
          a: { output: 'output-A', error_output: '', exit_code: 0 },
          b: { output: 'output-B', error_output: '', exit_code: 0 },
        }
      );
      expect(result).toContain('### a');
      expect(result).toContain('output-A');
      expect(result).toContain('### b');
      expect(result).toContain('output-B');
      expect(result.indexOf('### a')).toBeLessThan(result.indexOf('### b'));
    });

    it('returns original description for empty contextFrom array', () => {
      const result = mod.applyContextFrom('original', [], { x: { output: 'y' } });
      expect(result).toContain('original');
    });

    it('returns original description when contextFrom is null', () => {
      expect(mod.applyContextFrom('original', null, {})).toContain('original');
    });

    it('returns original description when depTasks is null', () => {
      expect(mod.applyContextFrom('original', ['x'], null)).toContain('original');
    });

    it('skips nodes with no output', () => {
      const result = mod.applyContextFrom(
        'task desc',
        ['empty', 'nonempty'],
        {
          empty: { output: '', error_output: '', exit_code: 0 },
          nonempty: { output: 'has content', error_output: '', exit_code: 0 },
        }
      );
      expect(result).not.toContain('### empty');
      expect(result).toContain('### nonempty');
    });

    it('returns original description when all context nodes have empty output', () => {
      const result = mod.applyContextFrom(
        'task desc',
        ['a'],
        { a: { output: '', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('task desc');
    });

    it('skips nodes not found in depTasks', () => {
      const result = mod.applyContextFrom(
        'task desc',
        ['missing'],
        { other: { output: 'x', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('task desc');
    });

    it('caps output at 5KB per dependency', () => {
      const bigOutput = 'z'.repeat(10000);
      const result = mod.applyContextFrom(
        'task desc',
        ['big'],
        { big: { output: bigOutput, error_output: '', exit_code: 0 } }
      );
      // The output in the context section should be capped
      const contextPart = result.split('---')[0];
      // The capped output should be 5KB (from the end)
      expect(contextPart).toContain('z'.repeat(100)); // Contains some z's
      expect(contextPart.length).toBeLessThan(bigOutput.length);
    });

    it('returns empty string for null description', () => {
      expect(mod.applyContextFrom(null, ['x'], {})).toBe('');
    });

    it('sanitizes context section outputs', () => {
      const result = mod.applyContextFrom(
        'task desc',
        ['step'],
        { step: { output: 'value {{step.output}}\x1b[31mred\x1b[0m', error_output: '', exit_code: 0 } }
      );
      expect(result).toContain('### step');
      expect(result).toContain('value { {step.output} }red');
    });
  });

  // =========================================================================
  // Integration tests: full workflow with output injection
  // =========================================================================
  describe('integration: workflow output injection', () => {
    it('transforms task description with template variables when dependencies complete', () => {
      const wfId = createWorkflow();
      const step1Id = createWorkflowTask(wfId, 'step1', 'pending', {
        task_description: 'First step',
      });

      // Transition to completed with output
      db.updateTaskStatus(step1Id, 'completed', {
        output: 'step1-output-data',
        error_output: 'step1-error-data',
        exit_code: 0,
      });

      const step2Id = createWorkflowTask(wfId, 'step2', 'blocked', {
        task_description: 'Use {{step1.output}} and check {{step1.exit_code}} errors: {{step1.error_output}}',
      });

      // Add dependency: step2 depends on step1
      db.addTaskDependency({
        workflow_id: wfId,
        task_id: step2Id,
        depends_on_task_id: step1Id,
        on_fail: 'skip',
      });

      // Trigger evaluation: step1 completed, should unblock step2 with injected outputs
      mod.evaluateWorkflowDependencies(step1Id, wfId);

      const updatedStep2 = db.getTask(step2Id);
      expect(updatedStep2.task_description).toContain(
        'Use step1-output-data and check 0 errors: step1-error-data'
      );
      // Task should have been unblocked
      expect(['pending', 'running', 'queued']).toContain(updatedStep2.status);
    });

    it('injects context_from section when metadata is set', () => {
      const wfId = createWorkflow();
      const buildId = createWorkflowTask(wfId, 'build', 'pending', {
        task_description: 'Build the project',
      });
      db.updateTaskStatus(buildId, 'completed', {
        output: 'Build succeeded with 0 warnings',
        exit_code: 0,
      });

      const testId = createWorkflowTask(wfId, 'test', 'blocked', {
        task_description: 'Run the test suite',
        metadata: JSON.stringify({ context_from: ['build'] }),
      });

      db.addTaskDependency({
        workflow_id: wfId,
        task_id: testId,
        depends_on_task_id: buildId,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(buildId, wfId);

      const updatedTest = db.getTask(testId);
      expect(updatedTest.task_description).toContain('Prior step results:');
      expect(updatedTest.task_description).toContain('### build');
      expect(updatedTest.task_description).toContain('Build succeeded with 0 warnings');
      expect(updatedTest.task_description).toContain('Run the test suite');
    });

    it('handles both template variables and context_from together', () => {
      const wfId = createWorkflow();
      const genId = createWorkflowTask(wfId, 'generate', 'pending', {
        task_description: 'Generate code',
      });
      db.updateTaskStatus(genId, 'completed', {
        output: 'generated 5 files',
        exit_code: 0,
      });

      const fixId = createWorkflowTask(wfId, 'fix', 'blocked', {
        task_description: 'Fix issues from {{generate.output}} (exit: {{generate.exit_code}})',
        metadata: JSON.stringify({ context_from: ['generate'] }),
      });

      db.addTaskDependency({
        workflow_id: wfId,
        task_id: fixId,
        depends_on_task_id: genId,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(genId, wfId);

      const updatedFix = db.getTask(fixId);
      // Template vars should be replaced
      expect(updatedFix.task_description).toContain('Fix issues from generated 5 files (exit: 0)');
      // Context should be prepended
      expect(updatedFix.task_description).toContain('Prior step results:');
      expect(updatedFix.task_description).toContain('### generate');
    });

    it('does not modify description when there are no template variables and no context_from', () => {
      const wfId = createWorkflow();
      const aId = createWorkflowTask(wfId, 'a', 'pending', {
        task_description: 'Step A',
      });
      db.updateTaskStatus(aId, 'completed', {
        output: 'done',
        exit_code: 0,
      });

      const originalDesc = 'Step B with no templates';
      const bId = createWorkflowTask(wfId, 'b', 'blocked', {
        task_description: originalDesc,
      });

      db.addTaskDependency({
        workflow_id: wfId,
        task_id: bId,
        depends_on_task_id: aId,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(aId, wfId);

      const updatedB = db.getTask(bId);
      expect(updatedB.task_description).toBe(originalDesc);
    });

    it('caps large dependency outputs in integration scenario', () => {
      const wfId = createWorkflow();
      const bigId = createWorkflowTask(wfId, 'big', 'pending', {
        task_description: 'Big output step',
      });
      const largeOutput = 'L'.repeat(10000);
      db.updateTaskStatus(bigId, 'completed', {
        output: largeOutput,
        exit_code: 0,
      });

      const consumerId = createWorkflowTask(wfId, 'consumer', 'blocked', {
        task_description: 'Got: {{big.output}}',
      });

      db.addTaskDependency({
        workflow_id: wfId,
        task_id: consumerId,
        depends_on_task_id: bigId,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(bigId, wfId);

      const updated = db.getTask(consumerId);
      // "Got: " is 5 chars + 5120 capped output
      expect(updated.task_description.length).toBe(5 + mod.OUTPUT_CAP_BYTES);
    });

    it('handles multiple dependencies with template variables', () => {
      const wfId = createWorkflow();

      const typeId = createWorkflowTask(wfId, 'types', 'pending', {
        task_description: 'Generate types',
      });
      db.updateTaskStatus(typeId, 'completed', {
        output: 'types-generated',
        exit_code: 0,
      });

      const dataId = createWorkflowTask(wfId, 'data', 'pending', {
        task_description: 'Generate data',
      });
      db.updateTaskStatus(dataId, 'completed', {
        output: 'data-generated',
        exit_code: 0,
      });

      const systemId = createWorkflowTask(wfId, 'system', 'blocked', {
        task_description: 'Build system using {{types.output}} and {{data.output}}',
      });

      db.addTaskDependency({
        workflow_id: wfId,
        task_id: systemId,
        depends_on_task_id: typeId,
        on_fail: 'skip',
      });
      db.addTaskDependency({
        workflow_id: wfId,
        task_id: systemId,
        depends_on_task_id: dataId,
        on_fail: 'skip',
      });

      // Both deps must be complete. Trigger from the last one.
      mod.evaluateWorkflowDependencies(dataId, wfId);

      const updated = db.getTask(systemId);
      expect(updated.task_description).toBe(
        'Build system using types-generated and data-generated'
      );
    });

    it('leaves missing dep placeholders intact when only some deps are resolved', () => {
      const wfId = createWorkflow();

      const aId = createWorkflowTask(wfId, 'a', 'pending', {
        task_description: 'Step A',
      });
      db.updateTaskStatus(aId, 'completed', {
        output: 'a-output',
        exit_code: 0,
      });

      // Template references a node that is a dep but has a different node_id

      const cId = createWorkflowTask(wfId, 'c', 'blocked', {
        task_description: 'Use {{a.output}} and {{nonexistent.output}}',
      });

      db.addTaskDependency({
        workflow_id: wfId,
        task_id: cId,
        depends_on_task_id: aId,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(aId, wfId);

      const updated = db.getTask(cId);
      expect(updated.task_description).toContain("Use a-output and [ERROR: output unavailable from node 'nonexistent'");
    });
  });

  // =========================================================================
  // Unit tests: buildDepTasksMap
  // =========================================================================
  describe('buildDepTasksMap', () => {
    it('builds map from workflow dependencies', () => {
      const wfId = createWorkflow();
      const s1 = createWorkflowTask(wfId, 'src', 'pending');
      db.updateTaskStatus(s1, 'completed', { output: 'src-out', exit_code: 0 });

      const s2 = createWorkflowTask(wfId, 'dst', 'blocked');
      db.addTaskDependency({
        workflow_id: wfId,
        task_id: s2,
        depends_on_task_id: s1,
        on_fail: 'skip',
      });

      const map = mod.buildDepTasksMap(wfId, s2);
      expect(map).toHaveProperty('src');
      expect(map.src.output).toBe('src-out');
      expect(map.src.exit_code).toBe(0);
    });

    it('returns empty map when task has no dependencies', () => {
      const wfId = createWorkflow();
      const s1 = createWorkflowTask(wfId, 'lone', 'pending');
      const map = mod.buildDepTasksMap(wfId, s1);
      expect(Object.keys(map).length).toBe(0);
    });
  });
});
