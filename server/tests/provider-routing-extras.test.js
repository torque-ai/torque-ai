import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const FALLBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  task_description TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_replays (
  id TEXT PRIMARY KEY,
  original_task_id TEXT NOT NULL,
  replay_task_id TEXT NOT NULL,
  modified_inputs TEXT,
  diff_summary TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (original_task_id) REFERENCES tasks(id),
  FOREIGN KEY (replay_task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS workflow_forks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  fork_point_task_id TEXT,
  branch_count INTEGER DEFAULT 2,
  branches TEXT NOT NULL,
  merge_strategy TEXT DEFAULT 'all',
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);
`;

let db;
let dbHandle;
let providerRoutingExtras;

function insertTask(id = randomUUID()) {
  dbHandle.prepare(`
    INSERT INTO tasks (id, status, task_description, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, 'completed', `Task ${id}`, new Date().toISOString());

  return id;
}

function insertWorkflow(id = randomUUID()) {
  dbHandle.prepare(`
    INSERT INTO workflows (id, name, status, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, `Workflow ${id}`, 'pending', new Date().toISOString());

  return id;
}

beforeAll(() => {
  ({ db } = setupTestDbOnly('provider-routing-extras'));
  dbHandle = db.getDbInstance();
  dbHandle.exec(FALLBACK_SCHEMA);

  providerRoutingExtras = require('../db/provider/routing-extras');
  providerRoutingExtras.setDb(dbHandle);
});

afterAll(() => {
  teardownTestDb();
});

describe('server/db/provider/routing-extras', () => {
  it('createTaskReplay + getTaskReplay round-trip a replay record', () => {
    const replayId = randomUUID();
    const originalTaskId = insertTask();
    const replayTaskId = insertTask();

    const created = providerRoutingExtras.createTaskReplay({
      id: replayId,
      original_task_id: originalTaskId,
      replay_task_id: replayTaskId,
      modified_inputs: { retries: 2, mode: 'strict' },
      diff_summary: 'minor diff',
    });

    expect(created).toMatchObject({
      id: replayId,
      original_task_id: originalTaskId,
      replay_task_id: replayTaskId,
      modified_inputs: { retries: 2, mode: 'strict' },
      diff_summary: 'minor diff',
      created_at: expect.any(String),
    });

    expect(providerRoutingExtras.getTaskReplay(replayId)).toMatchObject({
      id: replayId,
      original_task_id: originalTaskId,
      replay_task_id: replayTaskId,
      modified_inputs: { retries: 2, mode: 'strict' },
      diff_summary: 'minor diff',
      created_at: expect.any(String),
    });
  });

  it('listTaskReplays returns replays ordered by created_at DESC', () => {
    const originalTaskId = insertTask();
    const olderReplayId = randomUUID();
    const newerReplayId = randomUUID();

    providerRoutingExtras.createTaskReplay({
      id: olderReplayId,
      original_task_id: originalTaskId,
      replay_task_id: insertTask(),
      modified_inputs: { version: 'old' },
    });

    providerRoutingExtras.createTaskReplay({
      id: newerReplayId,
      original_task_id: originalTaskId,
      replay_task_id: insertTask(),
      modified_inputs: { version: 'new' },
    });

    dbHandle.prepare('UPDATE task_replays SET created_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', olderReplayId);
    dbHandle.prepare('UPDATE task_replays SET created_at = ? WHERE id = ?')
      .run('2030-01-01T00:00:00.000Z', newerReplayId);

    const replays = providerRoutingExtras.listTaskReplays(originalTaskId);

    expect(replays.map(replay => replay.id)).toEqual([newerReplayId, olderReplayId]);
    expect(replays[0].modified_inputs).toEqual({ version: 'new' });
    expect(replays[1].modified_inputs).toEqual({ version: 'old' });
  });

  it('createWorkflowFork + getWorkflowFork round-trip and parse branches JSON', () => {
    const forkId = randomUUID();
    const workflowId = insertWorkflow();
    const branches = [
      { task_id: 'branch-a', provider: 'codex' },
      { task_id: 'branch-b', provider: 'ollama' },
    ];

    const created = providerRoutingExtras.createWorkflowFork({
      id: forkId,
      workflow_id: workflowId,
      fork_point_task_id: 'task-1',
      branch_count: 2,
      branches,
      merge_strategy: 'all',
    });

    expect(created).toMatchObject({
      id: forkId,
      workflow_id: workflowId,
      fork_point_task_id: 'task-1',
      branch_count: 2,
      branches,
      merge_strategy: 'all',
      status: 'pending',
      created_at: expect.any(String),
    });

    expect(providerRoutingExtras.getWorkflowFork(forkId)).toMatchObject({
      id: forkId,
      workflow_id: workflowId,
      fork_point_task_id: 'task-1',
      branch_count: 2,
      branches,
      merge_strategy: 'all',
      status: 'pending',
      created_at: expect.any(String),
    });
  });

  it('updateWorkflowForkStatus updates status and returns the updated fork', () => {
    const forkId = randomUUID();
    const workflowId = insertWorkflow();

    providerRoutingExtras.createWorkflowFork({
      id: forkId,
      workflow_id: workflowId,
      branches: [{ task_id: 'branch-a' }, { task_id: 'branch-b' }],
      merge_strategy: 'any',
    });

    const updated = providerRoutingExtras.updateWorkflowForkStatus(forkId, 'running');

    expect(updated).toMatchObject({
      id: forkId,
      workflow_id: workflowId,
      status: 'running',
      merge_strategy: 'any',
      branches: [{ task_id: 'branch-a' }, { task_id: 'branch-b' }],
    });
    expect(providerRoutingExtras.getWorkflowFork(forkId).status).toBe('running');
  });

  it('getTaskReplay returns undefined for a non-existent ID', () => {
    expect(providerRoutingExtras.getTaskReplay(randomUUID())).toBeUndefined();
  });
});
