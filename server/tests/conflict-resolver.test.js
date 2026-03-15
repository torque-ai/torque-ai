const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { gitSync, cleanupRepo } = require('./git-test-utils');
const workflowRuntime = require('../execution/workflow-runtime');
const { resolveWorkflowConflicts } = require('../execution/conflict-resolver');

let ctx;
let db;
let repoDir;

function git(args, cwd = repoDir) {
  return gitSync(args, { cwd });
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createRepo() {
  repoDir = path.join(ctx.testDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  git(['init']);
  git(['config', 'user.email', 'vitest@example.com']);
  git(['config', 'user.name', 'Vitest']);
}

function commitBaseFile(relativePath, content) {
  const absolutePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  git(['add', relativePath]);
  git(['commit', '-m', 'base', '--no-gpg-sign']);
  return git(['rev-parse', 'HEAD']);
}

function createWorkflow(name = 'conflict-workflow') {
  const workflowId = randomUUID();
  db.createWorkflow({
    id: workflowId,
    name,
    status: 'running',
    working_directory: repoDir
  });
  return workflowId;
}

function createWorkflowTask(workflowId, nodeId) {
  const taskId = randomUUID();
  db.createTask({
    id: taskId,
    task_description: `task ${nodeId}`,
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    working_directory: repoDir,
    status: 'completed',
    provider: 'codex'
  });
  return taskId;
}

function writeTaskSnapshot(taskId, relativePath, content, beforeSha) {
  const absolutePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  db.updateTaskGitState(taskId, { before_sha: beforeSha });
  db.recordTaskFileWrite(taskId, relativePath, sha256(content));
}

describe('conflict resolver', () => {
  beforeEach(() => {
    ctx = setupTestDb('conflict-resolver');
    db = ctx.db;
    createRepo();
    workflowRuntime.init({
      db,
      dashboard: {
        notifyWorkflowUpdated: vi.fn(),
        notifyStatsUpdated: vi.fn()
      }
    });
  });

  afterEach(() => {
    teardownTestDb();
    cleanupRepo(repoDir);
    ctx = null;
    db = null;
    repoDir = null;
    vi.restoreAllMocks();
  });

  it('tracks conflicted files touched by multiple workflow tasks', () => {
    const beforeSha = commitBaseFile('src/shared.txt', 'alpha\nbeta\ngamma\n');
    const workflowId = createWorkflow();
    const taskA = createWorkflowTask(workflowId, 'a');
    const taskB = createWorkflowTask(workflowId, 'b');

    writeTaskSnapshot(taskA, 'src/shared.txt', 'alpha\nbeta from a\ngamma\n', beforeSha);
    writeTaskSnapshot(taskB, 'src/shared.txt', 'alpha\nbeta\ngamma from b\n', beforeSha);

    expect(db.getConflictedFiles(workflowId)).toEqual([
      expect.objectContaining({
        file_path: 'src/shared.txt',
        task_count: 2,
        task_ids: expect.arrayContaining([taskA, taskB])
      })
    ]);
  });

  it('auto-merges disjoint edits and writes the merged file', () => {
    const beforeSha = commitBaseFile('src/shared.txt', 'alpha\nbeta\ngamma\n');
    const workflowId = createWorkflow();
    const taskA = createWorkflowTask(workflowId, 'a');
    const taskB = createWorkflowTask(workflowId, 'b');

    writeTaskSnapshot(taskA, 'src/shared.txt', 'alpha\nbeta from a\ngamma\n', beforeSha);
    writeTaskSnapshot(taskB, 'src/shared.txt', 'alpha\nbeta\ngamma\nfrom b\n', beforeSha);

    const result = resolveWorkflowConflicts(workflowId);

    expect(result.conflicts).toEqual([]);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]).toEqual(expect.objectContaining({
      file_path: 'src/shared.txt',
      task_ids: expect.arrayContaining([taskA, taskB])
    }));
    expect(fs.readFileSync(path.join(repoDir, 'src/shared.txt'), 'utf8')).toBe(
      'alpha\nbeta from a\ngamma\nfrom b\n'
    );
  });

  it('reports manual conflicts for overlapping edits and leaves the file unchanged', () => {
    const beforeSha = commitBaseFile('src/shared.txt', 'alpha\nbeta\ngamma\n');
    const workflowId = createWorkflow();
    const taskA = createWorkflowTask(workflowId, 'a');
    const taskB = createWorkflowTask(workflowId, 'b');

    writeTaskSnapshot(taskA, 'src/shared.txt', 'alpha\nbeta from a\ngamma\n', beforeSha);
    writeTaskSnapshot(taskB, 'src/shared.txt', 'alpha\nbeta from b\ngamma\n', beforeSha);

    const lastWriterContent = 'alpha\nbeta from b\ngamma\n';
    const result = resolveWorkflowConflicts(workflowId);

    expect(result.merged).toEqual([]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        file_path: 'src/shared.txt',
        task_ids: expect.arrayContaining([taskA, taskB])
      })
    ]);
    expect(fs.readFileSync(path.join(repoDir, 'src/shared.txt'), 'utf8')).toBe(lastWriterContent);
  });

  it('runs auto-merge from workflow completion and exposes the tool handler', async () => {
    const beforeSha = commitBaseFile('src/shared.txt', 'alpha\nbeta\ngamma\n');
    const workflowId = createWorkflow('runtime-merge');
    const taskA = createWorkflowTask(workflowId, 'a');
    const taskB = createWorkflowTask(workflowId, 'b');

    writeTaskSnapshot(taskA, 'src/shared.txt', 'alpha\nbeta from a\ngamma\n', beforeSha);
    writeTaskSnapshot(taskB, 'src/shared.txt', 'alpha\nbeta\ngamma\nfrom b\n', beforeSha);

    workflowRuntime.checkWorkflowCompletion(workflowId);
    expect(fs.readFileSync(path.join(repoDir, 'src/shared.txt'), 'utf8')).toBe(
      'alpha\nbeta from a\ngamma\nfrom b\n'
    );

    const toolResult = await safeTool('resolve_workflow_conflicts', { workflow_id: workflowId });
    expect(toolResult.isError).toBeFalsy();
    expect(getText(toolResult)).toContain('Workflow Conflict Resolution');
    expect(getText(toolResult)).toContain('**Merged files:** 1');
  });
});
