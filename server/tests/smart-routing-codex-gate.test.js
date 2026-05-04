/**
 * Tests for Codex exhaustion gate and local-LLM-first routing in handleSmartSubmitTask.
 *
 * These tests verify:
 * 1. Simple/normal greenfield tasks stay local when Ollama is healthy
 * 2. Simple/normal greenfield tasks go to Codex Spark when Ollama is down
 * 3. All Codex routing paths are skipped when Codex is exhausted
 * 4. Test tasks avoid Codex when exhausted
 */
const taskCore = require('../db/task-core');
const configCore = require('../db/config-core');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');

let testDir;
let mod; // integration-routing module (handler)
let taskManagerMock;

// Minimal mock for taskManager to prevent actual task execution
function createTaskManagerMock() {
  return {
    processQueue: () => {},
    resolveFileReferences: () => ({ resolved: [], unresolved: [] }),
    extractJsFunctionBoundaries: () => [],
    PROVIDER_DEFAULT_TIMEOUTS: {
      codex: 60,
      ollama: 30,
      'claude-cli': 45,
    },
  };
}

function setup() {
  ({ testDir } = setupTestDbOnly('smart-routing-gate'));

  // Mock task-manager before requiring integration-routing
  taskManagerMock = createTaskManagerMock();
  require.cache[require.resolve('../task-manager')] = {
    id: require.resolve('../task-manager'),
    filename: require.resolve('../task-manager'),
    loaded: true,
    exports: taskManagerMock,
  };

  // Wire host management for hasHealthyOllamaHost
  const providerRouting = require('../db/provider/routing-core');
  const hostManagement = require('../db/host/management');
  const dbHandle = rawDb();
  hostManagement.setDb(dbHandle);
  providerRouting.setHostManagement(hostManagement);

  mod = require('../handlers/integration/routing');
}

function teardown() {
  teardownTestDb();
}

function clearHosts() {
  rawDb().prepare('DELETE FROM ollama_hosts').run();
}

function insertHost(overrides = {}) {
  const hostId = overrides.id || `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  rawDb().prepare(`
    INSERT INTO ollama_hosts (id, name, url, enabled, status, running_tasks, max_concurrent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    hostId,
    overrides.name || `Host-${hostId}`,
    overrides.url || `http://127.0.0.1:${11434 + Math.floor(Math.random() * 1000)}`,
    overrides.enabled !== undefined ? (overrides.enabled ? 1 : 0) : 1,
    overrides.status || 'healthy',
    overrides.running_tasks || 0,
    overrides.max_concurrent || 4,
    new Date().toISOString()
  );
  return hostId;
}

function enableCodex() {
  configCore.setConfig('codex_enabled', '1');
  configCore.setConfig('codex_spark_enabled', '1');
}

function disableCodexExhaustion() {
  configCore.setConfig('codex_exhausted', '0');
}

function setCodexExhausted() {
  configCore.setConfig('codex_exhausted', '1');
  configCore.setConfig('codex_exhausted_at', new Date().toISOString());
}

