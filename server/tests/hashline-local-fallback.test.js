const { setupTestDb, teardownTestDb } = require('./vitest-setup');

describe('Hashline Local Model Escalation', () => {
  let db;

  beforeAll(() => {
    const setup = setupTestDb('hashline-local-fallback');
    db = setup.db;
  });
  afterAll(() => { teardownTestDb(); });

  // ─── Config ─────────────────────────────────────────────────────────────────

  describe('max_hashline_local_retries config', () => {
    it('defaults to 2', () => {
      const val = db.getConfig('max_hashline_local_retries');
      expect(val).toBe('2');
    });

    it('is configurable', () => {
      db.setConfig('max_hashline_local_retries', '4');
      expect(db.getConfig('max_hashline_local_retries')).toBe('4');
      db.setConfig('max_hashline_local_retries', '2');
    });
  });

  // ─── tryHashlineTieredFallback behavior ─────────────────────────────────────

  describe('local model escalation', () => {
    let taskManager;

    beforeAll(() => {
      taskManager = require('../task-manager');
      if (typeof taskManager.initEarlyDeps === 'function') taskManager.initEarlyDeps();
      if (typeof taskManager.initSubModules === 'function') taskManager.initSubModules();
    });

    /**
     * Create a hashline-ollama task and return its ID.
     */
    function createHashlineTask(model, hostId, errorOutput) {
      const id = require('crypto').randomUUID();
      db.createTask({
        id,
        status: 'running',
        task_description: 'Test hashline task in src/test.ts',
        provider: 'hashline-ollama',
        model: model || 'qwen2.5-coder:7b',
        working_directory: process.cwd()
      });
      if (hostId) {
        db.updateTaskStatus(id, 'running', { ollama_host_id: hostId });
      }
      if (errorOutput) {
        db.updateTaskStatus(id, 'running', { error_output: errorOutput });
      }
      return id;
    }

    /**
     * Register a test Ollama host with specific models and mark it healthy.
     * Uses addOllamaHost + updateOllamaHost since addOllamaHost defaults to 'unknown' status.
     */
    let hostCounter = 0;
    function registerHost(name, models) {
      hostCounter++;
      const hostId = `test-host-${name}-${hostCounter}`;
      try {
        db.addOllamaHost({
          id: hostId,
          name,
          url: `http://${name}-${hostCounter}:11434`,
          max_concurrent: 4
        });
      } catch {
        // Host already exists
      }
      db.updateOllamaHost(hostId, {
        status: 'healthy',
        models_cache: JSON.stringify(models.map(m => ({ name: m }))),
        models_updated_at: new Date().toISOString()
      });
      return hostId;
    }

    it('escalates to codex when no larger hashline-capable model is allowed by config', () => {
      const hostA = registerHost('escalate-a', ['qwen2.5-coder:7b', 'qwen3-coder:30b']);

      db.setConfig('hashline_capable_models', 'qwen2.5-coder');

      const taskId = createHashlineTask('qwen2.5-coder:7b', hostA);
      const task = db.getTask(taskId);

      const result = taskManager.tryHashlineTieredFallback(taskId, task, 'no edits parsed from local model response');

      expect(result).toBe(true);

      const updated = db.getTask(taskId);
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.status).toBe('queued');
      expect(updated.error_output).toContain('Escalated from hashline-ollama');
      expect(updated.error_output).toContain('no edits parsed from local model response');
    });

    it('tries local retry before escalating on host-related failures', () => {
      const hostA = registerHost('host-fb-a', ['qwen2.5-coder:14b']);
      const _hostB = registerHost('host-fb-b', ['qwen2.5-coder:14b']);

      db.setConfig('hashline_capable_models', 'qwen2.5-coder');

      const taskId = createHashlineTask('qwen2.5-coder:14b', hostA);
      const task = db.getTask(taskId);

      const result = taskManager.tryHashlineTieredFallback(taskId, task, 'connection timeout');

      expect(result).toBe(true);

      const updated = db.getTask(taskId);
      // Should stay on hashline-ollama (local retry), not escalate to cloud
      expect(updated.provider).toBe('hashline-ollama');
      expect(updated.status).toBe('queued');
      expect(updated.error_output).toContain('[Hashline-Local]');
    });

    it('skips host fallback for model-capability issues and finds capable model', () => {
      const hostA = registerHost('capability-a', ['phi3:3b', 'qwen3-coder:30b']);

      db.setConfig('hashline_capable_models', 'qwen2.5-coder,qwen3');

      const taskId = createHashlineTask('phi3:3b', hostA);
      const task = db.getTask(taskId);

      const result = taskManager.tryHashlineTieredFallback(taskId, task, "model 'phi3:3b' not hashline-capable");

      expect(result).toBe(true);

      const updated = db.getTask(taskId);
      // Should have skipped to a hashline-capable model (not phi3 on another host)
      expect(updated.provider).toBe('hashline-ollama');
      expect(updated.model).not.toBe('phi3:3b');
      expect(updated.model).toMatch(/qwen/i); // Should be one of the capable models
      expect(updated.error_output).toContain('[Hashline-Local]');
    });

    it('escalates to codex after exhausting local retries', () => {
      registerHost('exhausted-a', ['qwen2.5-coder:7b']);
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      db.setConfig('max_hashline_local_retries', '2');

      // Simulate a task that already had 2 local retry attempts
      const priorErrors = [
        '[Hashline-Local] Trying qwen2.5-coder:14b',
        '[Hashline-Local] Trying qwen3-coder:30b'
      ].join('\n');

      const taskId = createHashlineTask('qwen3-coder:30b', null, priorErrors);
      const task = db.getTask(taskId);

      const result = taskManager.tryHashlineTieredFallback(taskId, task, 'no edits parsed');

      expect(result).toBe(true);

      const updated = db.getTask(taskId);
      expect(updated.provider).not.toBe('hashline-ollama');
      expect(updated.model).toBeNull();
    });

    it('escalates to codex when no other models are available', () => {
      // Only one model available and it's the one that failed — no alternative
      registerHost('solo-model', ['qwen3-coder:30b']);
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');

      const taskId = createHashlineTask('qwen3-coder:30b', null);
      const task = db.getTask(taskId);

      // First attempt: no other host, no larger model → should try something
      taskManager.tryHashlineTieredFallback(taskId, task, 'no edits parsed');
      let updated = db.getTask(taskId);

      // Drive through retries until it hits cloud
      while (updated.provider === 'hashline-ollama') {
        db.updateTaskStatus(taskId, 'running');
        const fresh = db.getTask(taskId);
        taskManager.tryHashlineTieredFallback(taskId, fresh, 'still failing');
        updated = db.getTask(taskId);
      }

      expect(updated.provider).not.toBe('hashline-ollama');
      expect(updated.model).toBeNull();
    });

    it('preserves error_output history across retries', () => {
      registerHost('history-a', ['qwen2.5-coder:7b', 'qwen3-coder:30b']);
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');

      const taskId = createHashlineTask('qwen2.5-coder:7b', null);
      const task = db.getTask(taskId);

      taskManager.tryHashlineTieredFallback(taskId, task, 'first failure reason');

      const updated = db.getTask(taskId);
      expect(updated.error_output).toContain('first failure reason');
      expect(updated.error_output).toContain('[Hashline-Local]');
    });
  });

  // ─── findNextHashlineModel ──────────────────────────────────────────────────

  describe('findNextHashlineModel', () => {
    let taskManager;

    beforeAll(() => {
      taskManager = require('../task-manager');
    });

    it('is exported for testing', () => {
      expect(typeof taskManager.findNextHashlineModel).toBe('function');
    });
  });
});
