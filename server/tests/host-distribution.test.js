const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

/**
 * Host Distribution & Load Balancing Tests
 *
 * Proves that TORQUE:
 * 1. Distributes work across multiple hosts (not all-to-one)
 * 2. Respects capacity limits per host
 * 3. Selects least-loaded hosts
 * 4. Matches models correctly (exact tag vs base name)
 * 5. Skips unhealthy/down hosts
 * 6. Falls back only when ALL local options are exhausted
 * 7. Reserves and releases slots atomically
 */

describe('Host Distribution & Load Balancing', () => {
  let db;

  beforeAll(() => {
    const setup = setupTestDbOnly('host-distribution');
    db = setup.db;
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    // Clear hosts and tasks between tests to prevent cross-test leakage
    const raw = db.rawDb ? db.rawDb() : db._db || db;
    if (typeof raw.prepare === 'function') {
      raw.prepare("DELETE FROM ollama_hosts").run();
      raw.prepare("DELETE FROM tasks").run();
    }
    hostCounter = 0;
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  let hostCounter = 0;
  function addHost(name, models, opts = {}) {
    hostCounter++;
    const id = `host-${name}-${hostCounter}`;
    db.addOllamaHost({
      id,
      name,
      url: `http://${name}-${hostCounter}:11434`,
      max_concurrent: opts.maxConcurrent || 4,
      enabled: opts.enabled !== undefined ? opts.enabled : true
    });
    const updateFields = {
      status: opts.status || 'healthy',
      running_tasks: opts.runningTasks || 0,
      models_cache: JSON.stringify(
        models.map(m => typeof m === 'string' ? { name: m } : m)
      ),
      models_updated_at: new Date().toISOString()
    };
    if (opts.memoryLimit) updateFields.memory_limit_mb = opts.memoryLimit;
    if (opts.enabled === false) updateFields.enabled = 0;
    if (opts.maxConcurrent != null) updateFields.max_concurrent = opts.maxConcurrent;
    db.updateOllamaHost(id, updateFields);
    return id;
  }

  function createTask(provider, model, hostId) {
    const id = require('crypto').randomUUID();
    db.createTask({
      id,
      status: 'running',
      task_description: `Test task for ${model}`,
      provider: provider || 'ollama',
      model: model || TEST_MODELS.SMALL,
      working_directory: process.cwd()
    });
    if (hostId) {
      db.updateTaskStatus(id, 'running', { ollama_host_id: hostId });
    }
    return id;
  }

  // ─── selectOllamaHostForModel ─────────────────────────────────────────────

  describe('selectOllamaHostForModel', () => {

    it('returns least-loaded host when multiple have the same model', () => {
      const _hostA = addHost('dist-a', [TEST_MODELS.SMALL], { runningTasks: 3, maxConcurrent: 4 });
      const hostB = addHost('dist-b', [TEST_MODELS.SMALL], { runningTasks: 1, maxConcurrent: 4 });

      const result = db.selectOllamaHostForModel(TEST_MODELS.SMALL);

      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe(hostB); // B has fewer running tasks
    });

    it('skips hosts at capacity', () => {
      const _full = addHost('full-host', [TEST_MODELS.DEFAULT], { runningTasks: 4, maxConcurrent: 4 });
      const avail = addHost('avail-host', [TEST_MODELS.DEFAULT], { runningTasks: 0, maxConcurrent: 4 });

      const result = db.selectOllamaHostForModel(TEST_MODELS.DEFAULT);

      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe(avail);
    });

    it('returns atCapacity when ALL hosts with model are full', () => {
      const _h1 = addHost('cap-a', [TEST_MODELS.SMALL], { runningTasks: 2, maxConcurrent: 2 });
      const _h2 = addHost('cap-b', [TEST_MODELS.SMALL], { runningTasks: 3, maxConcurrent: 3 });

      const result = db.selectOllamaHostForModel(TEST_MODELS.SMALL);

      expect(result.host).toBeNull();
      expect(result.atCapacity).toBe(true);
    });

    it('skips down hosts', () => {
      const _down = addHost('down-host', [TEST_MODELS.FAST], { status: 'down' });
      const up = addHost('up-host', [TEST_MODELS.FAST], { status: 'healthy' });

      const result = db.selectOllamaHostForModel(TEST_MODELS.FAST);

      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe(up);
    });

    it('skips disabled hosts', () => {
      const _disabled = addHost('disabled-host', [TEST_MODELS.DEFAULT], { enabled: false });
      const enabled = addHost('enabled-host', [TEST_MODELS.DEFAULT]);

      const result = db.selectOllamaHostForModel(TEST_MODELS.DEFAULT);

      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe(enabled);
    });

    it('returns null when no host has the requested model', () => {
      addHost('no-model-host', [TEST_MODELS.SMALL]);

      const result = db.selectOllamaHostForModel('nonexistent-model:70b');

      expect(result.host).toBeNull();
      expect(result.reason).toContain('nonexistent-model:70b');
    });

    it('returns any host when no model specified', () => {
      addHost('any-model-host', [TEST_MODELS.SMALL, TEST_MODELS.SMALL]);

      const result = db.selectOllamaHostForModel(null);

      expect(result.host).toBeTruthy();
    });

    // ─── Exact tag matching ───────────────────────────────────────────────

    it('exact tag: :7b does NOT match :32b on another host', () => {
      addHost('tag-7b-host', [TEST_MODELS.SMALL], { runningTasks: 0 });
      addHost('tag-32b-host', [TEST_MODELS.DEFAULT], { runningTasks: 0 });

      const result = db.selectOllamaHostForModel(TEST_MODELS.SMALL);

      expect(result.host).toBeTruthy();
      // Must be the 7b host, not 32b
      const hostModels = result.host.models.map(m => typeof m === 'string' ? m : m.name);
      expect(hostModels).toContain(TEST_MODELS.SMALL);
    });

    it('base name without tag matches any variant', () => {
      addHost('variant-host', [TEST_MODELS.DEFAULT], { runningTasks: 0 });

      // Query by base name (strip :14b tag) — should match test-model:14b
      const result = db.selectOllamaHostForModel('test-model');

      expect(result.host).toBeTruthy();
    });

    it(':latest tag requires exact :latest match (P98)', () => {
      addHost('latest-host', ['llama3:latest'], { runningTasks: 0 });
      addHost('8b-host', [TEST_MODELS.DEFAULT], { runningTasks: 0 });

      const result = db.selectOllamaHostForModel('llama3:latest');

      expect(result.host).toBeTruthy();
      const hostModels = result.host.models.map(m => typeof m === 'string' ? m : m.name);
      expect(hostModels).toContain('llama3:latest');
    });
  });

  // ─── tryReserveHostSlot ───────────────────────────────────────────────────

  describe('tryReserveHostSlot', () => {

    it('acquires slot when under capacity', () => {
      const hostId = addHost('reserve-under', [TEST_MODELS.SMALL], {
        maxConcurrent: 4, runningTasks: 2
      });

      const result = db.tryReserveHostSlot(hostId);

      expect(result.acquired).toBe(true);
      expect(result.currentLoad).toBe(3);
      expect(result.maxCapacity).toBe(4);
    });

    it('rejects slot when at capacity', () => {
      const hostId = addHost('reserve-full', [TEST_MODELS.SMALL], {
        maxConcurrent: 2, runningTasks: 2
      });

      const result = db.tryReserveHostSlot(hostId);

      expect(result.acquired).toBe(false);
      expect(result.currentLoad).toBe(2);
    });

    it('always acquires when max_concurrent is 0 (unlimited)', () => {
      const hostId = addHost('reserve-unlimited', [TEST_MODELS.SMALL], {
        maxConcurrent: 0, runningTasks: 10
      });

      const result = db.tryReserveHostSlot(hostId);

      expect(result.acquired).toBe(true);
      expect(result.maxCapacity).toBe(0);
    });

    it('returns error for nonexistent host', () => {
      const result = db.tryReserveHostSlot('nonexistent-host-xyz');

      expect(result.acquired).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ─── releaseHostSlot ──────────────────────────────────────────────────────

  describe('releaseHostSlot', () => {

    it('decrements running_tasks', () => {
      const hostId = addHost('release-test', [TEST_MODELS.SMALL], {
        maxConcurrent: 4, runningTasks: 3
      });

      db.releaseHostSlot(hostId);

      const host = db.getOllamaHost(hostId);
      expect(host.running_tasks).toBe(2);
    });

    it('never goes below 0', () => {
      const hostId = addHost('release-zero', [TEST_MODELS.SMALL], {
        maxConcurrent: 4, runningTasks: 0
      });

      db.releaseHostSlot(hostId);

      const host = db.getOllamaHost(hostId);
      expect(host.running_tasks).toBe(0);
    });

    it('reserve then release returns to original count', () => {
      const hostId = addHost('reserve-release', [TEST_MODELS.SMALL], {
        maxConcurrent: 4, runningTasks: 1
      });

      db.tryReserveHostSlot(hostId);
      let host = db.getOllamaHost(hostId);
      expect(host.running_tasks).toBe(2);

      db.releaseHostSlot(hostId);
      host = db.getOllamaHost(hostId);
      expect(host.running_tasks).toBe(1);
    });
  });

  // ─── selectHostWithModelVariant ───────────────────────────────────────────

  describe('selectHostWithModelVariant', () => {

    it('selects from hosts with matching base model', () => {
      addHost('variant-a', ['test-coder:7b'], { runningTasks: 0, maxConcurrent: 4 });
      addHost('variant-b', ['test-coder:14b'], { runningTasks: 0, maxConcurrent: 4 });

      const result = db.selectHostWithModelVariant('test-coder');

      expect(result.host).toBeTruthy();
      expect(result.model).toMatch(/test-coder/);
    });

    it('prefers host with more available capacity', () => {
      // Host A: 1 slot free, Host B: 3 slots free
      // With weighted random, B should win most of the time
      addHost('cap-low', ['test-coder:7b'], { runningTasks: 3, maxConcurrent: 4 });
      addHost('cap-high', ['test-coder:33b'], { runningTasks: 0, maxConcurrent: 4 });

      // Run selection 20 times, verify distribution skews toward more-available host
      const selections = {};
      for (let i = 0; i < 20; i++) {
        const result = db.selectHostWithModelVariant('deepseek-coder');
        const hostName = result.host?.name;
        selections[hostName] = (selections[hostName] || 0) + 1;
      }

      // cap-high has 4 available slots (weight ~4), cap-low has 1 (weight ~1)
      // In 20 trials, cap-high should win at least 8 times (probabilistically)
      // Using a generous lower bound to avoid flaky tests
      const capHighCount = Object.entries(selections)
        .filter(([name]) => name.startsWith('cap-high'))
        .reduce((sum, [, count]) => sum + count, 0);
      expect(capHighCount).toBeGreaterThanOrEqual(5);
    });

    it('skips hosts at capacity', () => {
      // Use a synthetic model name that won't exist on the default localhost host
      // (ensureModelsLoaded populates the default host with real Ollama models)
      const _full = addHost('var-full', ['synth-cap-test:7b'], { runningTasks: 2, maxConcurrent: 2 });
      const open = addHost('var-open', ['synth-cap-test:13b'], { runningTasks: 0, maxConcurrent: 4 });

      const result = db.selectHostWithModelVariant('synth-cap-test');

      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe(open);
    });

    it('returns null when no host has matching base model', () => {
      addHost('unrelated', [TEST_MODELS.FAST]);

      const result = db.selectHostWithModelVariant('nonexistent-model');

      expect(result.host).toBeNull();
    });
  });

  // ─── Distribution proof: many tasks spread across hosts ───────────────────

  describe('distribution across multiple hosts', () => {

    it('distributes 10 tasks across 3 hosts fairly', () => {
      // Use a unique model name to avoid pollution from hosts added by other tests
      const fairModel = 'fair-dist-unique:8b';
      const _h1 = addHost('fair-a', [fairModel], { runningTasks: 0, maxConcurrent: 10 });
      const _h2 = addHost('fair-b', [fairModel], { runningTasks: 0, maxConcurrent: 10 });
      const _h3 = addHost('fair-c', [fairModel], { runningTasks: 0, maxConcurrent: 10 });

      // selectOllamaHostForModel returns least-loaded, so we simulate 10 task assignments
      // by reserving a slot after each selection (like real task execution would)
      const hostAssignments = {};
      for (let i = 0; i < 10; i++) {
        const result = db.selectOllamaHostForModel(fairModel);
        expect(result.host).toBeTruthy();
        const hostId = result.host.id;
        hostAssignments[hostId] = (hostAssignments[hostId] || 0) + 1;
        // Reserve the slot so next selection sees updated load
        db.tryReserveHostSlot(hostId);
      }

      // With least-loaded selection and 3 hosts starting at 0,
      // tasks should distribute roughly evenly: 3-4 each
      const counts = Object.values(hostAssignments);
      expect(counts.length).toBe(3); // All 3 hosts got work
      for (const count of counts) {
        expect(count).toBeGreaterThanOrEqual(2); // At least 2 each
        expect(count).toBeLessThanOrEqual(5);    // No more than 5
      }

      // Cleanup: release all slots
      for (const [hostId, count] of Object.entries(hostAssignments)) {
        for (let i = 0; i < count; i++) {
          db.releaseHostSlot(hostId);
        }
      }
    });

    it('overflows to second host when first hits capacity', () => {
      const small = addHost('overflow-small', [TEST_MODELS.SMALL], { runningTasks: 0, maxConcurrent: 2 });
      const large = addHost('overflow-large', [TEST_MODELS.SMALL], { runningTasks: 0, maxConcurrent: 6 });

      const assigned = { [small]: 0, [large]: 0 };

      // Submit 8 tasks — small host should cap at 2, large takes the rest
      for (let i = 0; i < 8; i++) {
        const result = db.selectOllamaHostForModel(TEST_MODELS.SMALL);
        expect(result.host).toBeTruthy();
        assigned[result.host.id]++;
        db.tryReserveHostSlot(result.host.id);
      }

      expect(assigned[small]).toBe(2);  // Capped at max_concurrent
      expect(assigned[large]).toBe(6);  // Absorbs overflow

      // Cleanup
      for (const [hostId, count] of Object.entries(assigned)) {
        for (let i = 0; i < count; i++) db.releaseHostSlot(hostId);
      }
    });

    it('returns atCapacity when all hosts are completely full', () => {
      addHost('total-full-a', [TEST_MODELS.DEFAULT], { runningTasks: 3, maxConcurrent: 3 });
      addHost('total-full-b', [TEST_MODELS.DEFAULT], { runningTasks: 2, maxConcurrent: 2 });

      const result = db.selectOllamaHostForModel(TEST_MODELS.DEFAULT);

      expect(result.host).toBeNull();
      expect(result.atCapacity).toBe(true);
      expect(result.reason).toContain('capacity');
    });
  });

  // ─── tryLocalFirstFallback: precision fallback ────────────────────────────

  describe('tryLocalFirstFallback precision', () => {
    let taskManager;

    beforeAll(() => {
      taskManager = require('../task-manager');
      if (typeof taskManager.initEarlyDeps === 'function') taskManager.initEarlyDeps();
      if (typeof taskManager.initSubModules === 'function') taskManager.initSubModules();
    });

    it('step 1: tries same model on different host before anything else', () => {
      const hostA = addHost('fb-host-a', [TEST_MODELS.DEFAULT], { runningTasks: 0 });
      const _hostB = addHost('fb-host-b', [TEST_MODELS.DEFAULT], { runningTasks: 0 });

      const taskId = createTask('ollama', TEST_MODELS.DEFAULT, hostA);
      const task = db.getTask(taskId);

      const result = taskManager.tryLocalFirstFallback(taskId, task, 'connection timeout');

      expect(result).toBe(true);

      const updated = db.getTask(taskId);
      // Should stay on same provider + model, just different host
      expect(updated.provider).toBe('ollama');
      expect(updated.model).toBe(TEST_MODELS.DEFAULT);
      // processQueue() may have started the task already (which fails in test env since the provider
      // binary doesn't exist), so accept queued, running, or failed
      expect(['queued', 'running', 'failed']).toContain(updated.status);
      expect(updated.error_output).toContain('[Local-First]');
    });

    it('step 2: tries different coder model when same model unavailable elsewhere', () => {
      // Only one host with the failing model, but another model exists (coder-family for detection)
      addHost('single-model-host', [TEST_MODELS.CODER_SMALL, TEST_MODELS.CODER_BALANCED], { runningTasks: 0 });

      const taskId = createTask('ollama', TEST_MODELS.CODER_SMALL, null);
      const task = db.getTask(taskId);

      // skipSameModel to simulate step 1 already tried (no other host for this model)
      const result = taskManager.tryLocalFirstFallback(taskId, task, 'model crashed', { skipSameModel: true });

      expect(result).toBe(true);

      const updated = db.getTask(taskId);
      expect(updated.provider).toBe('ollama');
      expect(updated.model).not.toBe(TEST_MODELS.CODER_SMALL); // Moved to different model
      expect(updated.model).toMatch(/coder|code|deepseek|qwen/i);
      expect(updated.error_output).toContain('[Local-First]');
    });

    it('step 3: only escalates to cloud after ALL local options exhausted', () => {
      db.setConfig('max_local_retries', '3');
      db.setConfig('codex_enabled', '1');

      const taskId = createTask('ollama', TEST_MODELS.SMALL, null);
      // Simulate 3 prior local retries via the metadata counter (authoritative source)
      const priorErrors = [
        `[Local-First] Trying ${TEST_MODELS.SMALL} on host X`,
        `[Local-First] Trying ${TEST_MODELS.SMALL}`,
        '[Local-First] Trying provider ollama'
      ].join('\n');
      db.updateTaskStatus(taskId, 'running', {
        error_output: priorErrors,
        metadata: JSON.stringify({ local_first_attempts: 3 }),
      });

      const task = db.getTask(taskId);
      const result = taskManager.tryLocalFirstFallback(taskId, task, 'final failure');

      expect(result).toBe(true);

      const updated = db.getTask(taskId);
      // NOW it should escalate to cloud (codex)
      expect(updated.provider).toBe('codex');
    });

    it('preserves original_provider metadata on first fallback', () => {
      addHost('meta-host', [TEST_MODELS.DEFAULT], { runningTasks: 0 });

      const taskId = createTask('ollama', TEST_MODELS.DEFAULT, null);
      const task = db.getTask(taskId);

      taskManager.tryLocalFirstFallback(taskId, task, 'error');

      const updated = db.getTask(taskId);
      const metadata = updated.metadata || {};
      expect(metadata.original_provider).toBe('ollama');
    });
  });

  // ─── Hashline tiered fallback precision ───────────────────────────────────

  describe('hashline tiered fallback distribution', () => {
    let taskManager;
    let fallbackRetry;

    beforeAll(() => {
      taskManager = require('../task-manager');
      if (typeof taskManager.initEarlyDeps === 'function') taskManager.initEarlyDeps();
      if (typeof taskManager.initSubModules === 'function') taskManager.initSubModules();
      fallbackRetry = require('../execution/fallback-retry');
    });

    it('tries larger local model before any cloud provider', () => {
      addHost('hl-dist-a', [TEST_MODELS.CODER_SMALL, TEST_MODELS.CODER_DEFAULT], { runningTasks: 0 });
      db.setConfig('hashline_capable_models', 'test-coder');

      const taskId = createTask('ollama', TEST_MODELS.CODER_SMALL, null);
      const task = db.getTask(taskId);

      fallbackRetry.tryHashlineTieredFallback(taskId, task, 'no edits parsed');

      const updated = db.getTask(taskId);
      // Should stay local, just bigger model
      expect(updated.provider).toBe('ollama');
      expect(updated.model).not.toBe(TEST_MODELS.CODER_SMALL);
      expect(updated.status).toBe('queued');
      // Should not escalate away from the local hashline provider yet.
      expect(updated.provider).not.toBe('codex');
    });

    it('cloud fallback only after max_hashline_local_retries reached', () => {
      db.setConfig('hashline_capable_models', 'test-coder');
      db.setConfig('max_hashline_local_retries', '2');

      // Task with 2 prior local attempts (at max)
      const priorErrors = [
        `[Hashline-Local] Trying ${TEST_MODELS.CODER_DEFAULT}`,
        `[Hashline-Local] Trying ${TEST_MODELS.CODER_DEFAULT}`
      ].join('\n');

      const taskId = createTask('ollama', TEST_MODELS.CODER_DEFAULT, null);
      db.updateTaskStatus(taskId, 'running', { error_output: priorErrors });
      const task = db.getTask(taskId);

      fallbackRetry.tryHashlineTieredFallback(taskId, task, 'still failing');

      const updated = db.getTask(taskId);
      // Now the task should escalate away from local hashline execution.
      expect(updated.provider).not.toBe('ollama');
    });
  });

  // ─── Warm model affinity ──────────────────────────────────────────────────

  describe('warm model affinity', () => {

    it('recordHostModelUsage stores last_model_used', () => {
      const hostId = addHost('warm-test', [TEST_MODELS.SMALL]);

      db.recordHostModelUsage(hostId, TEST_MODELS.SMALL);

      const host = db.getOllamaHost(hostId);
      expect(host.last_model_used).toBe(TEST_MODELS.SMALL);
      expect(host.model_loaded_at).toBeTruthy();
    });

    it('isHostModelWarm returns true for recently-used model', () => {
      const hostId = addHost('warm-recent', [TEST_MODELS.SMALL]);
      db.recordHostModelUsage(hostId, TEST_MODELS.SMALL);

      const result = db.isHostModelWarm(hostId, TEST_MODELS.SMALL);

      expect(result.isWarm).toBe(true);
      expect(result.lastUsedSeconds).toBeDefined();
      expect(result.lastUsedSeconds).toBeLessThan(5);
    });

    it('isHostModelWarm returns false for different model', () => {
      const hostId = addHost('warm-diff', [TEST_MODELS.SMALL, TEST_MODELS.FAST]);
      db.recordHostModelUsage(hostId, TEST_MODELS.SMALL);

      const result = db.isHostModelWarm(hostId, TEST_MODELS.FAST);

      expect(result.isWarm).toBe(false);
    });

    it('isHostModelWarm returns false for unknown host', () => {
      const result = db.isHostModelWarm('nonexistent-host', TEST_MODELS.SMALL);

      expect(result.isWarm).toBe(false);
      expect(result.lastUsedSeconds).toBeNull();
    });
  });

  // ─── getAggregatedModels ──────────────────────────────────────────────────

  describe('getAggregatedModels', () => {

    it('aggregates models across all healthy hosts', () => {
      addHost('agg-a', [TEST_MODELS.SMALL, TEST_MODELS.SMALL], { status: 'healthy' });
      addHost('agg-b', [TEST_MODELS.DEFAULT, TEST_MODELS.SMALL], { status: 'healthy' });

      const models = db.getAggregatedModels();

      expect(models.length).toBeGreaterThanOrEqual(4);
      const names = models.map(m => m.name);
      expect(names).toContain(TEST_MODELS.SMALL);
      expect(names).toContain(TEST_MODELS.DEFAULT);
    });

    it('includes host info for each model', () => {
      addHost('agg-host-info', ['codellama:7b'], { status: 'healthy' });

      const models = db.getAggregatedModels();
      const codellama = models.find(m => m.name === 'codellama:7b');

      expect(codellama).toBeTruthy();
      expect(codellama.hosts).toBeInstanceOf(Array);
      expect(codellama.hosts.length).toBeGreaterThanOrEqual(1);
    });

    it('excludes down hosts', () => {
      addHost('agg-down', ['unique-down-model:7b'], { status: 'down' });

      const models = db.getAggregatedModels();
      const names = models.map(m => m.name);

      expect(names).not.toContain('unique-down-model:7b');
    });
  });

  // ─── End-to-end: reserve → work → release cycle ──────────────────────────

  describe('full slot lifecycle', () => {

    it('reserve → select shifts to next host → release restores', () => {
      const _h1 = addHost('lifecycle-a', ['test-model:7b'], { runningTasks: 0, maxConcurrent: 1 });
      const _h2 = addHost('lifecycle-b', ['test-model:7b'], { runningTasks: 0, maxConcurrent: 1 });

      // First selection: either host (both empty)
      const sel1 = db.selectOllamaHostForModel('test-model:7b');
      expect(sel1.host).toBeTruthy();
      const firstHostId = sel1.host.id;

      // Reserve the slot on first host
      const res1 = db.tryReserveHostSlot(firstHostId);
      expect(res1.acquired).toBe(true);

      // Second selection: must go to OTHER host (first is full at 1/1)
      const sel2 = db.selectOllamaHostForModel('test-model:7b');
      expect(sel2.host).toBeTruthy();
      expect(sel2.host.id).not.toBe(firstHostId);
      const secondHostId = sel2.host.id;

      // Reserve second host
      const res2 = db.tryReserveHostSlot(secondHostId);
      expect(res2.acquired).toBe(true);

      // Third selection: both full → atCapacity
      const sel3 = db.selectOllamaHostForModel('test-model:7b');
      expect(sel3.host).toBeNull();
      expect(sel3.atCapacity).toBe(true);

      // Release first host
      db.releaseHostSlot(firstHostId);

      // Fourth selection: first host is available again
      const sel4 = db.selectOllamaHostForModel('test-model:7b');
      expect(sel4.host).toBeTruthy();
      expect(sel4.host.id).toBe(firstHostId);

      // Cleanup
      db.releaseHostSlot(secondHostId);
    });
  });

  // ─── parseModelSizeB ────────────────────────────────────────────────────────

  describe('parseModelSizeB', () => {
    let taskManager;

    beforeAll(() => {
      taskManager = require('../task-manager');
    });

    it('parses size from standard model names', () => {
      expect(taskManager.parseModelSizeB('qwen3-coder:30b')).toBe(30);
      expect(taskManager.parseModelSizeB(TEST_MODELS.QUALITY)).toBe(32);
      expect(taskManager.parseModelSizeB(TEST_MODELS.SMALL)).toBe(7);
      expect(taskManager.parseModelSizeB('deepseek-coder-v2:16b')).toBe(16);
    });

    it('returns 0 for models without size tag', () => {
      expect(taskManager.parseModelSizeB('mistral:latest')).toBe(0);
      expect(taskManager.parseModelSizeB('codellama')).toBe(0);
      expect(taskManager.parseModelSizeB(null)).toBe(0);
      expect(taskManager.parseModelSizeB('')).toBe(0);
    });

    it('handles edge cases', () => {
      expect(taskManager.parseModelSizeB(TEST_MODELS.FAST)).toBe(4);
      expect(taskManager.parseModelSizeB('qwen3:0.5b')).toBe(0.5); // decimal support
      expect(taskManager.parseModelSizeB('QWEN:32B')).toBe(32); // case-insensitive
    });
  });

  // ─── VRAM-aware scheduling ──────────────────────────────────────────────────

  describe('VRAM-aware scheduling', () => {
    let taskManager;

    beforeAll(() => {
      taskManager = require('../task-manager');
    });

    it('tracks large model parameter count threshold from config', () => {
      // Default large_model_threshold_b should be 30 (or config value)
      const threshold = db.getConfig('large_model_threshold_b');
      // No config set = null, processQueue uses default of 30
      expect(threshold === null || parseInt(threshold, 10) >= 1).toBe(true);
    });

    it('getRunningTasksForHost returns task model info', () => {
      // Create a host and a running task assigned to it
      let hostCounter2 = 0;
      const hostId = `vram-host-${Date.now()}-${++hostCounter2}`;
      db.addOllamaHost({
        id: hostId,
        name: 'vram-test-host',
        url: `http://vram-test-${hostCounter2}:11434`,
        max_concurrent: 4
      });
      db.updateOllamaHost(hostId, { status: 'healthy' });

      const taskId = require('crypto').randomUUID();
      db.createTask({
        id: taskId,
        status: 'running',
        task_description: 'Test VRAM tracking',
        provider: 'ollama',
        model: TEST_MODELS.QUALITY,
        working_directory: process.cwd()
      });
      db.updateTaskStatus(taskId, 'running', { ollama_host_id: hostId });

      const hostTasks = db.getRunningTasksForHost(hostId);
      expect(hostTasks.length).toBe(1);
      expect(hostTasks[0].model).toBe(TEST_MODELS.QUALITY);

      // Cleanup
      db.updateTaskStatus(taskId, 'cancelled');
    });

    it('isLargeModelBlockedOnHost blocks when large model already running', () => {
      // Create a host with a running large model task
      const hostId = `vram-block-${Date.now()}`;
      db.addOllamaHost({
        id: hostId,
        name: 'vram-block-test',
        url: `http://vram-block-test:11434`,
        max_concurrent: 4
      });
      db.updateOllamaHost(hostId, { status: 'healthy' });

      const runningTaskId = require('crypto').randomUUID();
      db.createTask({
        id: runningTaskId,
        status: 'running',
        task_description: 'Already running large model',
        provider: 'ollama',
        model: TEST_MODELS.QUALITY,
        working_directory: process.cwd()
      });
      db.updateTaskStatus(runningTaskId, 'running', { ollama_host_id: hostId });

      // Second large model should be blocked
      const result = taskManager.isLargeModelBlockedOnHost(TEST_MODELS.QUALITY, hostId);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('VRAM guard');

      // Small model should NOT be blocked
      const smallResult = taskManager.isLargeModelBlockedOnHost(TEST_MODELS.SMALL, hostId);
      expect(smallResult.blocked).toBe(false);

      // Cleanup
      db.updateTaskStatus(runningTaskId, 'cancelled');
    });
  });

  // ─── Safeguard new-file detection ───────────────────────────────────────────

  describe('checkFileQuality isNewFile option', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    let taskManager;
    let tmpDir;

    beforeAll(() => {
      taskManager = require('../task-manager');
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeguard-test-'));
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('flags small files as stubs for modified files (default)', () => {
      const filePath = path.join(tmpDir, 'small-modified.ts');
      fs.writeFileSync(filePath, 'export const x = 1;\n');

      const result = taskManager.checkFileQuality(filePath);
      // Should flag as nearly empty or too few lines
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('nearly empty') || i.includes('lines of code'))).toBe(true);
    });

    it('skips size checks for new files (isNewFile: true)', () => {
      const filePath = path.join(tmpDir, 'small-new.ts');
      fs.writeFileSync(filePath, 'export const x = 1;\n');

      const result = taskManager.checkFileQuality(filePath, { isNewFile: true });
      // Should NOT flag size — new files are expected to be small
      expect(result.issues.filter(i => i.includes('nearly empty') || i.includes('lines of code')).length).toBe(0);
    });

    it('still flags placeholder patterns in new files', () => {
      const filePath = path.join(tmpDir, 'stub-new.ts');
      fs.writeFileSync(filePath, '// TODO: implement\nexport function foo() {}\n');

      const result = taskManager.checkFileQuality(filePath, { isNewFile: true });
      // Placeholder pattern should still be caught
      expect(result.issues.some(i => i.includes('placeholder') || i.includes('stub'))).toBe(true);
    });

    it('accepts legitimate new files with real content', () => {
      const filePath = path.join(tmpDir, 'good-new.ts');
      fs.writeFileSync(filePath, [
        'export function clamp(v: number, min: number, max: number): number {',
        '  return Math.min(Math.max(v, min), max);',
        '}',
        '',
        'export function lerp(a: number, b: number, t: number): number {',
        '  return a + (b - a) * t;',
        '}',
        ''
      ].join('\n'));

      const result = taskManager.checkFileQuality(filePath, { isNewFile: true });
      expect(result.valid).toBe(true);
      expect(result.issues.length).toBe(0);
    });
  });
});
