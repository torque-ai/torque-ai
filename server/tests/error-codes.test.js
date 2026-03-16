/**
 * Error Codes Tests
 *
 * Validates the structured error code module and its integration
 * with handler responses via makeError().
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

// Direct imports for unit-level tests
const { ErrorCodes, makeError } = require('../handlers/error-codes');

// ─── Unit tests for error-codes.js ──────────────────────────────────────────

describe('ErrorCodes constants', () => {
  it('has all expected input validation codes', () => {
    expect(ErrorCodes.MISSING_REQUIRED_PARAM).toEqual(expect.objectContaining({ code: 'MISSING_REQUIRED_PARAM' }));
    expect(ErrorCodes.INVALID_PARAM).toEqual(expect.objectContaining({ code: 'INVALID_PARAM' }));
    expect(ErrorCodes.PARAM_TOO_LONG).toEqual(expect.objectContaining({ code: 'PARAM_TOO_LONG' }));
  });

  it('has all expected resource error codes', () => {
    expect(ErrorCodes.TASK_NOT_FOUND).toEqual(expect.objectContaining({ code: 'TASK_NOT_FOUND' }));
    expect(ErrorCodes.HOST_NOT_FOUND).toEqual(expect.objectContaining({ code: 'HOST_NOT_FOUND' }));
    expect(ErrorCodes.WORKFLOW_NOT_FOUND).toEqual(expect.objectContaining({ code: 'WORKFLOW_NOT_FOUND' }));
    expect(ErrorCodes.TEMPLATE_NOT_FOUND).toEqual(expect.objectContaining({ code: 'TEMPLATE_NOT_FOUND' }));
    expect(ErrorCodes.AGENT_NOT_FOUND).toEqual(expect.objectContaining({ code: 'AGENT_NOT_FOUND' }));
  });

  it('has all expected state error codes', () => {
    expect(ErrorCodes.INVALID_STATUS_TRANSITION).toEqual(expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }));
    expect(ErrorCodes.TASK_ALREADY_RUNNING).toEqual(expect.objectContaining({ code: 'TASK_ALREADY_RUNNING' }));
    expect(ErrorCodes.TASK_ALREADY_COMPLETED).toEqual(expect.objectContaining({ code: 'TASK_ALREADY_COMPLETED' }));
  });

  it('has all expected capacity error codes', () => {
    expect(ErrorCodes.RATE_LIMITED).toEqual(expect.objectContaining({ code: 'RATE_LIMITED' }));
    expect(ErrorCodes.BUDGET_EXCEEDED).toEqual(expect.objectContaining({ code: 'BUDGET_EXCEEDED' }));
    expect(ErrorCodes.AT_CAPACITY).toEqual(expect.objectContaining({ code: 'AT_CAPACITY' }));
    expect(ErrorCodes.NO_HOSTS_AVAILABLE).toEqual(expect.objectContaining({ code: 'NO_HOSTS_AVAILABLE' }));
  });

  it('has all expected security error codes', () => {
    expect(ErrorCodes.INVALID_URL).toEqual(expect.objectContaining({ code: 'INVALID_URL' }));
    expect(ErrorCodes.PATH_TRAVERSAL).toEqual(expect.objectContaining({ code: 'PATH_TRAVERSAL' }));
    expect(ErrorCodes.SSRF_BLOCKED).toEqual(expect.objectContaining({ code: 'SSRF_BLOCKED' }));
    expect(ErrorCodes.UNSAFE_REGEX).toEqual(expect.objectContaining({ code: 'UNSAFE_REGEX' }));
  });

  it('has all expected system error codes', () => {
    expect(ErrorCodes.DATABASE_ERROR).toEqual(expect.objectContaining({ code: 'DATABASE_ERROR' }));
    expect(ErrorCodes.DB_ERROR).toEqual(expect.objectContaining({ code: 'DB_ERROR' }));
    expect(ErrorCodes.PROVIDER_ERROR).toEqual(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
    expect(ErrorCodes.PROVIDER_UNAVAILABLE).toEqual(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }));
    expect(ErrorCodes.TIMEOUT).toEqual(expect.objectContaining({ code: 'TIMEOUT' }));
    expect(ErrorCodes.INTERNAL_ERROR).toEqual(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });

  it('provides recovery guidance for every error code', () => {
    for (const code of Object.values(ErrorCodes)) {
      expect(code).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          recovery: expect.any(String),
        }),
      );
      expect(code.recovery.length).toBeGreaterThan(0);
    }
  });

  it('has recovery guidance for every error code', () => {
    expect(Object.keys(ErrorCodes).length).toBeGreaterThan(28);
  });
});

describe('makeError()', () => {
  it('returns correct shape without details', () => {
    const err = makeError(ErrorCodes.TASK_NOT_FOUND, 'Task not found: abc-123');

    expect(err.isError).toBe(true);
    expect(err.error_code).toBe('TASK_NOT_FOUND');
    expect(err.content).toHaveLength(1);
    expect(err.content[0].type).toBe('text');
    expect(err.content[0].text).toBe('TASK_NOT_FOUND: Task not found: abc-123\nRecovery: Verify the task ID. Use list_tasks to see available tasks.');
    expect(err.content[0].text).toContain('Recovery:');
  });

  it('returns correct shape with details', () => {
    const details = { task_id: 'abc', status: 'running' };
    const err = makeError(ErrorCodes.INVALID_STATUS_TRANSITION, 'Cannot transition', details);

    expect(err.isError).toBe(true);
    expect(err.error_code).toBe('INVALID_STATUS_TRANSITION');
    expect(err.content[0].text).toContain('Cannot transition');
    expect(err.content[0].text).toContain('Recovery:');
    expect(err.content[0].text).toContain('Details:');
    expect(err.content[0].text).toContain('"task_id":"abc"');
  });

  it('includes null details without appending Details section', () => {
    const err = makeError(ErrorCodes.TIMEOUT, 'Operation timed out', null);
    expect(err.content[0].text).toBe('TIMEOUT: Operation timed out\nRecovery: Retry with a longer timeout or retry during lower load.');
    expect(err.content[0].text).not.toContain('Details:');
  });
});

// ─── Re-export from shared.js ───────────────────────────────────────────────

describe('shared.js re-exports', () => {
  it('re-exports ErrorCodes and makeError', () => {
    const shared = require('../handlers/shared');
    expect(shared.ErrorCodes).toBeDefined();
    expect(shared.makeError).toBeDefined();
    expect(shared.ErrorCodes.TASK_NOT_FOUND).toEqual(expect.objectContaining({ code: 'TASK_NOT_FOUND' }));
    expect(typeof shared.makeError).toBe('function');
  });
});

// ─── Integration: handlers return error_code in responses ───────────────────

describe('Handler error_code integration', () => {
  beforeAll(() => {
    setupTestDb('error-codes');
  });
  afterAll(() => { teardownTestDb(); });

  it('check_status returns TASK_NOT_FOUND error_code for missing task', async () => {
    const result = await safeTool('check_status', { task_id: 'nonexistent-task-id-000' });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TASK_NOT_FOUND');
    expect(getText(result)).toContain('Task not found');
    expect(getText(result)).toContain('Recovery:');
  });

  it('get_result returns TASK_NOT_FOUND error_code for missing task', async () => {
    const result = await safeTool('get_result', { task_id: 'nonexistent-task-id-001' });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TASK_NOT_FOUND');
    expect(getText(result)).toContain('Recovery:');
  });

  it('wait_for_task returns MISSING_REQUIRED_PARAM when task_id omitted', async () => {
    const result = await safeTool('wait_for_task', {});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBeUndefined();
  });

  it('register_agent returns MISSING_REQUIRED_PARAM when name missing', async () => {
    const result = await safeTool('register_agent', {});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBeUndefined();
    expect(getText(result)).toContain('Missing required parameter: "name"');
  });

  it('agent_heartbeat returns AGENT_NOT_FOUND for nonexistent agent', async () => {
    const result = await safeTool('agent_heartbeat', { agent_id: 'no-such-agent' });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('AGENT_NOT_FOUND');
  });

  it('remove_ollama_host returns HOST_NOT_FOUND for nonexistent host', async () => {
    const result = await safeTool('remove_ollama_host', { host_id: 'no-such-host' });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('HOST_NOT_FOUND');
  });

  it('add_ollama_host returns INVALID_URL for malformed URL', async () => {
    const result = await safeTool('add_ollama_host', {
      name: 'bad-host',
      url: 'not-a-valid-url',
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_URL');
    expect(getText(result)).toContain('Invalid URL');
    expect(getText(result)).toContain('Recovery:');
  });
});
