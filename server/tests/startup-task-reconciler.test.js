import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');
const serverConfig = require('../config');
const { reconcileOrphanedTasksOnStartup } = require('../execution/startup-task-reconciler');

let db;
let logger;

const TASK_COLUMNS = [
  'id',
  'status',
  'task_description',
  'working_directory',
  'provider',
  'model',
  'timeout_minutes',
  'auto_approve',
  'priority',
  'context',
  'output',
  'error_output',
  'created_at',
  'started_at',
  'completed_at',
  'cancel_reason',
  'retry_count',
  'max_retries',
  'depends_on',
  'template_name',
  'isolated_workspace',
  'approval_status',
  'project',
  'workflow_id',
  'workflow_node_id',
  'tags',
  'ollama_host_id',
  'complexity',
  'review_status',
  'metadata',
  'mcp_instance_id',
  'original_provider',
  'provider_switched_at',
  'stall_timeout_seconds',
  'resume_context',
  'server_epoch',
];

function createSchema(sqliteDb) {
  sqliteDb.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'pending',
      task_description TEXT,
      working_directory TEXT,
      provider TEXT,
      model TEXT,
      timeout_minutes INTEGER DEFAULT 30,
      auto_approve INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      context TEXT,
      output TEXT DEFAULT '',
      error_output TEXT DEFAULT '',
      created_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      cancel_reason TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      depends_on TEXT,
      template_name TEXT,
      isolated_workspace TEXT,
      approval_status TEXT,
      project TEXT,
      workflow_id TEXT,
      workflow_node_id TEXT,
      tags TEXT,
      ollama_host_id TEXT,
      complexity TEXT,
      review_status TEXT,
      metadata TEXT,
      mcp_instance_id TEXT,
      original_provider TEXT,
      provider_switched_at TEXT,
      stall_timeout_seconds INTEGER,
      resume_context TEXT,
      server_epoch INTEGER
    );

    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      working_directory TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT
    );

    CREATE TABLE task_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      condition_expr TEXT,
      on_fail TEXT DEFAULT 'skip',
      alternate_task_id TEXT,
      created_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_resubmitted_from_active
      ON tasks(json_extract(metadata,'$.resubmitted_from'))
      WHERE status != 'cancelled' AND json_extract(metadata,'$.resubmitted_from') IS NOT NULL;
  `);
}

function serializeValue(column, value) {
  if ((column === 'metadata' || column === 'tags' || column === 'context' || column === 'depends_on') && value !== null && value !== undefined) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return value;
}

function insertTask(overrides = {}) {
  const now = new Date().toISOString();
  const task = {
    id: overrides.id || `task-${Math.random().toString(16).slice(2)}`,
    status: 'running',
    task_description: 'startup reconciler task',
    working_directory: process.cwd(),
    provider: 'codex',
    model: 'gpt-test',
    timeout_minutes: 30,
    auto_approve: 0,
    priority: 0,
    context: null,
    output: '',
    error_output: '',
    created_at: now,
    started_at: now,
    completed_at: null,
    cancel_reason: null,
    retry_count: 0,
    max_retries: 2,
    depends_on: null,
    template_name: null,
    isolated_workspace: null,
    approval_status: 'not_required',
    project: null,
    workflow_id: null,
    workflow_node_id: null,
    tags: null,
    ollama_host_id: null,
    complexity: 'normal',
    review_status: null,
    metadata: null,
    mcp_instance_id: null,
    original_provider: 'codex',
    provider_switched_at: null,
    stall_timeout_seconds: null,
    resume_context: null,
    server_epoch: 0,
    ...overrides,
  };

  const placeholders = TASK_COLUMNS.map(() => '?').join(', ');
  db.prepare(`
    INSERT INTO tasks (${TASK_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `).run(...TASK_COLUMNS.map(column => serializeValue(column, task[column])));

  return task.id;
}

function runReconciler(options = {}) {
  return reconcileOrphanedTasksOnStartup({
    db,
    taskCore,
    getMcpInstanceId: () => 'mcp-current',
    isInstanceAlive: (instanceId) => instanceId === 'mcp-live',
    logger,
    ...options,
  });
}

function getTaskRow(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

function parseMetadata(row) {
  return row && row.metadata ? JSON.parse(row.metadata) : {};
}

function cloneRowsFor(originalTaskId) {
  return db.prepare('SELECT * FROM tasks').all()
    .filter(row => parseMetadata(row).resubmitted_from === originalTaskId);
}

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
  taskCore.setDb(db);
  serverConfig.setEpoch(0);
  logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
});

afterEach(() => {
  taskCore.setDb(null);
  serverConfig.setEpoch(0);
  db.close();
  vi.restoreAllMocks();
});

describe('startup task reconciler', () => {
  test('No orphans -> no-op', () => {
    const result = runReconciler();

    expect(result.reconciled).toBe(false);
    expect(result.actions.candidates).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as count FROM tasks').get().count).toBe(0);
  });

  test('Orphan with metadata.auto_resubmit_on_restart=true -> cancelled and cloned with resume_context', () => {
    insertTask({
      id: 'task-auto',
      task_description: 'resume this task',
      metadata: { auto_resubmit_on_restart: true },
      output: 'Wrote server/example.js\n$ npm run test',
      error_output: 'previous failure',
    });

    const result = runReconciler();

    expect(result.actions.cancelled).toBe(1);
    expect(result.actions.cloned).toBe(1);

    const original = getTaskRow('task-auto');
    expect(original.status).toBe('cancelled');
    expect(original.cancel_reason).toBe('server_restart');
    expect(original.error_output).toContain('[startup-reconciler] task cancelled by server restart');

    const clones = cloneRowsFor('task-auto');
    expect(clones).toHaveLength(1);
    expect(clones[0].status).toBe('queued');
    expect(clones[0].resume_context).toBeTruthy();
    expect(parseMetadata(clones[0]).resubmitted_from).toBe('task-auto');
    expect(parseMetadata(original).resubmitted_as).toBe(clones[0].id);
  });

  test('Orphan without flag/tag/workflow -> cancelled but not cloned', () => {
    insertTask({ id: 'task-legacy' });

    const result = runReconciler();

    expect(result.actions.cancelled).toBe(1);
    expect(result.actions.cloned).toBe(0);
    expect(getTaskRow('task-legacy').status).toBe('cancelled');
    expect(db.prepare('SELECT COUNT(*) as count FROM tasks').get().count).toBe(1);
  });

  test('Factory-tagged orphan -> cloned', () => {
    insertTask({
      id: 'task-factory',
      tags: ['factory:batch_id=batch-1'],
    });

    const result = runReconciler();

    expect(result.actions.cancelled).toBe(1);
    expect(result.actions.cloned).toBe(1);
    expect(cloneRowsFor('task-factory')).toHaveLength(1);
  });

  test('Eligible orphan with missing working_directory -> failed and not cloned', () => {
    const missingDir = 'C:\\definitely-missing\\startup-reconciler-worktree';
    insertTask({
      id: 'task-missing-workdir',
      working_directory: missingDir,
      metadata: { auto_resubmit_on_restart: true },
    });

    const result = runReconciler();

    expect(result.reconciled).toBe(true);
    expect(result.actions.missing_workdir_failed).toBe(1);
    expect(result.actions.cancelled).toBe(0);
    expect(result.actions.cloned).toBe(0);

    const original = getTaskRow('task-missing-workdir');
    expect(original.status).toBe('failed');
    expect(original.error_output).toContain('working_directory no longer exists');
    expect(parseMetadata(original)).toMatchObject({
      restart_resubmit_skipped: 'missing_working_directory',
      missing_working_directory: missingDir,
    });
    expect(cloneRowsFor('task-missing-workdir')).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed missing-workdir task'),
      expect.objectContaining({ task_id: 'task-missing-workdir', working_directory: missingDir }),
    );
  });

  test('Cancelled restart orphan with missing working_directory -> retagged and not cloned', () => {
    const missingDir = 'C:\\definitely-missing\\cancelled-startup-reconciler-worktree';
    insertTask({
      id: 'task-cancelled-missing-workdir',
      status: 'cancelled',
      cancel_reason: 'server_restart',
      working_directory: missingDir,
      metadata: { auto_resubmit_on_restart: true },
    });

    const result = runReconciler();

    expect(result.reconciled).toBe(true);
    expect(result.actions.missing_workdir_failed).toBe(1);
    expect(result.actions.cloned).toBe(0);

    const original = getTaskRow('task-cancelled-missing-workdir');
    expect(original.status).toBe('cancelled');
    expect(original.cancel_reason).toBe('missing_working_directory');
    expect(original.error_output).toContain('working_directory no longer exists');
    expect(parseMetadata(original)).toMatchObject({
      restart_resubmit_skipped: 'missing_working_directory',
      missing_working_directory: missingDir,
    });
    expect(cloneRowsFor('task-cancelled-missing-workdir')).toHaveLength(0);
  });

  test('Double-run idempotency -> second call no-ops when resubmitted_as points to active clone', () => {
    insertTask({
      id: 'task-idempotent',
      metadata: { auto_resubmit_on_restart: true },
    });

    runReconciler();
    const clone = cloneRowsFor('task-idempotent')[0];
    expect(clone).toBeTruthy();

    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run('task-idempotent');
    const second = runReconciler();

    expect(second.actions.skipped).toBe(1);
    expect(second.actions.cancelled).toBe(0);
    expect(second.actions.cloned).toBe(0);
    expect(cloneRowsFor('task-idempotent')).toHaveLength(1);
    expect(getTaskRow('task-idempotent').status).toBe('running');
  });

  test('Resume-context propagation -> clone resume_context parses back correctly', () => {
    insertTask({
      id: 'task-resume',
      task_description: 'preserve useful progress',
      provider: 'codex',
      metadata: { auto_resubmit_on_restart: true },
      output: [
        'Wrote server/resume-target.js',
        '$ npm run test',
        'Implemented most of the parser.',
      ].join('\n'),
      error_output: 'Error: failed after parser update',
    });

    runReconciler();

    const clone = cloneRowsFor('task-resume')[0];
    const resumeContext = JSON.parse(clone.resume_context);

    expect(resumeContext.goal).toBe('preserve useful progress');
    expect(resumeContext.provider).toBe('codex');
    expect(resumeContext.filesModified).toContain('server/resume-target.js');
    expect(resumeContext.commandsRun).toContain('npm run test');
    expect(resumeContext.errorDetails).toContain('failed after parser update');
    expect(resumeContext.durationMs).toBe(0);
  });

  test('Resubmit cap restart_resubmit_count=3 -> cancelled, not cloned', () => {
    insertTask({
      id: 'task-capped',
      metadata: {
        auto_resubmit_on_restart: true,
        restart_resubmit_count: 3,
      },
    });

    const result = runReconciler();

    expect(result.actions.cancelled).toBe(1);
    expect(result.actions.capped).toBe(1);
    expect(result.actions.cloned).toBe(0);
    expect(getTaskRow('task-capped').status).toBe('cancelled');
    expect(cloneRowsFor('task-capped')).toHaveLength(0);
  });

  test('Unique index race -> SQLITE_CONSTRAINT is skipped gracefully', () => {
    insertTask({
      id: 'task-race',
      metadata: { auto_resubmit_on_restart: true },
    });
    insertTask({
      id: 'existing-race-clone',
      status: 'queued',
      metadata: { resubmitted_from: 'task-race' },
    });

    const result = runReconciler();

    expect(result.actions.cancelled).toBe(1);
    expect(result.actions.constraint_skipped).toBe(1);
    expect(result.actions.cloned).toBe(0);
    expect(getTaskRow('task-race').status).toBe('cancelled');
    expect(cloneRowsFor('task-race')).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped duplicate resubmit'),
      expect.objectContaining({ task_id: 'task-race' }),
    );
  });
});

describe('startup-task-reconciler — drain-cancelled tasks', () => {
  let db;
  let testDir;
  let taskCore;
  let workflowEngine;
  let reconciler;

  beforeEach(() => {
    ({ db, testDir } = setupTestDbOnly('startup-task-reconciler-drain'));
    taskCore = require('../db/task-core');
    workflowEngine = require('../db/workflow-engine');
    reconciler = require('../execution/startup-task-reconciler');
    const createTask = taskCore.createTask;
    vi.spyOn(taskCore, 'createTask').mockImplementation((task) => {
      const created = createTask(task);
      if (task && task.cancel_reason) {
        db.getDbInstance()
          .prepare('UPDATE tasks SET cancel_reason = ? WHERE id = ?')
          .run(task.cancel_reason, task.id);
      }
      return created;
    });
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  test('clones a task cancelled with reason=server_restart when its workflow is still running', () => {
    const wfId = randomUUID();
    workflowEngine.createWorkflow({
      id: wfId,
      name: 'drain-running-wf',
      status: 'running',
      description: null,
    });

    const origId = randomUUID();
    taskCore.createTask({
      id: origId,
      task_description: 'Implement feature X',
      working_directory: testDir,
      provider: 'codex',
      metadata: {},
      workflow_id: wfId,
      workflow_node_id: 'feature_x',
      status: 'cancelled',
      cancel_reason: 'server_restart',
    });

    const result = reconciler.reconcileOrphanedTasksOnStartup({
      db,
      taskCore,
      getMcpInstanceId: () => 'current-instance',
      isInstanceAlive: () => false,
    });

    expect(result.actions.cloned).toBeGreaterThanOrEqual(1);

    const original = taskCore.getTask(origId);
    expect(original.metadata).toBeTruthy();
    const meta = typeof original.metadata === 'string' ? JSON.parse(original.metadata) : original.metadata;
    expect(meta.resubmitted_as).toBeTruthy();

    const clone = taskCore.getTask(meta.resubmitted_as);
    expect(clone).toBeTruthy();
    expect(clone.status).toBe('queued');
    expect(clone.workflow_id).toBe(wfId);
    expect(clone.workflow_node_id).toBe('feature_x');
    expect(clone.task_description.startsWith('## Previous Attempt (failed)')).toBe(true);
    expect(clone.task_description).toContain('Implement feature X');
  });

  test('does NOT clone a drain-cancelled task whose workflow is already terminal', () => {
    const wfId = randomUUID();
    workflowEngine.createWorkflow({
      id: wfId,
      name: 'drain-terminal-wf',
      status: 'cancelled',
      description: null,
    });

    const origId = randomUUID();
    taskCore.createTask({
      id: origId,
      task_description: 'Implement feature Y',
      working_directory: testDir,
      provider: 'codex',
      metadata: {},
      workflow_id: wfId,
      status: 'cancelled',
      cancel_reason: 'server_restart',
    });

    const result = reconciler.reconcileOrphanedTasksOnStartup({
      db,
      taskCore,
      getMcpInstanceId: () => 'current-instance',
      isInstanceAlive: () => false,
    });

    expect(result.actions.cloned).toBe(0);
    const original = taskCore.getTask(origId);
    const meta = typeof original.metadata === 'string' ? JSON.parse(original.metadata || '{}') : (original.metadata || {});
    expect(meta.resubmitted_as).toBeUndefined();
  });

  test('does NOT clone a task cancelled for reasons other than server_restart', () => {
    const wfId = randomUUID();
    workflowEngine.createWorkflow({
      id: wfId,
      name: 'user-cancelled-wf',
      status: 'running',
      description: null,
    });

    const origId = randomUUID();
    taskCore.createTask({
      id: origId,
      task_description: 'Implement feature Z',
      working_directory: testDir,
      provider: 'codex',
      metadata: {},
      workflow_id: wfId,
      status: 'cancelled',
      cancel_reason: 'user_requested',
    });

    const result = reconciler.reconcileOrphanedTasksOnStartup({
      db,
      taskCore,
      getMcpInstanceId: () => 'current-instance',
      isInstanceAlive: () => false,
    });

    expect(result.actions.cloned).toBe(0);
  });

  test('skips drain-cancelled tasks that already have a live resubmitted_as clone', () => {
    const wfId = randomUUID();
    workflowEngine.createWorkflow({
      id: wfId,
      name: 'already-resubmitted-wf',
      status: 'running',
      description: null,
    });

    const cloneId = randomUUID();
    taskCore.createTask({
      id: cloneId,
      task_description: 'clone',
      working_directory: testDir,
      provider: 'codex',
      metadata: {},
      workflow_id: wfId,
      status: 'queued',
    });

    const origId = randomUUID();
    taskCore.createTask({
      id: origId,
      task_description: 'Implement feature W',
      working_directory: testDir,
      provider: 'codex',
      metadata: { resubmitted_as: cloneId },
      workflow_id: wfId,
      status: 'cancelled',
      cancel_reason: 'server_restart',
    });

    const result = reconciler.reconcileOrphanedTasksOnStartup({
      db,
      taskCore,
      getMcpInstanceId: () => 'current-instance',
      isInstanceAlive: () => false,
    });

    expect(result.actions.cloned).toBe(0);
    expect(result.actions.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('startup-task-reconciler — retry_scheduled orphans', () => {
  let db;
  let testDir;
  let taskCore;
  let reconciler;

  beforeEach(() => {
    ({ db, testDir } = setupTestDbOnly('startup-task-reconciler-retry'));
    taskCore = require('../db/task-core');
    reconciler = require('../execution/startup-task-reconciler');
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  test('promotes retry_scheduled task back to queued when retry budget remains', () => {
    const id = randomUUID();
    taskCore.createTask({
      id,
      task_description: 'needs retry',
      working_directory: testDir,
      provider: 'codex',
      metadata: {},
      status: 'retry_scheduled',
      retry_count: 1,
      max_retries: 3,
    });

    const result = reconciler.reconcileOrphanedTasksOnStartup({
      db,
      taskCore,
      getMcpInstanceId: () => 'current-instance',
      isInstanceAlive: () => false,
    });

    expect(result.actions.retry_requeued).toBeGreaterThanOrEqual(1);
    const after = taskCore.getTask(id);
    expect(after.status).toBe('queued');
  });

  test('fails retry_scheduled task when retry budget is exhausted', () => {
    const id = randomUUID();
    taskCore.createTask({
      id,
      task_description: 'exhausted',
      working_directory: testDir,
      provider: 'codex',
      metadata: {},
      status: 'retry_scheduled',
      max_retries: 3,
    });
    // createTask does not set retry_count on insert (it's updated via retry
    // framework during runtime). Patch it directly so the exhaustion test
    // exercises the real "count >= max" state.
    db.getDbInstance().prepare('UPDATE tasks SET retry_count = ? WHERE id = ?').run(3, id);

    const result = reconciler.reconcileOrphanedTasksOnStartup({
      db,
      taskCore,
      getMcpInstanceId: () => 'current-instance',
      isInstanceAlive: () => false,
    });

    expect(result.actions.retry_exhausted_failed).toBeGreaterThanOrEqual(1);
    const after = taskCore.getTask(id);
    expect(after.status).toBe('failed');
    expect(after.error_output).toMatch(/retry.*budget.*exhausted|startup-reconciler/i);
  });

  test('conservatively promotes retry_scheduled task with null retry fields to queued', () => {
    const id = randomUUID();
    taskCore.createTask({
      id,
      task_description: 'null retry fields',
      working_directory: testDir,
      provider: 'codex',
      metadata: {},
      status: 'retry_scheduled',
    });

    const result = reconciler.reconcileOrphanedTasksOnStartup({
      db,
      taskCore,
      getMcpInstanceId: () => 'current-instance',
      isInstanceAlive: () => false,
    });

    expect(result.actions.retry_requeued).toBeGreaterThanOrEqual(1);
    const after = taskCore.getTask(id);
    expect(after.status).toBe('queued');
  });

  test('does NOT touch retry_scheduled tasks whose owner instance is still alive', () => {
    const id = randomUUID();
    taskCore.createTask({
      id,
      task_description: 'owned by a peer instance that is still alive',
      working_directory: testDir,
      provider: 'codex',
      metadata: {},
      status: 'retry_scheduled',
      max_retries: 3,
    });
    // Simulate a task owned by a *different* instance that is still alive —
    // e.g. a peer server in a multi-instance deployment whose retry timer
    // hasn't died. The current instance must not poach it.
    db.getDbInstance().prepare('UPDATE tasks SET mcp_instance_id = ? WHERE id = ?').run('peer-live-instance', id);

    const result = reconciler.reconcileOrphanedTasksOnStartup({
      db,
      taskCore,
      getMcpInstanceId: () => 'current-instance',
      isInstanceAlive: (instanceId) => instanceId === 'peer-live-instance',
    });

    expect(result.actions.retry_requeued).toBe(0);
    const after = taskCore.getTask(id);
    expect(after.status).toBe('retry_scheduled');
  });
});
