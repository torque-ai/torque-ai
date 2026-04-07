const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

let db, mod, testDir;
let auditCalls;
let timelineEventsByTask;
let retryHistoryByTask;
let approvalHistoryByTask;

function ensureTaskFileChangesSchema() {
  rawDb().exec(`
    DROP TABLE IF EXISTS task_file_changes;
    CREATE TABLE task_file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      stash_ref TEXT,
      original_content TEXT,
      recorded_at TEXT NOT NULL,
      created_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_file_changes_task ON task_file_changes(task_id);
  `);
}

function injectDependencies() {
  auditCalls = [];
  timelineEventsByTask = new Map();
  retryHistoryByTask = new Map();
  approvalHistoryByTask = new Map();

  mod.setGetTask((id) => db.getTask(id));
  mod.setGetTaskEvents((id) => timelineEventsByTask.get(id) || []);
  mod.setGetRetryHistory((id) => retryHistoryByTask.get(id) || []);
  mod.setRecordAuditLog((...args) => { auditCalls.push(args); });
  mod.setGetApprovalHistory((id) => approvalHistoryByTask.get(id) || []);
  mod.setCreateTask((desc, opts) => db.createTask(desc, opts));
}

function mkTask(overrides = {}) {
  const project = Object.prototype.hasOwnProperty.call(overrides, 'project')
    ? overrides.project
    : 'test-project';
  const task = {
    id: overrides.id || randomUUID(),
    status: overrides.status || 'queued',
    task_description: overrides.task_description || `task-${Math.random().toString(36).slice(2)}`,
    working_directory: overrides.working_directory || testDir,
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    context: overrides.context,
    tags: overrides.tags,
    project,
    provider: overrides.provider || 'codex',
    model: overrides.model || null
  };

  db.createTask(task);
  return db.getTask(task.id);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...entries.map(([, v]) => v), taskId);
}

