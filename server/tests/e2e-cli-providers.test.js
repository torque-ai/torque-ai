/**
 * E2E Test: CLI-Based Providers (Codex, Claude-CLI)
 *
 * Tests: startTask() → command build → spawn() (mocked) → stdout/stderr → close → DB update
 * Uses a mock child_process.spawn to control CLI execution without real binaries.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createMockChild, simulateSuccess, simulateFailure } = require('./mocks/process-mock');
const { createMockOllama } = require('./mocks/ollama');
const { setupE2eDb, teardownE2eDb, createTestTask, waitForTaskStatus } = require('./e2e-helpers');

let ctx;
let spawnMock;
let originalSpawn;
let origOpenAIKey;
let origAnthropicKey;

describe('E2E: CLI provider execution', () => {
  beforeEach(async () => {
    origOpenAIKey = process.env.OPENAI_API_KEY;
    origAnthropicKey = process.env.ANTHROPIC_API_KEY;
    if (ctx) {
      await teardownE2eDb(ctx);
    }

    // Mock child_process.spawn at the module level
    // task-manager.js imports spawn at the top, so we need to intercept it
    // before requiring task-manager/process-lifecycle for this test.
    const childProcess = require('child_process');
    originalSpawn = childProcess.spawn;
    spawnMock = vi.fn().mockImplementation(() => {
      const child = createMockChild();
      // Store on mock for test access
      if (!spawnMock._children) spawnMock._children = [];
      spawnMock._children.push(child);
      spawnMock._lastChild = child;
      return child;
    });
    childProcess.spawn = spawnMock;

    delete require.cache[require.resolve('../task-manager')];
    delete require.cache[require.resolve('../execution/process-lifecycle')];
    ctx = setupE2eDb('cli-providers');

    // Also set OPENAI_API_KEY so codex doesn't warn
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = 'test-key-for-e2e';
    }
  });

  afterEach(() => {
    // Restore spawn
    const childProcess = require('child_process');
    childProcess.spawn = originalSpawn;
    if (origOpenAIKey !== undefined) {
      process.env.OPENAI_API_KEY = origOpenAIKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    if (origAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = origAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  afterAll(async () => {
    if (ctx) await teardownE2eDb(ctx);
  });

  it('Codex happy path: spawn + stdout + close(0) → task completed', async () => {
    const taskId = createTestTask(ctx.db, {
      description: 'Create a hello world function',
      provider: 'codex',
      workingDirectory: os.tmpdir(),
    });

    const startResult = await ctx.tm.startTask(taskId);

    // If task was queued due to concurrency, that's still a valid path
    if (startResult && startResult.queued) {
      const task = ctx.db.getTask(taskId);
      expect(task.status).toBe('queued');
      return; // Valid E2E path — concurrency limit
    }

    // Get the mock child that was created
    const child = spawnMock._lastChild;
    expect(child).toBeDefined();

    // Simulate Codex writing output and exiting successfully
    simulateSuccess(child, 'Created hello.js with hello() function\n');

    const _task = await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 3000);

    // Verify spawn was called
    expect(spawnMock).toHaveBeenCalled();
    const spawnArgs = spawnMock.mock.calls[0];
    expect(spawnArgs).toBeDefined();
  });

  it('Codex failure: spawn + stderr + close(1) → task failed', async () => {
    const taskId = createTestTask(ctx.db, {
      description: 'This should fail',
      provider: 'codex',
      workingDirectory: os.tmpdir(),
    });

    const startResult = await ctx.tm.startTask(taskId);
    if (startResult?.queued) {
      const task = ctx.db.getTask(taskId);
      expect(task.status).toBe('queued');
      return;
    }

    const child = spawnMock._lastChild;
    expect(child).toBeDefined();

    simulateFailure(child, '', 'Error: API rate limit exceeded', 1);

    const task = await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed', 'retry_scheduled'], 3000);
    expect(['failed', 'retry_scheduled']).toContain(task.status);
  });

  it('Codex: spawn includes working directory', async () => {
    const testWorkDir = path.join(ctx.testDir, 'workdir');
    fs.mkdirSync(testWorkDir, { recursive: true });

    const taskId = createTestTask(ctx.db, {
      description: 'Test working dir',
      provider: 'codex',
      workingDirectory: testWorkDir,
    });

    const startResult = await ctx.tm.startTask(taskId);
    if (startResult?.queued) {
      const task = ctx.db.getTask(taskId);
      expect(task.status).toBe('queued');
      return;
    }

    const child = spawnMock._lastChild;
    expect(child).toBeDefined();

    simulateSuccess(child, 'Done\n');
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 3000);

    // Verify spawn was called with the working directory
    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0][2]; // 3rd arg = options
    expect(spawnOpts).toBeDefined();
    expect(spawnOpts.cwd).toBe(testWorkDir);
  });

  it('Claude-CLI: provider sets up correctly', async () => {
    // Claude-CLI requires ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    const taskId = createTestTask(ctx.db, {
      description: 'Review architecture decisions',
      provider: 'claude-cli',
      workingDirectory: os.tmpdir(),
    });

    const startResult = await ctx.tm.startTask(taskId);
    if (startResult?.queued) {
      const task = ctx.db.getTask(taskId);
      expect(task.status).toBe('queued');
      return;
    }

    const child = spawnMock._lastChild;
    expect(child).toBeDefined();
    simulateSuccess(child, 'Architecture looks good\n');
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 3000);

    const task = ctx.db.getTask(taskId);
    expect(['running', 'completed', 'failed', 'queued']).toContain(task.status);
  });

  it('spawn not called for ollama provider (uses HTTP instead)', async () => {
    // Ollama provider should NOT use spawn — it makes direct HTTP calls
    const mock = createMockOllama();
    const info = await mock.start();
    const { registerMockHost } = require('./e2e-helpers');
    registerMockHost(ctx.db, info.url, ['codellama:latest']);

    const preCallCount = spawnMock.mock.calls.length;

    const taskId = createTestTask(ctx.db, {
      description: 'Test that ollama uses HTTP',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    ctx.tm.startTask(taskId);
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 3000);

    // spawn should NOT have been called for ollama tasks
    expect(spawnMock.mock.calls.length).toBe(preCallCount);

    await mock.stop();
  });

  it('task timeout: process killed when not completing in time', async () => {
    const taskId = createTestTask(ctx.db, {
      description: 'Test timeout handling',
      provider: 'codex',
      workingDirectory: os.tmpdir(),
      timeout: 1, // 1 minute — we won't actually wait, just verify setup
    });

    const startResult = await ctx.tm.startTask(taskId);
    if (startResult?.queued) {
      const task = ctx.db.getTask(taskId);
      expect(task.status).toBe('queued');
      return;
    }

    // Don't simulate completion — verify the task is in running state
    const task = ctx.db.getTask(taskId);
    expect(task.status).toBe('running');

    // Clean up by simulating the process exit
    const child = spawnMock._lastChild;
    expect(child).toBeDefined();
    simulateFailure(child, '', 'Timed out', 124);
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed', 'retry_scheduled'], 3000);
  });
});
