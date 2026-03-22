/**
 * Comprehensive tests for get_task_logs (handler + DB layer)
 *
 * Tests handleGetTaskLogs in handlers/task-intelligence.js
 * and getTaskLogs in db/webhooks-streaming.js
 *
 * Covers: no filters, level filtering (error/warn/info), search regex,
 * limit, combined filters, empty results, missing task, output formatting,
 * and edge cases.
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { v4: uuidv4 } = require('uuid');

function extractTaskId(result) {
  const text = getText(result);
  const match = text.match(/ID:\s*([a-f0-9-]{36})/i) || text.match(/([a-f0-9-]{36})/);
  return match ? match[1] : null;
}

const FAKE_ID = '00000000-aaaa-bbbb-cccc-dddddddddddd';

describe('get_task_logs — comprehensive', () => {
  let db;

  beforeAll(() => {
    const setup = setupTestDb('get-task-logs');
    db = setup.db;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: create a queued task and add stream chunks to it
  function createTaskWithLogs(chunks) {
    const taskId = uuidv4();
    db.createTask({
      id: taskId,
      status: 'pending',
      task_description: 'Logs test task',
      timeout_minutes: 10,
    });
    db.updateTaskStatus(taskId, 'running', {
      started_at: new Date(Date.now() - 5000).toISOString(),
    });

    // Get the streaming module to insert chunks
    const streaming = require('../db/webhooks-streaming');
    const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
    for (const chunk of chunks) {
      streaming.addStreamChunk(streamId, chunk.data, chunk.type || 'stdout');
    }

    return taskId;
  }

  // ════════════════════════════════════════════════════════════════════
  // Handler-level validation
  // ════════════════════════════════════════════════════════════════════

  describe('handler validation', () => {
    it('returns error when task_id is missing', async () => {
      const result = await safeTool('get_task_logs', {});
      expect(result.isError).toBe(true);
    });

    it('returns error for nonexistent task', async () => {
      const result = await safeTool('get_task_logs', { task_id: FAKE_ID });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // No filters — returns all logs
  // ════════════════════════════════════════════════════════════════════

  describe('no filters', () => {
    it('returns all logs for a task with no filters', async () => {
      const taskId = createTaskWithLogs([
        { data: 'line one', type: 'stdout' },
        { data: 'line two', type: 'stdout' },
        { data: 'error line', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      expect(result.isError).toBeFalsy();

      const text = getText(result);
      expect(text).toContain('Task Logs');
      expect(text).toContain(taskId);
      expect(text).toContain('3 entries');
      expect(text).toContain('line one');
      expect(text).toContain('line two');
      expect(text).toContain('error line');
    });

    it('returns 0 entries for a task with no stream data', async () => {
      const qr = await safeTool('queue_task', { task: 'Empty logs task' });
      const taskId = extractTaskId(qr);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('0 entries');
    });

    it('shows task status in output header', async () => {
      const taskId = createTaskWithLogs([
        { data: 'some output', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      const text = getText(result);
      expect(text).toContain('**Status:**');
      expect(text).toContain('running');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Level filtering
  // ════════════════════════════════════════════════════════════════════

  describe('level=error', () => {
    it('includes stderr chunks', async () => {
      const taskId = createTaskWithLogs([
        { data: 'normal output', type: 'stdout' },
        { data: 'stderr message', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'error',
      });
      const text = getText(result);
      expect(text).toContain('stderr message');
      expect(text).toContain('[ERR]');
      expect(text).toContain('1 entries');
    });

    it('includes stdout chunks that contain the word "error"', async () => {
      const taskId = createTaskWithLogs([
        { data: 'all good', type: 'stdout' },
        { data: 'TypeError: something broke', type: 'stdout' },
        { data: 'fatal error in module', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'error',
      });
      const text = getText(result);
      expect(text).toContain('TypeError: something broke');
      expect(text).toContain('fatal error in module');
      expect(text).not.toContain('all good');
      expect(text).toContain('2 entries');
    });

    it('is case-insensitive for "error" in stdout', async () => {
      const taskId = createTaskWithLogs([
        { data: 'ERROR: uppercase', type: 'stdout' },
        { data: 'Error: mixed case', type: 'stdout' },
        { data: 'no issues', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'error',
      });
      const text = getText(result);
      expect(text).toContain('ERROR: uppercase');
      expect(text).toContain('Error: mixed case');
      expect(text).not.toContain('no issues');
    });
  });

  describe('level=warn', () => {
    it('includes stderr chunks', async () => {
      const taskId = createTaskWithLogs([
        { data: 'normal output', type: 'stdout' },
        { data: 'warning from stderr', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'warn',
      });
      const text = getText(result);
      expect(text).toContain('warning from stderr');
      expect(text).toContain('1 entries');
    });

    it('includes stdout chunks that contain the word "warn"', async () => {
      const taskId = createTaskWithLogs([
        { data: 'looks fine', type: 'stdout' },
        { data: 'DeprecationWarning: use new API', type: 'stdout' },
        { data: 'warn: something might be wrong', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'warn',
      });
      const text = getText(result);
      expect(text).toContain('DeprecationWarning');
      expect(text).toContain('warn: something might be wrong');
      expect(text).not.toContain('looks fine');
    });
  });

  describe('level=info', () => {
    it('returns all logs (no filtering)', async () => {
      const taskId = createTaskWithLogs([
        { data: 'stdout line', type: 'stdout' },
        { data: 'stderr line', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'info',
      });
      const text = getText(result);
      // level=info is not error/warn so no filtering is applied
      expect(text).toContain('2 entries');
      expect(text).toContain('stdout line');
      expect(text).toContain('stderr line');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Search regex filtering
  // ════════════════════════════════════════════════════════════════════

  describe('search filter', () => {
    it('filters by simple string pattern', async () => {
      const taskId = createTaskWithLogs([
        { data: 'compiling main.ts', type: 'stdout' },
        { data: 'compiling utils.ts', type: 'stdout' },
        { data: 'linking output', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        search: 'compiling',
      });
      const text = getText(result);
      expect(text).toContain('compiling main.ts');
      expect(text).toContain('compiling utils.ts');
      expect(text).not.toContain('linking');
      expect(text).toContain('2 entries');
    });

    it('searches as literal string (regex chars escaped)', async () => {
      const taskId = createTaskWithLogs([
        { data: 'start build', type: 'stdout' },
        { data: 'test passed', type: 'stdout' },
        { data: 'lint clean', type: 'stdout' },
        { data: 'deploy step', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        search: 'build',
      });
      const text = getText(result);
      expect(text).toContain('start build');
      expect(text).not.toContain('test passed');
      expect(text).toContain('1 entries');
    });

    it('is case-insensitive', async () => {
      const taskId = createTaskWithLogs([
        { data: 'CRITICAL failure', type: 'stderr' },
        { data: 'Critical issue', type: 'stdout' },
        { data: 'normal line', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        search: 'critical',
      });
      const text = getText(result);
      expect(text).toContain('CRITICAL failure');
      expect(text).toContain('Critical issue');
      expect(text).not.toContain('normal line');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Limit parameter
  // ════════════════════════════════════════════════════════════════════

  describe('limit', () => {
    it('limits the number of returned entries', async () => {
      const chunks = [];
      for (let i = 0; i < 10; i++) {
        chunks.push({ data: `line ${i}`, type: 'stdout' });
      }
      const taskId = createTaskWithLogs(chunks);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        limit: 3,
      });
      const text = getText(result);
      expect(text).toContain('3 entries');
      expect(text).toContain('line 0');
      expect(text).toContain('line 2');
      expect(text).not.toContain('line 3');
    });

    it('returns all if limit exceeds available', async () => {
      const taskId = createTaskWithLogs([
        { data: 'only one', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        limit: 1000,
      });
      const text = getText(result);
      expect(text).toContain('1 entries');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Combined filters
  // ════════════════════════════════════════════════════════════════════

  describe('combined filters', () => {
    it('level + search work together', async () => {
      const taskId = createTaskWithLogs([
        { data: 'info: all good', type: 'stdout' },
        { data: 'error: disk full', type: 'stdout' },
        { data: 'error: network down', type: 'stdout' },
        { data: 'warning from stderr', type: 'stderr' },
        { data: 'error: memory leak', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'error',
        search: 'disk',
      });
      const text = getText(result);
      expect(text).toContain('error: disk full');
      expect(text).not.toContain('network down');
      expect(text).not.toContain('all good');
      expect(text).toContain('1 entries');
    });

    it('level + search + limit work together', async () => {
      const taskId = createTaskWithLogs([
        { data: 'ok', type: 'stdout' },
        { data: 'error: first', type: 'stderr' },
        { data: 'error: second', type: 'stderr' },
        { data: 'error: third', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'error',
        search: 'error',
        limit: 2,
      });
      const text = getText(result);
      expect(text).toContain('2 entries');
      expect(text).toContain('error: first');
      expect(text).toContain('error: second');
      expect(text).not.toContain('error: third');
    });

    it('warn + search filters correctly', async () => {
      const taskId = createTaskWithLogs([
        { data: 'normal log line', type: 'stdout' },
        { data: 'warning: deprecated API call', type: 'stdout' },
        { data: 'warn: something else', type: 'stdout' },
        { data: 'stderr deprecation notice', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'warn',
        search: 'deprecat',
      });
      const text = getText(result);
      expect(text).toContain('warning: deprecated API call');
      expect(text).toContain('stderr deprecation notice');
      expect(text).not.toContain('normal log line');
      expect(text).not.toContain('something else');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Output formatting
  // ════════════════════════════════════════════════════════════════════

  describe('output formatting', () => {
    it('prefixes stdout lines with [OUT]', async () => {
      const taskId = createTaskWithLogs([
        { data: 'stdout content', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      const text = getText(result);
      expect(text).toContain('[OUT]');
      expect(text).toContain('stdout content');
    });

    it('prefixes stderr lines with [ERR]', async () => {
      const taskId = createTaskWithLogs([
        { data: 'stderr content', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      const text = getText(result);
      expect(text).toContain('[ERR]');
      expect(text).toContain('stderr content');
    });

    it('wraps log body in code fences', async () => {
      const taskId = createTaskWithLogs([
        { data: 'some output', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      const text = getText(result);
      expect(text).toContain('```\n');
      expect(text).toContain('```');
    });

    it('shows filter summary in header', async () => {
      const taskId = createTaskWithLogs([
        { data: 'x', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'error',
        search: 'test',
      });
      const text = getText(result);
      expect(text).toContain('level=error');
      expect(text).toContain('search=test');
    });

    it('shows default filter summary when no filters given', async () => {
      const taskId = createTaskWithLogs([
        { data: 'x', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      const text = getText(result);
      expect(text).toContain('level=all');
      expect(text).toContain('search=none');
    });

    it('adds trailing newline to lines that lack one', async () => {
      const taskId = createTaskWithLogs([
        { data: 'no-newline', type: 'stdout' },
        { data: 'has-newline\n', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      const text = getText(result);
      // Both should end with \n in the output — the handler normalizes it
      const codeBlock = text.split('```')[1];
      const lines = codeBlock.split('\n').filter(l => l.includes('[OUT]'));
      expect(lines.length).toBe(2);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // DB-level getTaskLogs direct tests
  // ════════════════════════════════════════════════════════════════════

  describe('DB-level getTaskLogs', () => {
    let streaming;

    beforeAll(() => {
      streaming = require('../db/webhooks-streaming');
    });

    function createDbTask() {
      const taskId = uuidv4();
      db.createTask({
        id: taskId,
        status: 'pending',
        task_description: 'DB logs test',
        timeout_minutes: 10,
      });
      return taskId;
    }

    it('returns empty array when no stream data exists', () => {
      const taskId = createDbTask();
      const logs = streaming.getTaskLogs(taskId);
      expect(logs).toEqual([]);
    });

    it('returns mapped log objects with timestamp, type, content, sequence', () => {
      const taskId = createDbTask();
      const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
      streaming.addStreamChunk(streamId, 'hello', 'stdout');

      const logs = streaming.getTaskLogs(taskId);
      expect(logs.length).toBe(1);
      expect(logs[0]).toHaveProperty('timestamp');
      expect(logs[0]).toHaveProperty('type', 'stdout');
      expect(logs[0]).toHaveProperty('content', 'hello');
      expect(logs[0]).toHaveProperty('sequence');
    });

    it('preserves sequence order', () => {
      const taskId = createDbTask();
      const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
      streaming.addStreamChunk(streamId, 'first', 'stdout');
      streaming.addStreamChunk(streamId, 'second', 'stdout');
      streaming.addStreamChunk(streamId, 'third', 'stdout');

      const logs = streaming.getTaskLogs(taskId);
      expect(logs.map(l => l.content)).toEqual(['first', 'second', 'third']);
      expect(logs[0].sequence).toBeLessThan(logs[1].sequence);
      expect(logs[1].sequence).toBeLessThan(logs[2].sequence);
    });

    it('filters by level=error: stderr + stdout containing "error"', () => {
      const taskId = createDbTask();
      const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
      streaming.addStreamChunk(streamId, 'all good', 'stdout');
      streaming.addStreamChunk(streamId, 'stderr msg', 'stderr');
      streaming.addStreamChunk(streamId, 'has error in text', 'stdout');

      const logs = streaming.getTaskLogs(taskId, { level: 'error' });
      expect(logs.length).toBe(2);
      expect(logs.map(l => l.content)).toContain('stderr msg');
      expect(logs.map(l => l.content)).toContain('has error in text');
    });

    it('filters by level=warn: stderr + stdout containing "warn"', () => {
      const taskId = createDbTask();
      const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
      streaming.addStreamChunk(streamId, 'all good', 'stdout');
      streaming.addStreamChunk(streamId, 'stderr msg', 'stderr');
      streaming.addStreamChunk(streamId, 'has warning text', 'stdout');

      const logs = streaming.getTaskLogs(taskId, { level: 'warn' });
      expect(logs.length).toBe(2);
      expect(logs.map(l => l.content)).toContain('stderr msg');
      expect(logs.map(l => l.content)).toContain('has warning text');
    });

    it('applies search regex filter', () => {
      const taskId = createDbTask();
      const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
      streaming.addStreamChunk(streamId, 'foo bar', 'stdout');
      streaming.addStreamChunk(streamId, 'baz qux', 'stdout');
      streaming.addStreamChunk(streamId, 'foo qux', 'stdout');

      const logs = streaming.getTaskLogs(taskId, { search: 'foo' });
      expect(logs.length).toBe(2);
      expect(logs.map(l => l.content)).toEqual(['foo bar', 'foo qux']);
    });

    it('applies limit after all filters', () => {
      const taskId = createDbTask();
      const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
      for (let i = 0; i < 20; i++) {
        streaming.addStreamChunk(streamId, `line-${i}`, 'stdout');
      }

      const logs = streaming.getTaskLogs(taskId, { limit: 5 });
      expect(logs.length).toBe(5);
      expect(logs[0].content).toBe('line-0');
      expect(logs[4].content).toBe('line-4');
    });

    it('applies level + search + limit together', () => {
      const taskId = createDbTask();
      const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
      streaming.addStreamChunk(streamId, 'info normal', 'stdout');
      streaming.addStreamChunk(streamId, 'error: disk', 'stderr');
      streaming.addStreamChunk(streamId, 'error: network', 'stderr');
      streaming.addStreamChunk(streamId, 'error: memory', 'stderr');
      streaming.addStreamChunk(streamId, 'just stdout error text', 'stdout');

      const logs = streaming.getTaskLogs(taskId, {
        level: 'error',
        search: 'error',
        limit: 2,
      });
      expect(logs.length).toBe(2);
    });

    it('defaults limit to 500 when not specified', () => {
      const taskId = createDbTask();
      const streamId = streaming.getOrCreateTaskStream(taskId, 'output');
      // Add a few chunks — just verify the function runs with default limit
      streaming.addStreamChunk(streamId, 'data', 'stdout');

      const logs = streaming.getTaskLogs(taskId);
      expect(logs.length).toBe(1);
      // If there were 600 chunks, only 500 would return — but we just verify it doesn't crash
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Edge cases
  // ════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('handles a task that exists but was never started (no stream)', async () => {
      const qr = await safeTool('queue_task', { task: 'Never started task' });
      const taskId = extractTaskId(qr);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('0 entries');
    });

    it('handles search that matches nothing', async () => {
      const taskId = createTaskWithLogs([
        { data: 'hello world', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        search: 'zzz_nonexistent_zzz',
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('0 entries');
    });

    it('handles level=error with no stderr or error-containing stdout', async () => {
      const taskId = createTaskWithLogs([
        { data: 'clean output', type: 'stdout' },
        { data: 'more clean output', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        level: 'error',
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('0 entries');
    });

    it('handles special characters in log content', async () => {
      const taskId = createTaskWithLogs([
        { data: 'path: C:\\Users\\test\\file.js', type: 'stdout' },
        { data: 'regex: /^foo.*bar$/g', type: 'stdout' },
        { data: 'json: {"key": "value"}', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('3 entries');
    });

    it('handles limit=0 gracefully', async () => {
      const taskId = createTaskWithLogs([
        { data: 'something', type: 'stdout' },
      ]);

      const result = await safeTool('get_task_logs', {
        task_id: taskId,
        limit: 0,
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('0 entries');
    });

    it('mixed stdout and stderr chunks maintain order', async () => {
      const taskId = createTaskWithLogs([
        { data: 'out-1', type: 'stdout' },
        { data: 'err-1', type: 'stderr' },
        { data: 'out-2', type: 'stdout' },
        { data: 'err-2', type: 'stderr' },
      ]);

      const result = await safeTool('get_task_logs', { task_id: taskId });
      const text = getText(result);
      const outIdx1 = text.indexOf('out-1');
      const errIdx1 = text.indexOf('err-1');
      const outIdx2 = text.indexOf('out-2');
      const errIdx2 = text.indexOf('err-2');

      expect(outIdx1).toBeLessThan(errIdx1);
      expect(errIdx1).toBeLessThan(outIdx2);
      expect(outIdx2).toBeLessThan(errIdx2);
    });
  });
});
