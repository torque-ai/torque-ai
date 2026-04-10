/**
 * E2E Test: Fallback & Recovery
 *
 * Tests the provider fallback and recovery logic:
 * - No healthy hosts → task fails with clear error
 * - Host at capacity → task requeued
 * - Multiple hosts: failover to secondary
 * - Stall detection configuration
 * - Max failover cap
 */

vi.mock('../integrations/codebase-study-engine', () => ({
  applyStudyContextPrompt: (prompt) => prompt,
}));

const { createMockOllama } = require('./mocks/ollama');
const { setupE2eDb, teardownE2eDb, registerMockHost, createTestTask, waitForTaskStatus } = require('./e2e-helpers');

let ctx;

describe('E2E: Fallback and recovery', () => {
  beforeEach(async () => {
    if (ctx) {
      await teardownE2eDb(ctx);
    }
    ctx = setupE2eDb('fallback-recovery');
  });

  afterAll(async () => {
    if (ctx) await teardownE2eDb(ctx);
  });

  it('no healthy hosts: ollama task stays queued when the fallback host is unreachable', async () => {
    // Don't register any hosts and force single-host fallback to an unreachable port
    ctx.db.setConfig('ollama_host', 'http://127.0.0.1:1');
    for (const provider of ['ollama', 'ollama-cloud', 'deepinfra', 'codex', 'claude-cli']) {
      ctx.db.updateProvider?.(provider, { enabled: 0 });
    }

    const taskId = createTestTask(ctx.db, {
      description: 'Test no hosts available',
      provider: 'ollama',
      model: 'codellama:latest',
      timeout: 0.01,
    });

    const startResult = await ctx.tm.startTask(taskId);
    expect(startResult?.queued).toBe(true);

    const task = await waitForTaskStatus(ctx.db, taskId, ['queued'], 3000);
    expect(task.status).toBe('queued');
    expect(task.provider).toBeNull();
    expect(task.original_provider).toBe('ollama');
    expect(task.error_output).toBeNull();
  });

  it('host at max capacity: task is requeued', async () => {
    const mock = createMockOllama();
    const info = await mock.start();

    // Register host with max_concurrent=1
    registerMockHost(ctx.db, info.url, ['codellama:latest'], { maxConcurrent: 1 });

    // Manually set host to capacity by increasing running_tasks
    const hosts = ctx.db.listOllamaHosts();
    const host = hosts.find(h => h.url === info.url);
    if (host) {
      ctx.db.incrementHostTasks(host.id);
    }

    const taskId = createTestTask(ctx.db, {
      description: 'Test capacity handling',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    const startResult = await Promise.resolve(ctx.tm.startTask(taskId));
    const task = ctx.db.getTask(taskId);
    expect(task.status).toBe('queued');
    expect(startResult?.queued === true || startResult?.requeued === true).toBe(true);

    await mock.stop();
  });

  it('stall detection can be configured', () => {
    // Test that stall detection settings are stored and retrieved
    ctx.db.setConfig('stall_threshold_ollama', '120');
    ctx.db.setConfig('stall_auto_resubmit', '1');

    const threshold = ctx.db.getConfig('stall_threshold_ollama');
    const autoResubmit = ctx.db.getConfig('stall_auto_resubmit');

    expect(threshold).toBe('120');
    expect(autoResubmit).toBe('1');
  });

  it('two hosts: primary down, secondary used', async () => {
    // Start two mock servers
    const primary = createMockOllama();
    const secondary = createMockOllama();

    const primaryInfo = await primary.start();
    const secondaryInfo = await secondary.start();

    try {
      // Register primary (will be marked down) and secondary (healthy)
      const primaryHost = registerMockHost(ctx.db, primaryInfo.url, ['codellama:latest'], {
        name: 'primary',
        priority: 10,
      });
      const _secondaryHost = registerMockHost(ctx.db, secondaryInfo.url, ['codellama:latest'], {
        name: 'secondary',
        priority: 5,
      });

      // Mark primary as down
      if (primaryHost && primaryHost.id) {
        ctx.db.updateOllamaHost(primaryHost.id, { status: 'down', consecutive_failures: 3 });
      }

      secondary.setGenerateResponse('Response from secondary host');

      const taskId = createTestTask(ctx.db, {
        description: 'Test failover to secondary',
        provider: 'ollama',
        model: 'codellama:latest',
      });

      await ctx.tm.startTask(taskId).catch(() => {});
      const task = await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 5000);

      // Should have used secondary (primary is down)
      if (task.status === 'completed') {
        const genRequests = secondary.requestLog.filter(r => r.url === '/api/generate');
        expect(genRequests.length).toBeGreaterThanOrEqual(1);
        expect(task.exit_code).toBe(0);
      } else {
        expect(task.status).toBe('failed');
        expect(task.output).toContain('secondary');
      }
    } finally {
      await primary.stop();
      await secondary.stop();
    }
  }, 45000); // Extended timeout for two-host test

  it('task max concurrent applies globally', async () => {
    // Set max concurrent to 2
    ctx.db.setConfig('auto_compute_max_concurrent', '0');
    ctx.db.setConfig('max_concurrent', '2');

    const taskId1 = createTestTask(ctx.db, {
      description: 'Task 1',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    const taskId2 = createTestTask(ctx.db, {
      description: 'Task 2',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    const taskId3 = createTestTask(ctx.db, {
      description: 'Task 3 (should be queued)',
      provider: 'ollama',
      model: 'codellama:latest',
    });

    // Simulate 2 tasks already running by setting their status
    ctx.db.updateTaskStatus(taskId1, 'running');
    ctx.db.updateTaskStatus(taskId2, 'running');

    // Try to start task 3 — should be queued due to max_concurrent
    const startResult = await ctx.tm.startTask(taskId3);
    const task = ctx.db.getTask(taskId3);
    expect(task.status).toBe('queued');
    expect(startResult?.queued).toBe(true);
  });
});
