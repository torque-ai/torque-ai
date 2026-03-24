/**
 * Timeout and metadata behavior for task handlers/database interactions.
 */

const { v4: uuidv4 } = require('uuid');
const { setupTestDb, teardownTestDb, safeTool } = require('./vitest-setup');
const { PROVIDER_DEFAULT_TIMEOUTS } = require('../constants');

/** Extract a UUID from handler output text */
function extractTaskId(result) {
  const text = result?.content?.[0]?.text || '';
  const match = text.match(/ID:\s*([a-f0-9-]{36})/i) || text.match(/([a-f0-9-]{36})/);
  return match ? match[1] : null;
}

describe('submit_task timeout and metadata behavior', () => {
  let db;
  let fallbackTimeout;
  let startTaskSpy;

  beforeAll(() => {
    const setup = setupTestDb('p1-handler-timeout');
    db = setup.db;
    const taskManager = require('../task-manager');
    taskManager.initSubModules();
    startTaskSpy = vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: false });
    const providerName = db.getDefaultProvider();
    const configDefaultTimeout = parseInt(db.getConfig('default_timeout') || '30', 10);
    fallbackTimeout = PROVIDER_DEFAULT_TIMEOUTS[providerName] ?? configDefaultTimeout;
  });

  afterAll(() => {
    if (startTaskSpy) {
      startTaskSpy.mockRestore();
    }
    teardownTestDb();
  });

  it('preserves timeout of 0 (does not replace with default fallback)', async () => {
    const result = await safeTool('submit_task', {
      task: 'Timeout zero should be preserved',
      timeout_minutes: 0,
      auto_route: false,
    });

    expect(result.isError).toBeFalsy();
    const taskId = extractTaskId(result);
    expect(taskId).toBeTruthy();

    const task = db.getTask(taskId);
    expect(task.timeout_minutes).toBe(0);
  });

  it('uses fallback timeout for null/undefined timeout values', async () => {
    const omitted = await safeTool('submit_task', {
      task: 'Fallback timeout when unspecified',
      auto_route: false,
    });
    expect(omitted.isError).toBeFalsy();
    const omittedTask = db.getTask(extractTaskId(omitted));
    expect(omittedTask.timeout_minutes).toBe(fallbackTimeout);

    const explicitNull = await safeTool('submit_task', {
      task: 'Fallback timeout when null',
      timeout_minutes: null,
      auto_route: false,
    });
    expect(explicitNull.isError).toBeFalsy();
    const nullTask = db.getTask(extractTaskId(explicitNull));
    expect(nullTask.timeout_minutes).toBe(fallbackTimeout);
  });

  it('serializes and deserializes metadata objects', async () => {
    const taskId = uuidv4();
    const metadata = { source: 'unit-test', nested: { flag: true } };

    db.createTask({
      id: taskId,
      task_description: 'Metadata roundtrip',
      status: 'queued',
      metadata,
    });

    const createdTask = db.getTask(taskId);
    // getTask auto-parses JSON metadata into an object
    // createTask injects requested_provider (from default_provider config or 'codex')
    // and auto_routed: true when no explicit provider is given
    const defaultProvider = db.getDefaultProvider();
    expect(typeof createdTask.metadata).toBe('object');
    expect(createdTask.metadata).toEqual({ ...metadata, requested_provider: defaultProvider, auto_routed: true });

    db.updateTaskStatus(taskId, 'running', {
      metadata: { updated: true },
    });

    const updatedTask = db.getTask(taskId);
    expect(typeof updatedTask.metadata).toBe('object');
    expect(updatedTask.metadata).toEqual({ updated: true });
  });
});
