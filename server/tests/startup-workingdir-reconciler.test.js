import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let testDir;
let taskCore;
let workflowEngine;
let workflowRuntime;

function setup() {
  ({ db, testDir } = setupTestDbOnly('startup-workingdir-reconciler'));
  taskCore = require('../db/task-core');
  workflowEngine = require('../db/workflow-engine');
  workflowRuntime = require('../execution/workflow-runtime');
  workflowRuntime.init({
    db,
    startTask: vi.fn(),
    cancelTask: vi.fn(),
    processQueue: vi.fn(),
    dashboard: {
      broadcast: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyWorkflowUpdated: vi.fn(),
      notifyStatsUpdated: vi.fn(),
    },
  });
}

function createWorkflow(overrides = {}) {
  const id = overrides.id || randomUUID();
  workflowEngine.createWorkflow({
    id,
    name: overrides.name || `wf-${id.slice(0, 8)}`,
    status: overrides.status || 'running',
    working_directory: overrides.working_directory || null,
    description: overrides.description || null,
  });
  return id;
}

function createWorkflowTask(workflowId, nodeId, status, overrides = {}) {
  const id = overrides.id || randomUUID();
  const requestedWorkingDirectory = overrides.working_directory;
  const insertOverrides = { ...overrides };
  if (requestedWorkingDirectory && !fs.existsSync(requestedWorkingDirectory)) {
    insertOverrides.working_directory = testDir;
  }
  taskCore.createTask({
    id,
    task_description: `Task ${nodeId}`,
    working_directory: insertOverrides.working_directory || testDir,
    provider: 'codex',
    metadata: {},
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    status,
    ...insertOverrides,
  });
  if (requestedWorkingDirectory && requestedWorkingDirectory !== insertOverrides.working_directory) {
    db.getDbInstance()
      .prepare('UPDATE tasks SET working_directory = ? WHERE id = ?')
      .run(requestedWorkingDirectory, id);
  }
  return id;
}

beforeEach(() => { setup(); });
afterEach(() => { teardownTestDb(); vi.restoreAllMocks(); });

describe('reconcileWorkflowsOnStartup — working directory validation', () => {
  test('fails queued task whose working_directory has vanished', () => {
    const missing = path.join(os.tmpdir(), 'wf-missing-' + Date.now());
    const wfId = createWorkflow({ working_directory: missing });
    const taskId = createWorkflowTask(wfId, 't1', 'queued', { working_directory: missing });

    const result = workflowRuntime.reconcileWorkflowsOnStartup();

    expect(result.actions.working_dir_failures).toBeGreaterThanOrEqual(1);
    const after = taskCore.getTask(taskId);
    expect(after.status).toBe('failed');
    expect(after.error_output).toMatch(/WORKING_DIR_MISSING/);
  });

  test('re-points queued task when task dir is missing but workflow dir exists', () => {
    const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-good-'));
    const missing = path.join(os.tmpdir(), 'wf-stale-' + Date.now());
    const wfId = createWorkflow({ working_directory: goodDir });
    const taskId = createWorkflowTask(wfId, 't1', 'queued', { working_directory: missing });

    try {
      const result = workflowRuntime.reconcileWorkflowsOnStartup();

      expect(result.actions.working_dir_repointed).toBeGreaterThanOrEqual(1);
      const after = taskCore.getTask(taskId);
      expect(after.status).toBe('queued');
      expect(after.working_directory).toBe(goodDir);
    } finally {
      fs.rmdirSync(goodDir);
    }
  });

  test('does not touch tasks whose working_directory exists', () => {
    const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ok-'));
    const wfId = createWorkflow({ working_directory: goodDir });
    const taskId = createWorkflowTask(wfId, 't1', 'queued', { working_directory: goodDir });

    try {
      const result = workflowRuntime.reconcileWorkflowsOnStartup();
      expect(result.actions.working_dir_failures).toBe(0);
      expect(result.actions.working_dir_repointed).toBe(0);
      const after = taskCore.getTask(taskId);
      expect(after.status).toBe('queued');
    } finally {
      fs.rmdirSync(goodDir);
    }
  });

  test('fails all non-terminal tasks when both workflow dir and task dir are gone', () => {
    const missing = path.join(os.tmpdir(), 'all-gone-' + Date.now());
    const wfId = createWorkflow({ working_directory: missing });
    const a = createWorkflowTask(wfId, 'a', 'queued', { working_directory: missing });
    const b = createWorkflowTask(wfId, 'b', 'blocked', { working_directory: missing });
    const c = createWorkflowTask(wfId, 'c', 'completed', { working_directory: missing });

    workflowRuntime.reconcileWorkflowsOnStartup();

    expect(taskCore.getTask(a).status).toBe('failed');
    expect(taskCore.getTask(b).status).toBe('failed');
    expect(taskCore.getTask(c).status).toBe('completed');
  });
});
