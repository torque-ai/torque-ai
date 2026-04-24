'use strict';

const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db;
let testDir;

beforeAll(() => {
  const env = setupTestDb('workflow-spec-handlers');
  db = env.db;
  testDir = env.testDir;
});

afterAll(() => teardownTestDb());

const { handleListWorkflowSpecs, handleValidateWorkflowSpec, handleRunWorkflowSpec } =
  require('../handlers/workflow-spec-handlers');

describe('handleListWorkflowSpecs', () => {
  it('returns empty list when no workflows dir', () => {
    const result = handleListWorkflowSpecs({ working_directory: testDir });
    expect(result.isError).toBeFalsy();
    expect(result.structuredData.specs).toEqual([]);
  });

  it('lists discovered specs', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'hello.yaml'),
      'version: 1\nname: hello\ntasks:\n  - node_id: a\n    task: Say hi\n');

    const result = handleListWorkflowSpecs({ working_directory: testDir });
    expect(result.isError).toBeFalsy();
    expect(result.structuredData.specs).toHaveLength(1);
    expect(result.structuredData.specs[0].name).toBe('hello');
  });
});

describe('handleValidateWorkflowSpec', () => {
  it('reports errors for invalid specs', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const badPath = path.join(wfDir, 'bad.yaml');
    fs.writeFileSync(badPath, 'version: 1\nname: x\ntasks: []\n');

    const result = handleValidateWorkflowSpec({ spec_path: badPath });
    expect(result.isError).toBe(true);
    expect(result.structuredData.errors.length).toBeGreaterThan(0);
  });

  it('validates a good spec', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const goodPath = path.join(wfDir, 'ok.yaml');
    fs.writeFileSync(goodPath,
      'version: 1\nname: ok\ntasks:\n  - node_id: a\n    task: Do it\n');

    const result = handleValidateWorkflowSpec({ spec_path: goodPath });
    expect(result.isError).toBeFalsy();
    expect(result.structuredData.valid).toBe(true);
  });
});

describe('handleRunWorkflowSpec', () => {
  it('creates a workflow from a valid spec and returns workflow_id', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const specPath = path.join(wfDir, 'run.yaml');
    fs.writeFileSync(specPath,
      `version: 1
name: test-run
project: test-proj
tasks:
  - node_id: step-a
    task: First task
  - node_id: step-b
    task: Second task
    depends_on: [step-a]
`);

    const result = handleRunWorkflowSpec({
      spec_path: specPath,
      working_directory: testDir,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.workflow_id).toMatch(/^[a-f0-9-]{36}$/);

    const workflow = db.getWorkflow(result.structuredData.workflow_id);
    expect(workflow).toBeTruthy();
    expect(workflow.name).toBe('test-run');
    const tasks = db.getWorkflowTasks(workflow.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.find(t => t.workflow_node_id === 'step-a')).toBeTruthy();
    expect(tasks.find(t => t.workflow_node_id === 'step-b')).toBeTruthy();
    expect(tasks.every(t => t.project === 'test-proj')).toBe(true);
  });

  it('rejects invalid specs with schema errors', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const badPath = path.join(wfDir, 'invalid.yaml');
    fs.writeFileSync(badPath, 'version: 1\nname: x\ntasks:\n  - bad: true\n');

    const result = handleRunWorkflowSpec({
      spec_path: badPath,
      working_directory: testDir,
    });
    expect(result.isError).toBe(true);
  });

  it('passes model_stylesheet through to create_workflow', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const specPath = path.join(wfDir, 'style.yaml');
    fs.writeFileSync(specPath, `
version: 1
name: style-test
project: p
model_stylesheet: |
  * { provider: ollama; }
tasks:
  - node_id: x
    task: do x
`);

    const result = handleRunWorkflowSpec({ spec_path: specPath, working_directory: testDir });
    expect(result.isError).toBeFalsy();
    const tasks = db.getWorkflowTasks(result.structuredData.workflow_id);
    expect(tasks[0].provider).toBe('ollama');
  });
});
