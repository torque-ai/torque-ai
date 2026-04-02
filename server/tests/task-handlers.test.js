const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

function extractTaskId(result) {
  const text = getText(result);
  const match = text.match(/ID:\s*([a-f0-9-]{36})/i) || text.match(/([a-f0-9-]{36})/);
  return match ? match[1] : null;
}

describe('Task Handlers', () => {
  beforeAll(() => {
    setupTestDb('task-handlers');
    const tm = require('../task-manager');
    if (typeof tm.initEarlyDeps === 'function') tm.initEarlyDeps();
    if (typeof tm.initSubModules === 'function') tm.initSubModules();
  });
  afterAll(() => { teardownTestDb(); });

  describe('ping', () => {
    it('returns pong', async () => {
      const result = await safeTool('ping', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.pong).toBe(true);
    });
  });

  describe('queue_task', () => {
    it('accepts valid task', async () => {
      const result = await safeTool('queue_task', { task: 'Test task for vitest' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task');
    });

    it('rejects empty task', async () => {
      const result = await safeTool('queue_task', { task: '' });
      expect(result.isError).toBe(true);
    });

    it('rejects whitespace-only task', async () => {
      const result = await safeTool('queue_task', { task: '   ' });
      expect(result.isError).toBe(true);
    });
  });

  describe('check_status', () => {
    it('returns status for valid task', async () => {
      const qr = await safeTool('queue_task', { task: 'Status check test' });
      const taskId = extractTaskId(qr);
      expect(taskId).toMatch(/^[a-f0-9-]{36}$/);
      const result = await safeTool('check_status', { task_id: taskId });
      expect(result.isError).toBeFalsy();
    });

    it('returns error for nonexistent task', async () => {
      const result = await safeTool('check_status', { task_id: 'nonexistent_task_id_12345' });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_tasks', () => {
    it('lists tasks without error', async () => {
      const result = await safeTool('list_tasks', {});
      expect(result.isError).toBeFalsy();
    });

    it('accepts limit parameter', async () => {
      const result = await safeTool('list_tasks', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('cancel_task', () => {
    it('returns error for nonexistent task', async () => {
      const result = await safeTool('cancel_task', { task_id: 'nonexistent_cancel_12345' });
      expect(result.isError).toBe(true);
    });

    it('cancels a queued task', async () => {
      const qr = await safeTool('queue_task', { task: 'Task to cancel' });
      const taskId = extractTaskId(qr);
      expect(taskId).toMatch(/^[a-f0-9-]{36}$/);

      const cancelResult = await safeTool('cancel_task', { task_id: taskId, confirm: true });
      expect(cancelResult.isError).toBeFalsy();

      // Verify task is now cancelled
      const status = await safeTool('check_status', { task_id: taskId });
      expect(getText(status)).toMatch(/cancel/i);
    });
  });

  describe('task lifecycle', () => {
    it('queued task has correct initial status', async () => {
      const qr = await safeTool('queue_task', { task: 'Lifecycle test task' });
      const taskId = extractTaskId(qr);
      expect(taskId).toMatch(/^[a-f0-9-]{36}$/);

      const status = await safeTool('check_status', { task_id: taskId });
      const text = getText(status);
      expect(text).toMatch(/queued/i);
    });

    it('task stores description correctly', async () => {
      const desc = 'Unique lifecycle description ' + Date.now();
      const qr = await safeTool('queue_task', { task: desc });
      const taskId = extractTaskId(qr);
      expect(taskId).toMatch(/^[a-f0-9-]{36}$/);

      const status = await safeTool('check_status', { task_id: taskId });
      expect(getText(status)).toContain(desc.slice(0, 30));
    });

    it('get_result returns error for queued task', async () => {
      const qr = await safeTool('queue_task', { task: 'Not yet completed' });
      const taskId = extractTaskId(qr);
      expect(taskId).toMatch(/^[a-f0-9-]{36}$/);

      const result = await safeTool('get_result', { task_id: taskId });
      // Should either error or contain a message about not being complete
      const text = getText(result);
      expect(text).toMatch(/still/i);
      expect(text).toMatch(/queued|pending/i);
      expect(text).toMatch(/\S/);
    });
  });

  describe('tag operations', () => {
    it('tag_task returns error for nonexistent task', async () => {
      const result = await safeTool('tag_task', { task_id: 'nonexistent_tag_123', tags: 'test-tag' });
      expect(result.isError).toBe(true);
    });

    it('list_tags returns tags', async () => {
      const result = await safeTool('list_tags', {});
      expect(result.isError).toBeFalsy();
    });
  });
});
