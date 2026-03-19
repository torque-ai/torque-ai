'use strict';

/**
 * Tests for checkRateLimit() provider isolation.
 *
 * Verifies that the concurrent rate limit for a provider is evaluated using
 * only that provider's running tasks, not the global running task count.
 */

const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

let mod;

/** Insert a minimal running task for a given provider. */
function insertRunningTask(id, provider) {
  rawDb().prepare(`
    INSERT INTO tasks (id, task_description, status, provider, created_at)
    VALUES (?, ?, 'running', ?, ?)
  `).run(id, `task for ${provider}`, provider, new Date().toISOString());
}

beforeAll(() => {
  ({ mod } = setupTestDbModule('../db/file-quality', 'rate-limit-provider'));
});

afterAll(() => teardownTestDb());

beforeEach(() => {
  resetTables([
    'tasks',
    'rate_limits',
    'rate_limit_events',
    'config',
  ]);
});

describe('checkRateLimit — provider isolation', () => {
  it('running tasks from provider B do not count against provider A concurrent limit', () => {
    // Set concurrent limit of 2 for aider-ollama
    mod.setRateLimit('aider-ollama', 'concurrent', 2, 60, true);

    // Insert 2 running tasks for a DIFFERENT provider (codex)
    insertRunningTask('task-codex-1', 'codex');
    insertRunningTask('task-codex-2', 'codex');

    // aider-ollama has 0 running tasks — should be allowed
    const result = mod.checkRateLimit('aider-ollama');
    expect(result.allowed).toBe(true);
  });

  it('rate limit triggers only when the specific provider hits its limit', () => {
    // Set concurrent limit of 2 for aider-ollama
    mod.setRateLimit('aider-ollama', 'concurrent', 2, 60, true);

    // Insert 2 running tasks for aider-ollama itself
    insertRunningTask('task-aider-1', 'aider-ollama');
    insertRunningTask('task-aider-2', 'aider-ollama');

    // Also insert running tasks for another provider — should not matter
    insertRunningTask('task-codex-1', 'codex');
    insertRunningTask('task-codex-2', 'codex');
    insertRunningTask('task-codex-3', 'codex');

    // aider-ollama is at its limit of 2 — should be blocked
    const result = mod.checkRateLimit('aider-ollama');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Concurrent limit reached \(2\/2\)/);
  });

  it('each provider has its own independent concurrent limit', () => {
    mod.setRateLimit('aider-ollama', 'concurrent', 1, 60, true);
    mod.setRateLimit('codex', 'concurrent', 3, 60, true);

    // aider-ollama is at its limit (1 running)
    insertRunningTask('task-aider-1', 'aider-ollama');
    // codex has 2 running tasks — still under its limit of 3
    insertRunningTask('task-codex-1', 'codex');
    insertRunningTask('task-codex-2', 'codex');

    const aiderResult = mod.checkRateLimit('aider-ollama');
    expect(aiderResult.allowed).toBe(false);
    expect(aiderResult.reason).toMatch(/Concurrent limit reached \(1\/1\)/);

    const codexResult = mod.checkRateLimit('codex');
    expect(codexResult.allowed).toBe(true);
  });

  it('allows a provider with no running tasks even if global running count is high', () => {
    mod.setRateLimit('hashline-ollama', 'concurrent', 1, 60, true);

    // Many tasks running for other providers
    for (let i = 0; i < 5; i++) {
      insertRunningTask(`task-codex-${i}`, 'codex');
      insertRunningTask(`task-aider-${i}`, 'aider-ollama');
    }

    // hashline-ollama has 0 running tasks — should be allowed
    const result = mod.checkRateLimit('hashline-ollama');
    expect(result.allowed).toBe(true);
  });
});
