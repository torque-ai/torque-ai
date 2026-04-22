'use strict';

const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { handleRunWorkflowSpec } = require('../handlers/workflow-spec-handlers');

let db, testDir;
beforeAll(() => {
  const env = setupTestDb('wf-spec-integration');
  db = env.db;
  testDir = env.testDir;
});
afterAll(() => teardownTestDb());

describe('workflow-spec end-to-end', () => {
  it('creates a working workflow from a YAML file with per-task providers and tags', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const specPath = path.join(wfDir, 'e2e.yaml');

    fs.writeFileSync(specPath, `
version: 1
name: e2e-test
description: End-to-end workflow spec smoke test
project: e2e-proj
tasks:
  - node_id: scout
    task: Look for issues
    provider: ollama
    tags: [scout, fast]
  - node_id: fix
    task: Fix issues found in scout
    provider: codex
    depends_on: [scout]
    tags: [coding]
`);

    const result = handleRunWorkflowSpec({ spec_path: specPath, working_directory: testDir });
    expect(result.isError).toBeFalsy();
    const workflowId = result.structuredData.workflow_id;

    const tasks = db.getWorkflowTasks(workflowId);
    const scout = tasks.find(t => t.workflow_node_id === 'scout');
    const fix = tasks.find(t => t.workflow_node_id === 'fix');

    expect(scout.provider).toBe('ollama');
    expect(fix.provider).toBe('codex');
    expect(scout.project).toBe('e2e-proj');
    expect(fix.project).toBe('e2e-proj');

    expect(scout.tags).toContain('scout');
    expect(scout.tags).toContain('fast');
    expect(fix.tags).toContain('coding');

    expect(fix.status).toBe('blocked');
    expect(scout.status).toBe('pending');
  });
});