describe('task-metadata module', () => {
  beforeAll(() => {
    ({ db, mod, testDir } = setupTestDbModule('../db/task-metadata', 'task-metadata'));
    injectDependencies();
    ensureTaskFileChangesSchema();
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    resetTables([
      'task_comments',
      'archived_tasks',
      'task_file_changes',
      'task_groups',
      'tasks'
    ]);
    injectDependencies();
  });

  it('recordFileChange stores changes and getRollbackPoints returns task git snapshot', () => {
    const task = mkTask({
      status: 'completed',
      tags: ['seed']
    });
    patchTask(task.id, {
      git_before_sha: 'abc123',
      git_after_sha: 'def456',
      git_stash_ref: 'stash@{0}'
    });

    mod.recordFileChange(task.id, {
      file_path: 'src/a.js',
      change_type: 'modified',
      stash_ref: 'stash@{0}',
      original_content: 'before-a'
    });
    mod.recordFileChange(task.id, {
      file_path: 'src/b.js',
      change_type: 'created'
    });

    const changes = mod.getTaskFileChanges(task.id);
    const rollback = mod.getRollbackPoints(task.id);

    expect(changes).toHaveLength(2);
    expect(changes[0].file_path).toBe('src/a.js');
    expect(changes[0].stash_ref).toBe('stash@{0}');
    expect(changes[0].original_content).toBe('before-a');
    expect(changes[1].stash_ref).toBeNull();
    expect(changes[1].original_content).toBeNull();
    expect(rollback.task).toEqual({
      id: task.id,
      git_before_sha: 'abc123',
      git_after_sha: 'def456',
      git_stash_ref: 'stash@{0}'
    });
    expect(rollback.fileChanges).toHaveLength(2);
  });

  it('getTaskFileChanges returns empty array when task has no changes', () => {
    const task = mkTask();
    expect(mod.getTaskFileChanges(task.id)).toEqual([]);
  });

  it('recordFileChange throws when required change fields are missing', () => {
    const task = mkTask();
    expect(() => mod.recordFileChange(task.id, { change_type: 'modified' })).toThrow();
  });

  it('getRollbackPoints returns null task when task id is missing', () => {
    const rollback = mod.getRollbackPoints('missing-task-id');
    expect(rollback.task).toBeNull();
    expect(rollback.fileChanges).toEqual([]);
  });

  it('createTaskGroup applies default priority/timeout values', () => {
    const groupId = randomUUID();
    const created = mod.createTaskGroup({
      id: groupId,
      name: 'Core Group'
    });

    expect(created.id).toBe(groupId);
    expect(created.name).toBe('Core Group');
    expect(created.default_priority).toBe(0);
    expect(created.default_timeout).toBe(30);
    expect(created.tasks).toEqual([]);
    expect(created.stats.total).toBe(0);
  });

  it('getTaskGroup returns tasks and stats for an existing group', () => {
    const groupId = randomUUID();
    mod.createTaskGroup({ id: groupId, name: 'Builds' });
    const t1 = mkTask({ status: 'queued', tags: ['x'] });
    const t2 = mkTask({ status: 'completed', tags: ['y'] });
    mod.addTaskToGroup(t1.id, groupId);
    mod.addTaskToGroup(t2.id, groupId);

    const group = mod.getTaskGroup(groupId);
    expect(group).toBeTruthy();
    expect(group.tasks).toHaveLength(2);
    expect(group.stats.total).toBe(2);
    expect(group.stats.queued).toBe(1);
    expect(group.stats.completed).toBe(1);
  });

  it('listTaskGroups filters by project and includes stats for each group', () => {
    const g1 = mod.createTaskGroup({ id: randomUUID(), name: 'Proj A', project: 'proj-a' });
    const g2 = mod.createTaskGroup({ id: randomUUID(), name: 'Proj B', project: 'proj-b' });
    const t1 = mkTask({ status: 'running' });
    mod.addTaskToGroup(t1.id, g1.id);
    mkTask({ status: 'queued' });
    mod.addTaskToGroup(t1.id, g1.id);
    mkTask({ status: 'failed' });

    const all = mod.listTaskGroups();
    const onlyA = mod.listTaskGroups({ project: 'proj-a' });

    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].id).toBe(g1.id);
    expect(onlyA[0].stats.running).toBe(1);
    expect(onlyA[0].stats.total).toBe(1);
    expect(all.some(g => g.id === g2.id)).toBe(true);
  });

  it('getGroupTasks parses tags and auto_approve with newest first ordering', () => {
    const groupId = randomUUID();
    mod.createTaskGroup({ id: groupId, name: 'Order Group' });
    const oldTask = mkTask({ auto_approve: false, tags: ['old'] });
    const newTask = mkTask({ auto_approve: true, tags: ['new'] });
    patchTask(oldTask.id, { created_at: '2026-01-01T00:00:00.000Z' });
    patchTask(newTask.id, { created_at: '2026-01-01T01:00:00.000Z' });
    mod.addTaskToGroup(oldTask.id, groupId);
    mod.addTaskToGroup(newTask.id, groupId);

    const tasks = mod.getGroupTasks(groupId);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe(newTask.id);
    expect(tasks[0].auto_approve).toBe(true);
    expect(tasks[0].tags).toEqual(newTask.tags);
    expect(tasks[1].auto_approve).toBe(false);
  });

  it('getGroupStats counts running queued completed failed statuses', () => {
    const groupId = randomUUID();
    mod.createTaskGroup({ id: groupId, name: 'Stats Group' });
    const statuses = ['running', 'queued', 'completed', 'failed', 'queued'];
    for (const status of statuses) {
      const task = mkTask({ status });
      mod.addTaskToGroup(task.id, groupId);
    }

    const stats = mod.getGroupStats(groupId);
    expect(stats.total).toBe(5);
    expect(stats.running).toBe(1);
    expect(stats.queued).toBe(2);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it('addTaskToGroup updates group_id and returns updated task', () => {
    const groupId = randomUUID();
    mod.createTaskGroup({ id: groupId, name: 'Assignment Group' });
    const task = mkTask();

    const updated = mod.addTaskToGroup(task.id, groupId);
    expect(updated.id).toBe(task.id);
    expect(updated.group_id).toBe(groupId);
  });

  it('deleteTaskGroup with default behavior removes group and clears task group_id', () => {
    const groupId = randomUUID();
    mod.createTaskGroup({ id: groupId, name: 'Delete Group' });
    const task = mkTask();
    mod.addTaskToGroup(task.id, groupId);

    const deleted = mod.deleteTaskGroup(groupId);
    const reloaded = db.getTask(task.id);

    expect(deleted).toBe(true);
    expect(mod.getTaskGroup(groupId)).toBeUndefined();
    expect(reloaded.group_id).toBeNull();
  });

  it('deleteTaskGroup can skip task ungrouping and returns false for missing group', () => {
    const groupId = randomUUID();
    mod.createTaskGroup({ id: groupId, name: 'No Ungroup Group' });
    const task = mkTask();
    mod.addTaskToGroup(task.id, groupId);

    const deleted = mod.deleteTaskGroup(groupId, false);
    const missingDeleted = mod.deleteTaskGroup('missing-group', false);
    const reloaded = db.getTask(task.id);

    expect(deleted).toBe(true);
    expect(missingDeleted).toBe(false);
    expect(reloaded.group_id).toBe(groupId);
  });

  it('updateTaskGitState updates provided git columns', () => {
    const task = mkTask();
    const updated = mod.updateTaskGitState(task.id, {
      before_sha: '111aaa',
      after_sha: '222bbb',
      stash_ref: 'stash@{1}'
    });

    expect(updated.git_before_sha).toBe('111aaa');
    expect(updated.git_after_sha).toBe('222bbb');
    expect(updated.git_stash_ref).toBe('stash@{1}');
  });

  it('updateTaskGitState with no update fields returns current task unchanged', () => {
    const task = mkTask();
    patchTask(task.id, { git_before_sha: 'unchanged-before' });

    const updated = mod.updateTaskGitState(task.id, {});
    expect(updated.git_before_sha).toBe('unchanged-before');
  });

  it('getTasksWithCommits filters by working_directory and applies limit ordering', () => {
    const wdA = path.join(testDir, 'repoA');
    const wdB = path.join(testDir, 'repoB');
    fs.mkdirSync(wdA, { recursive: true });
    fs.mkdirSync(wdB, { recursive: true });

    const a1 = mkTask({ status: 'completed', working_directory: wdA });
    const a2 = mkTask({ status: 'completed', working_directory: wdA });
    const b1 = mkTask({ status: 'completed', working_directory: wdB });
    const noCommit = mkTask({ status: 'completed', working_directory: wdA });

    mod.updateTaskGitState(a1.id, { after_sha: 'a1' });
    mod.updateTaskGitState(a2.id, { after_sha: 'a2' });
    mod.updateTaskGitState(b1.id, { after_sha: 'b1' });

    patchTask(a1.id, { completed_at: '2026-01-01T00:00:00.000Z' });
    patchTask(a2.id, { completed_at: '2026-01-02T00:00:00.000Z' });
    patchTask(b1.id, { completed_at: '2026-01-03T00:00:00.000Z' });
    patchTask(noCommit.id, { completed_at: '2026-01-04T00:00:00.000Z' });

    const filtered = mod.getTasksWithCommits({ working_directory: wdA, limit: 1 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe(a2.id);
    expect(filtered[0].git_after_sha).toBe('a2');
  });

  it('addTaskTags merges and deduplicates tags', () => {
    const task = mkTask({ tags: ['existing', 'shared'] });
    const updated = mod.addTaskTags(task.id, ['shared', 'new', 'existing']);
    expect(updated.tags.sort()).toEqual(['existing', 'new', 'shared', `project:${updated.project}`].sort());
  });

  it('addTaskTags validates input type and element type', () => {
    const task = mkTask();
    expect(() => mod.addTaskTags(task.id, 'bad')).toThrow('tags must be an array');
    expect(() => mod.addTaskTags(task.id, ['ok', 123])).toThrow('tags must be an array of strings');
  });

  it('addTaskTags truncates to 50 tags when over limit', () => {
    const task = mkTask({ tags: ['seed'] });
    const many = Array.from({ length: 60 }, (_, i) => `tag-${i}`);
    const updated = mod.addTaskTags(task.id, many);
    expect(updated.tags).toHaveLength(50);
  });

  it('addTaskTags throws when serialized payload exceeds 10000 bytes', () => {
    const task = mkTask();
    const huge = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, '0')}-${'x'.repeat(260)}`);
    expect(() => mod.addTaskTags(task.id, huge)).toThrow(/Tags payload exceeds maximum size/);
  });

  it('removeTaskTags removes selected tags and persists update', () => {
    const task = mkTask({ tags: ['keep', 'drop', 'drop2'] });
    const updated = mod.removeTaskTags(task.id, ['drop', 'drop2']);
    expect(updated.tags).toEqual(['keep', `project:${updated.project}`]);
  });

  it('removeTaskTags validates input and returns null for missing task', () => {
    const task = mkTask({ tags: ['a'] });
    expect(() => mod.removeTaskTags(task.id, 'bad')).toThrow('tags must be an array');
    expect(() => mod.removeTaskTags(task.id, ['a', 1])).toThrow('tags must be an array of strings');
    expect(mod.removeTaskTags('missing-task', ['a'])).toBeNull();
  });

  it('getAllTags returns sorted unique tags and ignores malformed tag JSON', () => {
    const t1 = mkTask({ tags: ['alpha', 'beta'] });
    const t2 = mkTask({ tags: ['beta', 'gamma'] });
    rawDb().prepare('UPDATE tasks SET tags = ? WHERE id = ?').run('not-json', t1.id);

    const tags = mod.getAllTags();
    expect(tags).toEqual(['beta', 'gamma', `project:${t2.project}`]);
  });

  it('getTagStats returns tag usage counts sorted descending', () => {
    mkTask({ tags: ['z', 'a'] });
    mkTask({ tags: ['z', 'b'] });
    mkTask({ tags: ['z'] });

    const stats = mod.getTagStats();
    expect(stats[0]).toEqual({ tag: 'z', count: 3 });
    const tags = stats.map(s => s.tag);
    expect(tags).toContain('a');
    expect(tags).toContain('b');
  });

  it('batchCancelTasks cancels only pending/queued/running tasks by default', () => {
    const pending = mkTask({ status: 'pending' });
    const queued = mkTask({ status: 'queued' });
    const running = mkTask({ status: 'running' });
    const failed = mkTask({ status: 'failed' });

    const cancelled = mod.batchCancelTasks();

    expect(cancelled).toBe(3);
    expect(db.getTask(pending.id).status).toBe('cancelled');
    expect(db.getTask(queued.id).status).toBe('cancelled');
    expect(db.getTask(running.id).status).toBe('cancelled');
    expect(db.getTask(failed.id).status).toBe('failed');
    expect(db.getTask(pending.id).completed_at).toBeTruthy();
  });

  it('batchCancelTasks applies status, tags, and olderThan filters', () => {
    const oldMatch = mkTask({ status: 'queued', tags: ['ops'] });
    const newMatch = mkTask({ status: 'queued', tags: ['ops'] });
    const wrongStatus = mkTask({ status: 'running', tags: ['ops'] });
    const cutoff = '2026-01-01T12:00:00.000Z';

    patchTask(oldMatch.id, { created_at: '2025-12-31T00:00:00.000Z' });
    patchTask(newMatch.id, { created_at: '2026-01-02T00:00:00.000Z' });
    patchTask(wrongStatus.id, { created_at: '2025-12-31T00:00:00.000Z' });

    const cancelled = mod.batchCancelTasks({
      status: 'queued',
      tags: ['ops'],
      olderThan: cutoff
    });

    expect(cancelled).toBe(1);
    expect(db.getTask(oldMatch.id).status).toBe('cancelled');
    expect(db.getTask(newMatch.id).status).toBe('queued');
    expect(db.getTask(wrongStatus.id).status).toBe('running');
  });

  it('getRetryableTasks returns failed/cancelled tasks and parses tags safely', () => {
    const failed = mkTask({ status: 'failed', tags: ['net'] });
    const cancelled = mkTask({ status: 'cancelled', tags: ['db'] });
    const queued = mkTask({ status: 'queued', tags: ['skip'] });
    rawDb().prepare('UPDATE tasks SET tags = ? WHERE id = ?').run('malformed', cancelled.id);

    const retryable = mod.getRetryableTasks();
    const ids = retryable.map(t => t.id);

    expect(ids).toContain(failed.id);
    expect(ids).toContain(cancelled.id);
    expect(ids).not.toContain(queued.id);
    expect(retryable.find(t => t.id === failed.id).tags).toEqual(['net', `project:${failed.project}`]);
    expect(retryable.find(t => t.id === cancelled.id).tags).toBeNull();
  });

  it('getRetryableTasks filters by escaped tag patterns and limit', () => {
    const t1 = mkTask({ status: 'failed', tags: ['100%_done'] });
    mkTask({ status: 'failed', tags: ['100ABdone'] });
    const t3 = mkTask({ status: 'cancelled', tags: ['100%_done'] });

    patchTask(t1.id, { created_at: '2026-01-01T00:00:00.000Z' });
    patchTask(t3.id, { created_at: '2026-01-02T00:00:00.000Z' });

    const rows = mod.getRetryableTasks({ tags: ['100%_done'], limit: 1 });
    expect(rows).toHaveLength(1);
    expect([t1.id, t3.id]).toContain(rows[0].id);
  });

  it('batchAddTags updates existing tasks and returns updated count', () => {
    const t1 = mkTask({ tags: ['a'] });
    const t2 = mkTask({ tags: [] });
    const updated = mod.batchAddTags([t1.id, t2.id, 'missing'], ['bulk']);

    expect(updated).toBe(2);
    expect(db.getTask(t1.id).tags).toContain('bulk');
    expect(db.getTask(t2.id).tags).toContain('bulk');
  });

  it('batchAddTags throws when provided tags are invalid', () => {
    const t1 = mkTask({ tags: [] });
    expect(() => mod.batchAddTags([t1.id], 'bad')).toThrow('tags must be an array');
  });

  it('batchAddTagsByFilter selects by status and existing tags with optional limit', () => {
    const a = mkTask({ status: 'queued', tags: ['keep'] });
    const b = mkTask({ status: 'queued', tags: ['keep'] });
    mkTask({ status: 'failed', tags: ['keep'] });
    mkTask({ status: 'queued', tags: ['other'] });
    patchTask(a.id, { created_at: '2026-01-01T00:00:00.000Z' });
    patchTask(b.id, { created_at: '2026-01-02T00:00:00.000Z' });

    const updated = mod.batchAddTagsByFilter(
      { status: 'queued', existingTags: ['keep'], limit: 1 },
      ['selected']
    );

    expect(updated).toBe(1);
    const withSelected = [db.getTask(a.id), db.getTask(b.id)].filter(t => t.tags.includes('selected'));
    expect(withSelected).toHaveLength(1);
  });

  it('archiveTask stores task snapshot, reason, and removes active task', () => {
    const task = mkTask({ status: 'failed', tags: ['archive'] });
    patchTask(task.id, {
      output: 'stdout',
      error_output: 'stderr',
      exit_code: 7
    });

    const result = mod.archiveTask(task.id, 'manual');
    const archived = mod.getArchivedTask(task.id);

    expect(result).toBeTruthy();
    expect(result.id).toBe(task.id);
    expect(db.getTask(task.id)).toBeFalsy();
    expect(archived.archive_reason).toBe('manual');
    expect(archived.original_data.id).toBe(task.id);
    expect(archived.original_data.status).toBe('failed');
  });

  it('archiveTask returns not_found for missing tasks', () => {
    const result = mod.archiveTask('missing-task');
    expect(result).toEqual({ success: false, reason: 'not_found' });
  });

  it('archiveTasks archives filtered tasks with default bulk reason and limit', () => {
    const oldTagged = mkTask({ status: 'failed', tags: ['bulk'] });
    const newTagged = mkTask({ status: 'failed', tags: ['bulk'] });
    mkTask({ status: 'completed', tags: ['bulk'] });
    patchTask(oldTagged.id, { created_at: '2025-12-31T00:00:00.000Z' });
    patchTask(newTagged.id, { created_at: '2026-01-02T00:00:00.000Z' });

    const archived = mod.archiveTasks({
      status: 'failed',
      olderThan: '2026-01-01T00:00:00.000Z',
      tags: ['bulk'],
      limit: 1
    });

    expect(archived).toEqual({ archived: 1 });
    const oldRow = mod.getArchivedTask(oldTagged.id);
    expect(oldRow).toBeTruthy();
    expect(oldRow.archive_reason).toBe('Bulk archive');
    expect(db.getTask(newTagged.id)).toBeTruthy();
  });

  it('getArchivedTask parses malformed JSON and listArchivedTasks honors limit', () => {
    const task = mkTask({ status: 'completed' });
    mod.archiveTask(task.id, 'ok');

    rawDb().prepare(`
      INSERT INTO archived_tasks (id, original_data, archived_at, archive_reason)
      VALUES (?, ?, ?, ?)
    `).run('bad-json', '{oops', '2026-01-01T00:00:00.000Z', 'broken');

    const bad = mod.getArchivedTask('bad-json');
    const listed = mod.listArchivedTasks({ limit: 1 });
    const listedDefault = mod.listArchivedTasks();

    expect(bad.original_data).toEqual({});
    expect(listed).toHaveLength(1);
    expect(listedDefault.length).toBeGreaterThanOrEqual(2);
    expect(listedDefault.length).toBeLessThanOrEqual(100);
  });

  it('restoreTask recreates archived task, restores output fields, and removes archive record', () => {
    const task = mkTask({ status: 'completed', task_description: 'restore me', tags: ['r1'] });
    patchTask(task.id, {
      output: 'done-output',
      error_output: 'done-error',
      exit_code: 0,
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:01:00.000Z'
    });
    mod.archiveTask(task.id, 'restore-test');
    expect(db.getTask(task.id)).toBeFalsy();

    const restored = mod.restoreTask(task.id);
    const active = db.getTask(task.id);
    const archived = mod.getArchivedTask(task.id);

    expect(restored.id).toBe(task.id);
    expect(active).toBeTruthy();
    expect(active.task_description).toBe('restore me');
    expect(active.output).toBe('done-output');
    expect(active.error_output).toBe('done-error');
    expect(active.exit_code).toBe(0);
    expect(archived).toBeUndefined();
  });

  it('deleteArchivedTask and getArchiveStats return expected archive state', () => {
    const t1 = mkTask({ status: 'failed' });
    const t2 = mkTask({ status: 'failed' });
    mod.archiveTask(t1.id, 'reason-a');
    mod.archiveTask(t2.id, 'reason-b');

    expect(mod.deleteArchivedTask(t1.id)).toBe(true);
    expect(mod.deleteArchivedTask('missing')).toBe(false);

    const stats = mod.getArchiveStats();
    expect(stats.total_archived).toBe(1);
    expect(stats.oldest_archive).toBeTruthy();
    expect(stats.newest_archive).toBeTruthy();
    expect(stats.by_reason).toHaveLength(1);
    expect(stats.by_reason[0].archive_reason).toBe('reason-b');
    expect(stats.by_reason[0].count).toBe(1);
  });

  it('addTaskComment inserts comment and records audit log entry', () => {
    const task = mkTask();
    const commentId = mod.addTaskComment(task.id, 'needs follow-up', {
      author: 'alice',
      commentType: 'review'
    });

    const rows = mod.getTaskComments(task.id);
    expect(commentId).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].author).toBe('alice');
    expect(rows[0].comment_type).toBe('review');

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][0]).toBe('task');
    expect(auditCalls[0][1]).toBe(task.id);
    expect(auditCalls[0][2]).toBe('comment_added');
  });

  it('getTaskComments supports commentType filter and limit with latest-first ordering', () => {
    const task = mkTask();
    rawDb().prepare(`
      INSERT INTO task_comments (task_id, author, comment_text, comment_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(task.id, 'u1', 'old note', 'note', '2026-01-01T00:00:00.000Z');
    rawDb().prepare(`
      INSERT INTO task_comments (task_id, author, comment_text, comment_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(task.id, 'u2', 'review one', 'review', '2026-01-01T01:00:00.000Z');
    rawDb().prepare(`
      INSERT INTO task_comments (task_id, author, comment_text, comment_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(task.id, 'u3', 'review two', 'review', '2026-01-01T02:00:00.000Z');

    const reviews = mod.getTaskComments(task.id, { commentType: 'review', limit: 1 });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].comment_text).toBe('review two');
  });

  it('deleteTaskComment removes comments, records audit, and returns false when missing', () => {
    const task = mkTask();
    const commentId = mod.addTaskComment(task.id, 'delete me', { author: 'bob' });
    auditCalls = [];

    const deleted = mod.deleteTaskComment(commentId, 'moderator');
    const deletedMissing = mod.deleteTaskComment(999999, 'moderator');

    expect(deleted).toBe(true);
    expect(deletedMissing).toBe(false);
    expect(mod.getTaskComments(task.id)).toEqual([]);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][2]).toBe('comment_deleted');
    expect(auditCalls[0][3]).toBe('moderator');
  });

  it('getTaskTimeline merges task lifecycle, events, comments, retries, approvals and applies limit', () => {
    const task = mkTask({ status: 'completed', task_description: 'timeline task coverage' });
    patchTask(task.id, {
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      completed_at: '2026-01-01T00:06:00.000Z',
      exit_code: 5
    });
    rawDb().prepare(`
      INSERT INTO task_comments (task_id, author, comment_text, comment_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(task.id, 'alice', 'timeline comment', 'note', '2026-01-01T00:03:00.000Z');

    timelineEventsByTask.set(task.id, [{
      event_type: 'status_change',
      old_value: 'queued',
      new_value: 'running',
      event_data: '{"phase":"start"}',
      created_at: '2026-01-01T00:02:00.000Z'
    }]);
    retryHistoryByTask.set(task.id, [{
      attempt_number: 2,
      delay_used: 30,
      error_message: 'network',
      retried_at: '2026-01-01T00:04:00.000Z'
    }]);
    approvalHistoryByTask.set(task.id, [{
      status: 'approved',
      rule_name: 'high-risk',
      approved_by: 'lead',
      approved_at: '2026-01-01T00:05:00.000Z',
      requested_at: '2026-01-01T00:05:00.000Z'
    }]);

    const full = mod.getTaskTimeline(task.id);
    const limited = mod.getTaskTimeline(task.id, { limit: 4 });

    expect(full.map(x => x.type)).toEqual([
      'created',
      'started',
      'event',
      'comment',
      'retry',
      'approval',
      'completed'
    ]);
    expect(full[2].data.event_data).toEqual({ phase: 'start' });
    expect(full[6].data.exit_code).toBe(5);
    expect(limited).toHaveLength(4);
    expect(limited[3].type).toBe('comment');
  });
});