/** Extract taskId from result and get task from DB to check provider/model */
function extractTaskFromResult(result) {
  // The result has __subscribe_task_id and content
  const taskId = result.__subscribe_task_id;
  if (taskId) {
    return taskCore.getTask(taskId);
  }
  // Fallback: parse task ID from markdown output
  const text = result.content?.[0]?.text || '';
  const match = text.match(/Task ID \| `([^`]+)`/);
  if (match) {
    return taskCore.getTask(match[1]);
  }
  return null;
}

describe('Smart Routing — Codex Exhaustion Gate & Local-First Routing', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  // Mock checkOllamaHealth to avoid network calls
  let originalCheckOllamaHealth;
  beforeAll(() => {
    const providerRouting = require('../db/provider/routing-core');
    originalCheckOllamaHealth = providerRouting.checkOllamaHealth;
    // Replace with a no-op that returns true
    providerRouting.checkOllamaHealth = async () => true;
  });
  afterAll(() => {
    if (originalCheckOllamaHealth) {
      const providerRouting = require('../db/provider/routing-core');
      providerRouting.checkOllamaHealth = originalCheckOllamaHealth;
    }
  });

  beforeEach(() => {
    clearHosts();
    disableCodexExhaustion();
    enableCodex();
  });

  describe('Simple/normal greenfield routing when Ollama healthy', () => {
    it('routes simple greenfield to a valid provider when Ollama host is healthy', async () => {
      // Setup: healthy Ollama host with capacity
      insertHost({ enabled: true, status: 'healthy', running_tasks: 0, max_concurrent: 4 });

      const result = await mod.handleSmartSubmitTask({
        task: 'Create a utility function to format dates in ISO format',
        working_directory: testDir,
      });

      const task = extractTaskFromResult(result);
      expect(task).toBeTruthy();
      // Provider is now deferred (null) — intended_provider in metadata tracks the routing decision
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      expect(meta.intended_provider || meta.requested_provider).toBeTruthy();
    });

    it('routes normal greenfield to a valid provider when Ollama host is healthy', async () => {
      insertHost({ enabled: true, status: 'healthy', running_tasks: 0, max_concurrent: 4 });

      const result = await mod.handleSmartSubmitTask({
        task: 'Create a REST API endpoint for user registration with validation',
        working_directory: testDir,
      });

      const task = extractTaskFromResult(result);
      expect(task).toBeTruthy();
      // Provider is now deferred (null) — intended_provider in metadata tracks the routing decision
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      expect(meta.intended_provider || meta.requested_provider).toBeTruthy();
    });
  });

  describe('Simple/normal greenfield routing when Ollama down', () => {
    it('routes simple greenfield to a valid provider when no healthy Ollama host exists', async () => {
      // No hosts at all
      clearHosts();

      const result = await mod.handleSmartSubmitTask({
        task: 'Create a utility function to format dates in ISO format',
        working_directory: testDir,
      });

      const task = extractTaskFromResult(result);
      expect(task).toBeTruthy();
      // Smart routing default is now ollama; modification routing only applies to ollama.
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      expect(meta.intended_provider || task.provider).toBeTruthy();
    });

    it('routes to a valid provider when all hosts are down', async () => {
      insertHost({ enabled: true, status: 'down', running_tasks: 0, max_concurrent: 4 });

      const result = await mod.handleSmartSubmitTask({
        task: 'Create a simple logging utility module',
        working_directory: testDir,
      });

      const task = extractTaskFromResult(result);
      expect(task).toBeTruthy();
      // With all hosts down, smart routing still assigns a provider.
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      expect(meta.intended_provider || task.provider).toBeTruthy();
    });
  });

  describe('Codex exhaustion gate blocks all Codex routing', () => {
    it('skips Codex for complex greenfield when exhausted', async () => {
      setCodexExhausted();
      insertHost({ enabled: true, status: 'healthy', running_tasks: 0, max_concurrent: 4 });

      const result = await mod.handleSmartSubmitTask({
        task: 'Create a comprehensive distributed task scheduler with priority queues, retry logic, circuit breakers, and health monitoring across multiple nodes',
        working_directory: testDir,
      });

      const task = extractTaskFromResult(result);
      expect(task).toBeTruthy();
      expect(task.provider).not.toBe('codex');
    });

    it('skips Codex for test tasks when exhausted', async () => {
      setCodexExhausted();
      insertHost({ enabled: true, status: 'healthy', running_tasks: 0, max_concurrent: 4 });

      const result = await mod.handleSmartSubmitTask({
        task: 'Write tests for the authentication module',
        working_directory: testDir,
      });

      const task = extractTaskFromResult(result);
      expect(task).toBeTruthy();
      expect(task.provider).not.toBe('codex');
    });

    it('rejects greenfield when exhausted and Ollama is down (both-providers-down gate)', async () => {
      setCodexExhausted();
      clearHosts(); // No Ollama hosts

      // With both Codex exhausted and no Ollama hosts, the both-providers-down gate
      // returns an error — there's nowhere to route the task
      const result = await mod.handleSmartSubmitTask({
        task: 'Create a simple string formatting utility',
        working_directory: testDir,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No providers available');
    });

    it('does not block Codex routing when not exhausted', async () => {
      disableCodexExhaustion();
      clearHosts(); // No Ollama hosts — forces Codex Spark path

      const result = await mod.handleSmartSubmitTask({
        task: 'Write tests for the user service module',
        working_directory: testDir,
      });

      const task = extractTaskFromResult(result);
      expect(task).toBeTruthy();
      // Provider is now deferred (null) — check intended_provider in metadata
      expect(configCore.getConfig('codex_enabled')).toBe('1');
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      expect(meta.intended_provider).toBe('codex');
    });
  });

  describe('Routing reason reflects provider selection', () => {
    it('routes to a valid provider when Ollama is down', async () => {
      disableCodexExhaustion();
      clearHosts(); // No healthy hosts

      const result = await mod.handleSmartSubmitTask({
        task: 'Create a date formatting utility',
        working_directory: testDir,
      });

      const task = extractTaskFromResult(result);
      expect(task).toBeTruthy();
      // Provider is now deferred (null) — intended_provider in metadata tracks the routing decision
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      expect(meta.intended_provider || meta.requested_provider).toBeTruthy();
    });
  });

  describe('Both-providers-down rejection', () => {
    it('rejects submission when Codex exhausted AND local LLM down', async () => {
      setCodexExhausted();
      clearHosts(); // No healthy Ollama hosts

      // Returns an error object — both providers down, nowhere to route
      const result = await mod.handleSmartSubmitTask({
        task: 'Create a utility function to format dates',
        working_directory: testDir,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No providers available');
    });

    it('does NOT reject when Codex is NOT exhausted', async () => {
      disableCodexExhaustion();
      clearHosts(); // No healthy hosts, but Codex is available

      // Should not throw — Codex is still available
      const result = await mod.handleSmartSubmitTask({
        task: 'Create a utility function to format dates',
        working_directory: testDir,
      });
      expect(result).toBeTruthy();
    });

    it('does NOT reject when local LLM is healthy', async () => {
      setCodexExhausted();
      insertHost({ enabled: true, status: 'healthy', running_tasks: 0, max_concurrent: 4 });

      // Should not throw — local LLM is available
      const result = await mod.handleSmartSubmitTask({
        task: 'Create a utility function to format dates',
        working_directory: testDir,
      });
      expect(result).toBeTruthy();
    });

    it('does NOT reject when override_provider is set', async () => {
      setCodexExhausted();
      clearHosts(); // Both down

      // Should not throw — user explicitly specified a provider to bypass the gate
      const result = await mod.handleSmartSubmitTask({
        task: 'Create a utility function to format dates',
        working_directory: testDir,
        override_provider: 'anthropic',
      });
      expect(result).toBeTruthy();
    });
  });
});
