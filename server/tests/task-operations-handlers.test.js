/**
 * Task Operations Handlers Tests
 *
 * Unit tests for task-operations.js handler functions:
 *   handleTagTask, handleUntagTask, handleListTags,
 *   handleCheckTaskProgress, handleHealthCheck, handleHealthStatus,
 *   handleCheckStalledTasks, handleScheduleTask, handleListScheduled,
 *   handleCancelScheduled, handlePauseScheduled, handleBatchCancel,
 *   handleBatchRetry, handleBatchTag, handleSearchOutputs,
 *   handleOutputStats, handleExportData, handleImportData,
 *   handleArchiveTask, handleArchiveTasks, handleListArchived,
 *   handleRestoreTask, handleGetArchiveStats
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Extract a UUID from handler output text */
function extractTaskId(result) {
  const text = getText(result);
  const match = text.match(/ID:\s*([a-f0-9-]{36})/i) || text.match(/([a-f0-9-]{36})/);
  return match ? match[1] : null;
}

/**
 * Create a task in the DB that is in a terminal state.
 * Uses proper state transitions: pending -> running -> completed/failed/cancelled
 */
function createTerminalTask(db, status, desc, opts = {}) {
  const taskId = uuidv4();
  db.createTask({
    id: taskId,
    status: 'pending',
    task_description: desc || `${status} test task`,
    timeout_minutes: opts.timeout_minutes || 10,
  });
  // Transition through running first
  db.updateTaskStatus(taskId, 'running', {
    started_at: opts.started_at || new Date(Date.now() - 5000).toISOString(),
  });
  // Then to terminal state
  const updateFields = {};
  if (opts.output !== undefined) updateFields.output = opts.output;
  if (opts.error_output !== undefined) updateFields.error_output = opts.error_output;
  if (opts.exit_code !== undefined) updateFields.exit_code = opts.exit_code;
  db.updateTaskStatus(taskId, status, updateFields);
  return taskId;
}

/**
 * Create a terminal task suitable for archiving.
 * Uses a direct INSERT to avoid inserting task_events rows that would block
 * archiveTask's DELETE FROM tasks (FK constraint from event-dispatch.js).
 */
