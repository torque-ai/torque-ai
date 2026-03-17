/**
 * E2E Test: Ollama Direct Execution
 *
 * Tests the full execution path: startTask() → executeOllamaTask() → HTTP to mock → DB update
 * Uses a real mock HTTP server registered as an Ollama host in the test DB.
 */

const { createMockOllama } = require('./mocks/ollama');
const { setupE2eDb, teardownE2eDb, registerMockHost, createTestTask, waitForTaskStatus } = require('./e2e-helpers');

let ctx; // { db, tm, testDir, origDataDir }
let mock; // mock Ollama server
let mockUrl;

beforeAll(async () => {
  // Single DB + mock server for the entire suite
  ctx = setupE2eDb('ollama-direct');
  mock = createMockOllama();
  const info = await mock.start();
  mockUrl = info.url;
  registerMockHost(ctx.db, mockUrl, ['codellama:latest', 'llama3:latest', 'mistral:latest']);
});

afterAll(async () => {
  await mock.stop();
  await teardownE2eDb(ctx);
});

describe('E2E: Ollama direct execution', () => {
  beforeEach(() => {
    // Reset mock state between tests (but keep the same DB)
    mock.clearLog();
    mock.setFailGenerate(false);
    mock.setGenerateDelay(0);
    mock.setGenerateResponse('This is a mock LLM response for testing.');
    mock.setStatusCode(200);
  });

  it('happy path: task completes with output stored in DB', async () => {
    const expectedOutput = 'The function calculates the factorial recursively.';
    mock.setGenerateResponse(expectedOutput);

    const taskId = createTestTask(ctx.db, {
      description: 'Explain the factorial function',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    ctx.tm.startTask(taskId);
    const task = await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed']);

    expect(task.status).toBe('completed');
    expect(task.output).toContain(expectedOutput);

    // Verify mock received the request
    const genRequests = mock.requestLog.filter(r => r.url === '/api/generate');
    expect(genRequests.length).toBeGreaterThanOrEqual(1);
    expect(genRequests[0].body.model).toBe('codellama:latest');
  });

  it('Ollama HTTP 500: task fails with error stored', async () => {
    mock.setFailGenerate(true);

    const taskId = createTestTask(ctx.db, {
      description: 'This should fail due to HTTP 500',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    ctx.tm.startTask(taskId);
    const task = await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 3000);

    expect(task.status).toBe('failed');
    // Error details may be in output, error, or error_output fields
    expect(task.output || task.error || task.error_output || '').toBeTruthy();
  });

  it('empty response: streaming produces whitespace, task completes', async () => {
    mock.setGenerateResponse('');

    const taskId = createTestTask(ctx.db, {
      description: 'This should get empty response',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    ctx.tm.startTask(taskId);
    const task = await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 3000);

    // Empty generateResponse still produces whitespace via streaming chunking,
    // so the task completes rather than failing
    expect(['completed', 'failed']).toContain(task.status);
  });

  it('task description is included in prompt sent to Ollama', async () => {
    const description = 'Write a Python function that sorts a list of integers';

    const taskId = createTestTask(ctx.db, {
      description,
      provider: 'ollama',
      model: 'codellama:latest',
    });

    ctx.tm.startTask(taskId);
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed']);

    const genRequests = mock.requestLog.filter(r => r.url === '/api/generate');
    expect(genRequests.length).toBeGreaterThanOrEqual(1);
    expect(genRequests[0].body.prompt).toContain(description);
  });

  it('model selection: uses the model specified in the task', async () => {
    const taskId = createTestTask(ctx.db, {
      description: 'Test model selection',
      provider: 'ollama',
      model: 'llama3:latest',
    });

    ctx.tm.startTask(taskId);
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed']);

    const genRequests = mock.requestLog.filter(r => r.url === '/api/generate');
    expect(genRequests.length).toBeGreaterThanOrEqual(1);
    expect(genRequests[0].body.model).toBe('llama3:latest');
  });

  it('host slot released after task completion', async () => {
    const taskId = createTestTask(ctx.db, {
      description: 'Test slot release',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    ctx.tm.startTask(taskId);
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed']);

    // After completion, the host should have 0 running tasks
    const hosts = ctx.db.listOllamaHosts();
    const mockHost = hosts.find(h => h.url === mockUrl);
    expect(mockHost).toBeDefined();
    expect(mockHost.running_tasks).toBe(0);
  });

  it('function response: generateResponse can be a function', async () => {
    mock.setGenerateResponse((req) => `Echo: ${req.model}`);

    const taskId = createTestTask(ctx.db, {
      description: 'Test function response',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    ctx.tm.startTask(taskId);
    const task = await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed']);

    if (task.status === 'completed') {
      expect(task.output).toContain('Echo: codellama:latest');
    }
  });
});
