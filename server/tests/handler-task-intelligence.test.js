const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

vi.mock('../handlers/workflow-handlers', () => ({}));

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer, db, handleToolCall, streamDb;

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function createTask(overrides = {}) {
  const task = {
    id: randomUUID(),
    task_description: overrides.task_description || `task-${Math.random().toString(36).slice(2)}`,
    working_directory: process.cwd(),
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex',
  };

  db.createTask(task);
  return db.getTask(task.id);
}

function seedStreamChunks(taskId, chunks = []) {
  const streamId = streamDb.getOrCreateTaskStream(taskId, 'output');
  for (const chunk of chunks) {
    streamDb.addStreamChunk(streamId, chunk.text, chunk.type || 'stdout');
  }
}

function parseSubscriptionId(text) {
  const match = text.match(/`([a-f0-9-]{36})`/i);
  return match ? match[1] : null;
}

beforeAll(() => {
  templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  db = require('../database');
  db.resetForTest(templateBuffer);

  handleToolCall = require('../tools').handleToolCall;
  streamDb = require('../db/webhooks-streaming');
  if (typeof streamDb.setDb === 'function') {
    streamDb.setDb(db.getDbInstance());
  }
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
});

afterAll(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
});

describe('task-intelligence handlers via handleToolCall', () => {
  it('stream_task_output returns merged chunks for a task', async () => {
    const task = createTask({ task_description: 'stream output test' });
    seedStreamChunks(task.id, [
      { text: 'first chunk', type: 'stdout' },
      { text: 'second chunk', type: 'stdout' },
    ]);

    const result = await handleToolCall('stream_task_output', {
      task_id: task.id,
      since_sequence: 0,
      limit: 2,
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(getText(result));
    expect(payload.task_id).toBe(task.id);
    expect(payload.chunk_count).toBe(2);
    expect(payload.output).toContain('first chunk');
  });

  it('get_task_logs filters by level and returns counts', async () => {
    const task = createTask({ task_description: 'logs for error filtering' });
    seedStreamChunks(task.id, [
      { text: 'warning: not important', type: 'stdout' },
      { text: 'error: failed to read file', type: 'stderr' },
      { text: 'normal output', type: 'stdout' },
    ]);

    const result = await handleToolCall('get_task_logs', {
      task_id: task.id,
      level: 'error',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('Task Logs');
    expect(text).toContain('[ERR]');
    expect(text).toContain('error: failed to read file');
  });

  it('subscribe_task_events rejects invalid event type arrays', async () => {
    const task = createTask();
    const result = await handleToolCall('subscribe_task_events', {
      task_id: task.id,
      event_types: ['status_change', 'unsupported_type'],
    });

    expect(result.isError).toBeTruthy();
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result)).toContain('Invalid event type');
  });

  it('poll_task_events reports no events for a fresh subscription', async () => {
    const subscribe = await handleToolCall('subscribe_task_events', {});
    expect(subscribe.isError).toBeFalsy();
    const subscriptionId = parseSubscriptionId(getText(subscribe));
    expect(subscriptionId).toBeTruthy();

    const poll = await handleToolCall('poll_task_events', { subscription_id: subscriptionId });
    expect(poll.isError).toBeFalsy();
    expect(getText(poll)).toContain('No New Events');
  });

  it('pause_task requires a running task', async () => {
    const task = createTask({ status: 'queued' });
    const result = await handleToolCall('pause_task', { task_id: task.id });

    expect(result.isError).toBeTruthy();
    expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('suggest_improvements returns suggestions for failed timeout task', async () => {
    const task = createTask({ status: 'queued', task_description: 'timeout handling test' });
    db.updateTaskStatus(task.id, 'failed', {
      error_output: 'timeout expired while processing job',
      retry_count: 0,
      exit_code: 1,
    });

    const result = await handleToolCall('suggest_improvements', { task_id: task.id });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('Improvement Suggestions');
    expect(text).toContain('timeout');
  });

  it('find_similar_tasks returns candidate matches', async () => {
    const source = createTask({
      status: 'failed',
      task_description: 'Build parser integration tests for auth service',
    });

    createTask({
      status: 'completed',
      task_description: 'Build parser unit tests for auth service',
    });

    createTask({
      status: 'completed',
      task_description: 'Refactor caching layer for billing',
    });

    const result = await handleToolCall('find_similar_tasks', {
      task_id: source.id,
      limit: 5,
      min_similarity: 0.1,
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('Similar Tasks');
    expect(text).toContain('Found:');
  });

  it('apply_smart_defaults returns base defaults when patterns are missing', async () => {
    const result = await handleToolCall('apply_smart_defaults', {
      task_description: 'A totally unique and unseen phrasing for this test run',
      project: 'non-matching-project',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('No patterns matched. Using default values.');
    expect(text).toContain('timeout_minutes');
  });

  it('dry_run_bulk previews bulk operation for queued tasks', async () => {
    createTask({ status: 'queued', task_description: 'bulk queued task 1' });
    createTask({ status: 'queued', task_description: 'bulk queued task 2' });

    const result = await handleToolCall('dry_run_bulk', {
      operation: 'cancel',
      status: 'queued',
    });

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('Dry Run: CANCEL Operation');
    expect(getText(result)).toContain('Total Tasks Affected:');
  });
});
