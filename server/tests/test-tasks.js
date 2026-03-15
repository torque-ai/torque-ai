/**
 * Task Lifecycle Tests
 *
 * Tests for core task management: create, status, cancel, retry, etc.
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { uniqueId, extractTaskId } = require('./test-helpers');

describe('Task Lifecycle', () => {
  beforeAll(() => { setupTestDb('task-lifecycle'); });
  afterAll(() => { teardownTestDb(); });

  describe('Task Creation', () => {
    it('queue_task accepts valid input', async () => {
      const result = await safeTool('queue_task', {
        task: 'Test task for unit testing - should be queued'
      });
      expect(result.isError).toBeFalsy();
    });

    it('queue_task returns a task ID', async () => {
      const result = await safeTool('queue_task', {
        task: 'Task with ID check'
      });
      const taskId = extractTaskId(result);
      expect(taskId).not.toBeNull();
    });

    it('queue_task rejects empty task', async () => {
      const result = await safeTool('queue_task', { task: '' });
      expect(result.isError).toBe(true);
    });

    it('queue_task rejects whitespace-only task', async () => {
      const result = await safeTool('queue_task', { task: '   ' });
      expect(result.isError).toBe(true);
    });
  });

  describe('Task Status', () => {
    let taskId;

    beforeAll(async () => {
      const result = await safeTool('queue_task', { task: 'Task for status check' });
      taskId = extractTaskId(result);
    });

    it('check_status returns for valid task', async () => {
      expect(taskId).not.toBeNull();
      const result = await safeTool('check_status', { task_id: taskId });
      expect(result.isError).toBeFalsy();
    });

    it('check_status rejects invalid task ID', async () => {
      const result = await safeTool('check_status', { task_id: 'nonexistent_task_12345' });
      expect(result.isError).toBe(true);
    });

    it('list_tasks returns results', async () => {
      const result = await safeTool('list_tasks', { limit: 10 });
      expect(result.isError).toBeFalsy();
    });

    it('list_tasks accepts status filter', async () => {
      const result = await safeTool('list_tasks', { status: 'queued', limit: 5 });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('Task Cancellation', () => {
    it('cancel_task succeeds for queued task', async () => {
      const queueResult = await safeTool('queue_task', { task: 'Task to cancel' });
      const taskId = extractTaskId(queueResult);
      expect(taskId).not.toBeNull();

      const cancelResult = await safeTool('cancel_task', { task_id: taskId, confirm: true });
      expect(cancelResult.isError).toBeFalsy();

      const statusResult = await safeTool('check_status', { task_id: taskId });
      expect(getText(statusResult)).toContain('cancelled');
    });

    it('cancel_task rejects invalid task ID', async () => {
      const result = await safeTool('cancel_task', { task_id: 'nonexistent_12345' });
      expect(result.isError).toBe(true);
    });
  });

  describe('Task Tagging', () => {
    let taskId;

    beforeAll(async () => {
      const result = await safeTool('queue_task', { task: 'Task to tag' });
      taskId = extractTaskId(result);
    });

    it('tag_task adds tags successfully', async () => {
      expect(taskId).not.toBeNull();
      const result = await safeTool('tag_task', {
        task_id: taskId,
        tags: ['test', 'unit-test']
      });
      expect(result.isError).toBeFalsy();
    });

    it('untag_task removes tags successfully', async () => {
      const result = await safeTool('untag_task', {
        task_id: taskId,
        tags: ['unit-test']
      });
      expect(result.isError).toBeFalsy();
    });

    it('list_tags returns results', async () => {
      const result = await safeTool('list_tags', {});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('Task Groups', () => {
    it('create_group creates group', async () => {
      const r1 = await safeTool('queue_task', { task: 'Group task 1' });
      const r2 = await safeTool('queue_task', { task: 'Group task 2' });
      const ids = [extractTaskId(r1), extractTaskId(r2)].filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);

      const result = await safeTool('create_group', {
        name: uniqueId('group'),
        task_ids: ids
      });
      expect(result.isError).toBeFalsy();
    });

    it('list_groups returns results', async () => {
      const result = await safeTool('list_groups', {});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('Input Validation', () => {
    it('queue_task rejects missing task', async () => {
      const result = await safeTool('queue_task', {});
      expect(result.isError).toBe(true);
    });

    it('queue_task rejects negative timeout', async () => {
      const result = await safeTool('queue_task', {
        task: 'Test',
        timeout_minutes: -5
      });
      expect(result.isError).toBe(true);
    });

    it('tag_task rejects non-array tags', async () => {
      const result = await safeTool('tag_task', {
        task_id: 'test',
        tags: 'not-an-array'
      });
      expect(result.isError).toBe(true);
    });
  });
});