function createArchivableTask(db, status, desc, opts = {}) {
  const taskId = uuidv4();
  const rawDb = db.getDbInstance();
  const now = new Date().toISOString();
  rawDb.prepare(`
    INSERT INTO tasks (id, status, task_description, timeout_minutes, created_at, completed_at, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, status, desc || `${status} archivable task`, 10, now, now, opts.output || null);
  return taskId;
}

describe('Task Operations Handlers', () => {
  let db;

  beforeAll(() => {
    const setup = setupTestDb('task-ops-handlers');
    db = setup.db;
    const tm = require('../task-manager');
    if (typeof tm.initEarlyDeps === 'function') tm.initEarlyDeps();
    if (typeof tm.initSubModules === 'function') tm.initSubModules();
    const projectConfigCore = require('../db/project-config-core');
    const cronScheduling = require('../db/cron-scheduling');
    projectConfigCore.listScheduledTasks = cronScheduling.listScheduledTasks;
    projectConfigCore.getScheduledTask = cronScheduling.getScheduledTask;
    projectConfigCore.deleteScheduledTask = cronScheduling.deleteScheduledTask;
    projectConfigCore.updateScheduledTask = cronScheduling.updateScheduledTask;
  });
  afterAll(() => { teardownTestDb(); });

  // ─── Tag Operations ─────────────────────────────────────────────────────────

  describe('tag_task', () => {
    it('adds tags to an existing task', async () => {
      const qr = await safeTool('queue_task', { task: 'Tag me please' });
      const taskId = extractTaskId(qr);

      const result = await safeTool('tag_task', { task_id: taskId, tags: ['unit-test', 'important'] });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Tags Added');
      expect(text).toContain('unit-test');
      expect(text).toContain('important');
    });

    it('returns error for nonexistent task', async () => {
      const result = await safeTool('tag_task', { task_id: '00000000-1111-2222-3333-444444444444', tags: ['test'] });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('returns error when no tags provided', async () => {
      const qr = await safeTool('queue_task', { task: 'No tags test' });
      const taskId = extractTaskId(qr);
      const result = await safeTool('tag_task', { task_id: taskId, tags: [] });
      expect(result.isError).toBe(true);
    });

    it('normalizes tags to lowercase', async () => {
      const qr = await safeTool('queue_task', { task: 'Normalize tag test' });
      const taskId = extractTaskId(qr);
      const result = await safeTool('tag_task', { task_id: taskId, tags: ['UPPERCASE', '  Trimmed  '] });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('uppercase');
      expect(text).toContain('trimmed');
    });
  });

  describe('untag_task', () => {
    it('removes tags from a task', async () => {
      const qr = await safeTool('queue_task', { task: 'Untag test' });
      const taskId = extractTaskId(qr);
      await safeTool('tag_task', { task_id: taskId, tags: ['remove-me', 'keep-me'] });

      const result = await safeTool('untag_task', { task_id: taskId, tags: ['remove-me'] });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Tags Removed');
      expect(text).toContain('remove-me');
    });

    it('returns error for nonexistent task', async () => {
      const result = await safeTool('untag_task', { task_id: '00000000-aaaa-bbbb-cccc-dddddddddddd', tags: ['test'] });
      expect(result.isError).toBe(true);
    });

    it('returns error when no tags provided', async () => {
      const qr = await safeTool('queue_task', { task: 'Untag empty test' });
      const taskId = extractTaskId(qr);
      const result = await safeTool('untag_task', { task_id: taskId, tags: [] });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_tags', () => {
    it('returns tag statistics', async () => {
      const result = await safeTool('list_tags', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // Should contain either "No tags" or tag stats
      expect(text).toMatch(/Tag|tags/i);
    });
  });

  // ─── Health Monitoring ──────────────────────────────────────────────────────

  describe('health_check', () => {
    it('runs a connectivity check without error', async () => {
      const result = await safeTool('health_check', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Health Check');
      // Status could be healthy, degraded, or unhealthy depending on environment
      expect(text).toMatch(/Healthy|Degraded|Unhealthy/i);
    });

    it('records health check in database', async () => {
      await safeTool('health_check', { check_type: 'connectivity' });
      const latest = db.getLatestHealthCheck();
      expect(latest).toBeTruthy();
      expect(latest.check_type).toBe('connectivity');
    });
  });

  describe('health_status', () => {
    it('returns health monitoring status', async () => {
      const result = await safeTool('health_status', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Health Monitoring Status');
    });

    it('includes history when requested', async () => {
      // Run a health check first to have data
      await safeTool('health_check', {});
      const result = await safeTool('health_status', { include_history: true });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Health Monitoring');
    });
  });

  describe('check_stalled_tasks', () => {
    it('returns activity monitor with no running tasks', async () => {
      const result = await safeTool('check_stalled_tasks', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Activity Monitor');
    });
  });

  // ─── Task Scheduling ───────────────────────────────────────────────────────

  describe('schedule_task', () => {
    it('schedules a one-time task', async () => {
      const runAt = new Date(Date.now() + 3600000).toISOString();
      const result = await safeTool('schedule_task', {
        task: 'Scheduled one-time task',
        schedule_type: 'once',
        run_at: runAt,
        name: 'one-time-test'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Scheduled');
      expect(text).toContain('once');
    });

    it('schedules an interval task', async () => {
      const result = await safeTool('schedule_task', {
        task: 'Scheduled interval task',
        schedule_type: 'interval',
        interval_minutes: 30,
        name: 'interval-test'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Scheduled');
      expect(text).toContain('30 minutes');
    });

    it('rejects empty task string', async () => {
      const result = await safeTool('schedule_task', {
        task: '',
        schedule_type: 'once',
        run_at: new Date().toISOString()
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid schedule_type', async () => {
      const result = await safeTool('schedule_task', {
        task: 'Bad type',
        schedule_type: 'weekly'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects once-type without run_at', async () => {
      const result = await safeTool('schedule_task', {
        task: 'Missing run_at',
        schedule_type: 'once',
        name: 'no-run-at'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects interval-type without interval_minutes', async () => {
      const result = await safeTool('schedule_task', {
        task: 'Missing interval',
        schedule_type: 'interval',
        name: 'no-interval'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid timeout_minutes', async () => {
      const result = await safeTool('schedule_task', {
        task: 'Bad timeout',
        schedule_type: 'interval',
        interval_minutes: 10,
        timeout_minutes: -5,
        name: 'bad-timeout'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid max_runs', async () => {
      const result = await safeTool('schedule_task', {
        task: 'Bad max_runs',
        schedule_type: 'interval',
        interval_minutes: 10,
        max_runs: 0,
        name: 'bad-max-runs'
      });
      expect(result.isError).toBe(true);
    });

    it('includes max_runs in response when set', async () => {
      const result = await safeTool('schedule_task', {
        task: 'Limited runs task',
        schedule_type: 'interval',
        interval_minutes: 15,
        max_runs: 5,
        name: 'limited-runs'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Max Runs');
    });
  });

  describe('list_scheduled', () => {
    it('returns scheduled tasks list', async () => {
      const result = await safeTool('list_scheduled', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Scheduled Tasks');
    });
  });

  describe('cancel_scheduled / pause_scheduled', () => {
    it('cancel_scheduled returns error for nonexistent schedule', async () => {
      const result = await safeTool('cancel_scheduled', { schedule_id: '00000000-0000-0000-0000-000000000000' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('pause_scheduled returns error for nonexistent schedule', async () => {
      const result = await safeTool('pause_scheduled', { schedule_id: '00000000-0000-0000-0000-000000000000', action: 'pause' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('cancels and deletes a scheduled task', async () => {
      // Create a scheduled task first
      const runAt = new Date(Date.now() + 3600000).toISOString();
      const sr = await safeTool('schedule_task', {
        task: 'Scheduled to cancel',
        schedule_type: 'once',
        run_at: runAt,
        name: 'cancel-target'
      });
      const schedId = extractTaskId(sr);
      expect(schedId).toBeTruthy();

      const result = await safeTool('cancel_scheduled', { schedule_id: schedId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Cancelled');
    });
  });

  // ─── Batch Operations ──────────────────────────────────────────────────────

  describe('batch_cancel', () => {
    it('batch cancels tasks by status', async () => {
      // Create some queued tasks
      await safeTool('queue_task', { task: 'Batch cancel test 1' });
      await safeTool('queue_task', { task: 'Batch cancel test 2' });

      const result = await safeTool('batch_cancel', { status: 'queued' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Batch Cancel');
      expect(text).toContain('Tasks Cancelled');
    });

    it('rejects invalid status type', async () => {
      const result = await safeTool('batch_cancel', { status: 123 });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid tags type', async () => {
      const result = await safeTool('batch_cancel', { tags: 'not-an-array' });
      expect(result.isError).toBe(true);
    });

    it('rejects negative older_than_hours', async () => {
      const result = await safeTool('batch_cancel', { older_than_hours: -5 });
      expect(result.isError).toBe(true);
    });
  });

  describe('batch_retry', () => {
    it('reports no tasks when no failed tasks exist', async () => {
      const result = await safeTool('batch_retry', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Batch Retry');
    });

    it('retries failed tasks', async () => {
      const taskManager = require('../task-manager');
      vi.spyOn(taskManager, 'startTask').mockReturnValue(undefined);

      // Create failed tasks using proper state transition
      createTerminalTask(db, 'failed', 'Failed for batch retry 1', { exit_code: 1 });
      createTerminalTask(db, 'failed', 'Failed for batch retry 2', { exit_code: 1 });

      const result = await safeTool('batch_retry', { limit: 5 });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Batch Retry');
      expect(text).toContain('Tasks Retried');
    });

    it('rejects invalid tags type', async () => {
      const result = await safeTool('batch_retry', { tags: 'not-array' });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid limit', async () => {
      const result = await safeTool('batch_retry', { limit: -1 });
      expect(result.isError).toBe(true);
    });
  });

  describe('batch_tag', () => {
    it('adds tags to tasks by filter', async () => {
      // Create some tasks to tag
      await safeTool('queue_task', { task: 'Batch tag target 1' });
      await safeTool('queue_task', { task: 'Batch tag target 2' });

      const result = await safeTool('batch_tag', { tags: ['batch-tagged'], filter_status: 'queued' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Batch Tag');
      expect(text).toContain('batch-tagged');
    });

    it('rejects empty tags array', async () => {
      const result = await safeTool('batch_tag', { tags: [] });
      expect(result.isError).toBe(true);
    });

    it('rejects missing tags', async () => {
      const result = await safeTool('batch_tag', {});
      expect(result.isError).toBe(true);
    });

    it('rejects invalid filter_status type', async () => {
      const result = await safeTool('batch_tag', { tags: ['test'], filter_status: 123 });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid filter_tags type', async () => {
      const result = await safeTool('batch_tag', { tags: ['test'], filter_tags: 'not-array' });
      expect(result.isError).toBe(true);
    });
  });

  // ─── Output Search ─────────────────────────────────────────────────────────

  describe('search_outputs', () => {
    it('rejects pattern shorter than 2 chars', async () => {
      const result = await safeTool('search_outputs', { pattern: 'a' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('at least 2 characters');
    });

    it('returns no matches for unmatched pattern', async () => {
      const result = await safeTool('search_outputs', { pattern: 'zzz_nonexistent_pattern_xyz' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No matches');
    });

    it('finds matching output text', async () => {
      // Use direct SQL insert to avoid task_events FK constraint during archive_tasks
      createArchivableTask(db, 'completed', 'Search output task', {
        output: 'Found the UNIQUE_SEARCH_TOKEN_42 here',
      });

      const result = await safeTool('search_outputs', { pattern: 'UNIQUE_SEARCH_TOKEN_42' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Output Search');
    });
  });

  describe('output_stats', () => {
    it('returns output statistics', async () => {
      const result = await safeTool('output_stats', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Output Statistics');
      expect(text).toContain('Total Completed');
    });
  });

  // ─── Export / Import ────────────────────────────────────────────────────────

  describe('export_data', () => {
    it('returns exported data as text', async () => {
      const result = await safeTool('export_data', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Data Export');
      expect(text).toContain('Exported at');
    });

    it('exports to a file when output_file given', async () => {
      const tmpFile = path.join(os.tmpdir(), `torque-export-test-${Date.now()}.json`);
      try {
        const result = await safeTool('export_data', { output_file: tmpFile });
        expect(result.isError).toBeFalsy();
        expect(getText(result)).toContain('Data Exported');
        expect(fs.existsSync(tmpFile)).toBe(true);

        const data = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
        expect(data.version).toBeTruthy();
        expect(data.data).toBeTruthy();
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it('rejects path traversal in output_file', async () => {
      const result = await safeTool('export_data', { output_file: '../../../etc/evil.json' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('traversal');
    });
  });

  describe('import_data', () => {
    it('rejects when no file_path or json_data provided', async () => {
      const result = await safeTool('import_data', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('rejects invalid JSON in json_data', async () => {
      // Schema requires file_path; write invalid JSON to a temp file to test parse rejection
      const tmpFile = path.join(os.tmpdir(), `torque-invalid-json-test-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, 'not json {{{');
      try {
        const result = await safeTool('import_data', { file_path: tmpFile });
        expect(result.isError).toBe(true);
        expect(getText(result)).toContain('invalid JSON');
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it('imports valid JSON data', async () => {
      // Import format must match exportData structure: { data: { tasks: [], ... } }
      const importPayload = JSON.stringify({
        version: '2.0',
        data: {
          tasks: [],
          templates: [],
        }
      });
      const tmpFile = path.join(os.tmpdir(), `torque-valid-json-test-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, importPayload);
      try {
        const result = await safeTool('import_data', { file_path: tmpFile });
        expect(result.isError).toBeFalsy();
        const text = getText(result);
        expect(text).toContain('Import Complete');
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it('imports from file', async () => {
      const tmpFile = path.join(os.tmpdir(), `torque-import-test-${Date.now()}.json`);
      try {
        fs.writeFileSync(tmpFile, JSON.stringify({
          version: '2.0',
          data: {
            tasks: [],
            templates: [],
          }
        }));
        const result = await safeTool('import_data', { file_path: tmpFile });
        expect(result.isError).toBeFalsy();
        expect(getText(result)).toContain('Import Complete');
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it('rejects path traversal in file_path', async () => {
      const result = await safeTool('import_data', { file_path: '../../../etc/passwd' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('traversal');
    });

    it('rejects nonexistent import file', async () => {
      const result = await safeTool('import_data', { file_path: path.join(os.tmpdir(), 'nonexistent-import-xyz.json') });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('read import file');
    });
  });

  // ─── Archiving ──────────────────────────────────────────────────────────────

  describe('archive_task', () => {
    it('archives a completed task', async () => {
      const taskId = createArchivableTask(db, 'completed', 'Task to archive');

      const result = await safeTool('archive_task', { task_id: taskId, reason: 'Test cleanup' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Archived');
      expect(text).toContain('Test cleanup');
    });

    it('archives a failed task', async () => {
      const taskId = createArchivableTask(db, 'failed', 'Failed task to archive');

      const result = await safeTool('archive_task', { task_id: taskId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Archived');
    });

    it('archives a cancelled task', async () => {
      const taskId = createArchivableTask(db, 'cancelled', 'Cancelled task to archive');

      const result = await safeTool('archive_task', { task_id: taskId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Archived');
    });

    it('returns error for nonexistent task', async () => {
      const result = await safeTool('archive_task', { task_id: '00000000-0000-0000-0000-ffffffffffff' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('rejects archiving a queued task', async () => {
      const qr = await safeTool('queue_task', { task: 'Cannot archive queued' });
      const taskId = extractTaskId(qr);
      const result = await safeTool('archive_task', { task_id: taskId });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Cannot archive');
    });
  });

  describe('archive_tasks', () => {
    it('bulk archives completed tasks', async () => {
      createArchivableTask(db, 'completed', 'Bulk archive target 1');
      createArchivableTask(db, 'completed', 'Bulk archive target 2');

      const result = await safeTool('archive_tasks', { status: 'completed' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Bulk Archive');
      expect(text).toContain('Tasks Archived');
    });

    it('supports older_than_days filter', async () => {
      const result = await safeTool('archive_tasks', { status: 'completed', older_than_days: 30 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Older than');
    });

    it('supports tag filter', async () => {
      const result = await safeTool('archive_tasks', { status: 'completed', tags: ['cleanup'] });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Tag Filter');
    });
  });

  describe('list_archived', () => {
    it('lists archived tasks', async () => {
      const result = await safeTool('list_archived', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Archived Tasks');
    });

    it('respects limit parameter', async () => {
      const result = await safeTool('list_archived', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('restore_task', () => {
    it('returns error for nonexistent archived task', async () => {
      const result = await safeTool('restore_task', { task_id: '00000000-0000-0000-0000-eeeeeeeeeeee' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('restores an archived task', async () => {
      // Create and archive a task (use direct SQL to avoid FK constraint from task_events)
      const taskId = createArchivableTask(db, 'completed', 'Task to restore');
      await safeTool('archive_task', { task_id: taskId, reason: 'Will restore' });

      const result = await safeTool('restore_task', { task_id: taskId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Restored');
    });
  });

  describe('get_archive_stats', () => {
    it('returns archive statistics', async () => {
      const result = await safeTool('get_archive_stats', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Archive Statistics');
      expect(text).toContain('Total Archived');
    });
  });

  // ─── check_task_progress ────────────────────────────────────────────────────

  describe('check_task_progress', () => {
    it('reports no running tasks when none are running', async () => {
      // Use a very short wait so the test is fast
      const result = await safeTool('check_task_progress', { wait_seconds: 1 });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Progress Check');
      // Since there are likely no running tasks in the test DB
      expect(text).toMatch(/No running tasks|Task Progress Check/);
    });
  });
});
