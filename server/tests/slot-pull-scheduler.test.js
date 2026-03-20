'use strict';

const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');
const providerCapabilities = require('../db/provider-capabilities');
const providerPerformance = require('../db/provider-performance');

const MODULE_PATH = require.resolve('../execution/slot-pull-scheduler');
const FIXED_NOW = new Date('2026-03-13T12:00:00.000Z');

let ctx;
let db;
let scheduler;
let startTask;

function rawDb() {
  return db.getDbInstance();
}

function loadScheduler() {
  delete require.cache[MODULE_PATH];
  scheduler = require('../execution/slot-pull-scheduler');
  startTask = vi.fn();
  scheduler.init({ db, startTask });
}

function setProviderConfig(provider, overrides = {}) {
  const {
    enabled = 1,
    maxConcurrent = 1,
    capabilityTags,
    qualityBand,
    maxRetries,
  } = overrides;

  const current = db.getProvider(provider);
  rawDb().prepare(`
    UPDATE provider_config
    SET enabled = ?,
        max_concurrent = ?,
        capability_tags = ?,
        quality_band = ?
    WHERE provider = ?
  `).run(
    enabled,
    maxConcurrent,
    JSON.stringify(capabilityTags || JSON.parse(current.capability_tags || '[]')),
    qualityBand || current.quality_band,
    provider,
  );
  if (maxRetries != null) {
    rawDb().prepare('UPDATE provider_config SET max_retries = ? WHERE provider = ?').run(maxRetries, provider);
  }
}

function createWorkflowWithPriority(priority, overrides = {}) {
  const workflow = db.createWorkflow({
    id: overrides.id || `workflow-${Math.random().toString(16).slice(2, 10)}`,
    name: overrides.name || `workflow-${priority}`,
    working_directory: overrides.working_directory || process.cwd(),
    status: overrides.status || 'pending',
  });

  rawDb().prepare('UPDATE workflows SET priority = ? WHERE id = ?').run(priority, workflow.id);
  return workflow.id;
}

function createUnassignedQueuedTask(overrides = {}) {
  const id = overrides.id || `task-${Math.random().toString(16).slice(2, 10)}`;
  db.createTask({
    id,
    status: 'queued',
    task_description: overrides.task_description || 'Slot pull scheduler test task',
    working_directory: overrides.working_directory || process.cwd(),
    provider: overrides.seed_provider || 'codex',
    model: overrides.model || null,
    priority: overrides.priority ?? 0,
    workflow_id: overrides.workflow_id || null,
    metadata: overrides.metadata || {},
  });

  rawDb().prepare(`
    UPDATE tasks
    SET provider = NULL,
        status = 'queued',
        priority = ?,
        workflow_id = ?,
        metadata = ?,
        created_at = ?
    WHERE id = ?
  `).run(
    overrides.priority ?? 0,
    overrides.workflow_id || null,
    JSON.stringify(overrides.metadata || {}),
    overrides.created_at || FIXED_NOW.toISOString(),
    id,
  );

  return id;
}

function createAssignedTask(overrides = {}) {
  const id = overrides.id || `task-${Math.random().toString(16).slice(2, 10)}`;
  db.createTask({
    id,
    status: overrides.status || 'running',
    task_description: overrides.task_description || 'Assigned slot pull scheduler test task',
    working_directory: overrides.working_directory || process.cwd(),
    provider: overrides.provider || 'codex',
    model: overrides.model || null,
    priority: overrides.priority ?? 0,
    metadata: overrides.metadata || {},
  });

  rawDb().prepare(`
    UPDATE tasks
    SET status = ?,
        provider = ?,
        priority = ?,
        metadata = ?,
        created_at = ?
    WHERE id = ?
  `).run(
    overrides.status || 'running',
    overrides.provider || 'codex',
    overrides.priority ?? 0,
    JSON.stringify(overrides.metadata || {}),
    overrides.created_at || FIXED_NOW.toISOString(),
    id,
  );

  return id;
}

describe('slot-pull-scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    ctx = setupE2eDb('slot-pull');
    db = ctx.db;
    db.setConfig('scheduling_mode', 'slot-pull');
    loadScheduler();
  });

  afterEach(async () => {
    if (scheduler) {
      scheduler.stopHeartbeat();
    }
    providerCapabilities.setDb(null);
    providerPerformance.setDb(null);
    vi.restoreAllMocks();
    if (ctx) {
      await teardownE2eDb(ctx);
    }
    vi.useRealTimers();
    ctx = null;
    db = null;
    scheduler = null;
    startTask = null;
  });

  describe('findBestTaskForProvider', () => {
    it('returns the highest priority eligible task and skips tasks missing capabilities', () => {
      setProviderConfig('codex', {
        maxConcurrent: 2,
        capabilityTags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
        qualityBand: 'A',
      });

      createUnassignedQueuedTask({
        id: 'missing-capability',
        priority: 100,
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['large_context'],
          quality_tier: 'normal',
        },
      });

      createUnassignedQueuedTask({
        id: 'eligible-task',
        priority: 90,
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['file_creation'],
          quality_tier: 'normal',
        },
      });

      expect(scheduler.findBestTaskForProvider('codex')).toBe('eligible-task');
    });

    it('respects the quality tier gate and uses created_at as the tiebreaker', () => {
      setProviderConfig('ollama', {
        maxConcurrent: 2,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'C',
      });

      createUnassignedQueuedTask({
        id: 'too-complex',
        priority: 100,
        created_at: new Date(FIXED_NOW.getTime() - 60 * 1000).toISOString(),
        metadata: {
          eligible_providers: ['ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'complex',
        },
      });

      createUnassignedQueuedTask({
        id: 'older-normal',
        priority: 80,
        created_at: new Date(FIXED_NOW.getTime() - 2 * 60 * 1000).toISOString(),
        metadata: {
          eligible_providers: ['ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });

      createUnassignedQueuedTask({
        id: 'newer-normal',
        priority: 80,
        created_at: new Date(FIXED_NOW.getTime() - 60 * 1000).toISOString(),
        metadata: {
          eligible_providers: ['ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });

      expect(scheduler.findBestTaskForProvider('ollama')).toBe('older-normal');
    });

    it('prefers eligible tasks from higher-priority workflows before task priority', () => {
      setProviderConfig('codex', {
        maxConcurrent: 2,
        capabilityTags: ['reasoning', 'file_creation', 'multi_file'],
        qualityBand: 'A',
      });

      const lowWorkflowId = createWorkflowWithPriority(0, { name: 'slot-pull-low-workflow' });
      const highWorkflowId = createWorkflowWithPriority(9, { name: 'slot-pull-high-workflow' });

      createUnassignedQueuedTask({
        id: 'low-workflow-task',
        workflow_id: lowWorkflowId,
        priority: 100,
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });

      createUnassignedQueuedTask({
        id: 'high-workflow-task',
        workflow_id: highWorkflowId,
        priority: 1,
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });

      expect(scheduler.findBestTaskForProvider('codex')).toBe('high-workflow-task');
    });
  });

  describe('claimTask', () => {
    it('assigns provider on queued tasks and blocks when task is no longer queued', () => {
      const taskId = createUnassignedQueuedTask({
        id: 'claim-me',
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: [],
          quality_tier: 'normal',
        },
      });

      expect(scheduler.claimTask(taskId, 'codex')).toBe(true);
      expect(rawDb().prepare('SELECT provider FROM tasks WHERE id = ?').get(taskId).provider).toBe('codex');

      // Simulate startTask moving task to running — now it can't be re-claimed
      rawDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId);

      expect(scheduler.claimTask(taskId, 'ollama')).toBe(false);
      expect(rawDb().prepare('SELECT provider FROM tasks WHERE id = ?').get(taskId).provider).toBe('codex');
    });
  });

  describe('runSlotPullPass', () => {
    it('assigns tasks across multiple providers with open slots', () => {
      setProviderConfig('codex', {
        maxConcurrent: 1,
        capabilityTags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
        qualityBand: 'A',
      });
      setProviderConfig('ollama', {
        maxConcurrent: 1,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'C',
      });

      createUnassignedQueuedTask({
        id: 'codex-task',
        priority: 50,
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['file_creation'],
          quality_tier: 'complex',
        },
      });

      createUnassignedQueuedTask({
        id: 'ollama-task',
        priority: 40,
        metadata: {
          eligible_providers: ['ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });

      expect(scheduler.runSlotPullPass()).toEqual({ assigned: 2, skipped: 0 });
      expect(startTask).toHaveBeenCalledTimes(2);
      expect(startTask).toHaveBeenCalledWith('codex-task');
      expect(startTask).toHaveBeenCalledWith('ollama-task');

      const rows = rawDb().prepare('SELECT id, provider FROM tasks WHERE id IN (?, ?) ORDER BY id').all('codex-task', 'ollama-task');
      expect(rows).toEqual([
        { id: 'codex-task', provider: 'codex' },
        { id: 'ollama-task', provider: 'ollama' },
      ]);
    });
  });

  describe('requeueAfterFailure', () => {
    it('keeps the failed provider eligible when retries remain', () => {
      // Set codex max_retries to 2 (default)
      rawDb().prepare('UPDATE provider_config SET max_retries = 2 WHERE provider = ?').run('codex');

      const taskId = createAssignedTask({
        id: 'retry-me',
        provider: 'codex',
        metadata: {
          eligible_providers: ['codex', 'ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });

      const result = scheduler.requeueAfterFailure(taskId, 'codex');

      expect(result.requeued).toBe(true);
      expect(result.providerExhausted).toBe(false);
      const task = db.getTask(taskId);
      expect(task.status).toBe('queued');
      expect(task.provider).toBeNull();
      // Provider still in eligible list (retries left)
      expect(task.metadata.eligible_providers).toEqual(['codex', 'ollama']);
      expect(task.metadata._provider_retry_counts).toEqual({ codex: 1 });
    });

    it('removes the failed provider after retries exhausted and re-queues', () => {
      rawDb().prepare('UPDATE provider_config SET max_retries = 2 WHERE provider = ?').run('codex');

      const taskId = createAssignedTask({
        id: 'exhaust-retries',
        provider: 'codex',
        metadata: {
          eligible_providers: ['codex', 'ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
          _provider_retry_counts: { codex: 1 },
        },
      });

      const result = scheduler.requeueAfterFailure(taskId, 'codex');

      expect(result.requeued).toBe(true);
      expect(result.providerExhausted).toBe(true);
      const task = db.getTask(taskId);
      expect(task.status).toBe('queued');
      expect(task.provider).toBeNull();
      expect(task.metadata.eligible_providers).toEqual(['ollama']);
      expect(task.metadata._failed_providers).toEqual(['codex']);
      expect(task.metadata._provider_retry_counts).toEqual({ codex: 2 });
    });

    it('marks the task failed permanently when all eligible providers exhausted', () => {
      rawDb().prepare('UPDATE provider_config SET max_retries = 1 WHERE provider = ?').run('codex');

      const taskId = createAssignedTask({
        id: 'exhausted-task',
        provider: 'codex',
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });

      const result = scheduler.requeueAfterFailure(taskId, 'codex');

      expect(result.requeued).toBe(false);
      expect(result.exhausted).toBe(true);
      const task = db.getTask(taskId);
      expect(task.status).toBe('failed');
      expect(task.provider).toBeNull();
      expect(task.completed_at).toBeTruthy();
    });
  });

  describe('hasOllamaHostCapacity', () => {
    it('returns true for non-Ollama providers regardless of host capacity', () => {
      expect(scheduler.hasOllamaHostCapacity('codex')).toBe(true);
      expect(scheduler.hasOllamaHostCapacity('groq')).toBe(true);
      expect(scheduler.hasOllamaHostCapacity('deepinfra')).toBe(true);
    });

    it('returns true for Ollama providers when combined running is below host cap', () => {
      // Default host max_concurrent is 4, no tasks running
      expect(scheduler.hasOllamaHostCapacity('ollama')).toBe(true);
      expect(scheduler.hasOllamaHostCapacity('hashline-ollama')).toBe(true);
      expect(scheduler.hasOllamaHostCapacity('aider-ollama')).toBe(true);
    });

    it('blocks Ollama providers when combined running tasks hit host cap', () => {
      // Get current host cap
      const hosts = db.listOllamaHosts({ enabledOnly: true });
      expect(hosts.length).toBeGreaterThan(0);
      const hostCap = Math.max(...hosts.map(h => h.max_concurrent || 4));

      // Create running tasks across Ollama providers up to host cap
      for (let i = 0; i < hostCap; i++) {
        const provider = ['ollama', 'hashline-ollama', 'aider-ollama'][i % 3];
        createAssignedTask({
          id: `vram-fill-${i}`,
          provider,
          status: 'running',
        });
      }

      // All Ollama providers should be blocked
      expect(scheduler.hasOllamaHostCapacity('ollama')).toBe(false);
      expect(scheduler.hasOllamaHostCapacity('hashline-ollama')).toBe(false);
      expect(scheduler.hasOllamaHostCapacity('aider-ollama')).toBe(false);
      // Non-Ollama still fine
      expect(scheduler.hasOllamaHostCapacity('codex')).toBe(true);
    });
  });

  describe('parallel provider slots', () => {
    it('assigns tasks to multiple providers simultaneously in a single pass', () => {
      // Configure 3 providers with 1 slot each
      setProviderConfig('codex', {
        maxConcurrent: 1,
        capabilityTags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
        qualityBand: 'A',
      });
      setProviderConfig('groq', {
        enabled: 1,
        maxConcurrent: 1,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'B',
      });
      setProviderConfig('ollama', {
        maxConcurrent: 1,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'C',
      });

      // Disable others to avoid interference
      for (const p of ['aider-ollama', 'hashline-ollama', 'claude-cli']) {
        setProviderConfig(p, { enabled: 0 });
      }

      // Create 3 tasks, each eligible for a different provider
      createUnassignedQueuedTask({
        id: 'for-codex',
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['file_creation'],
          quality_tier: 'complex',
        },
      });
      createUnassignedQueuedTask({
        id: 'for-groq',
        metadata: {
          eligible_providers: ['groq'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });
      createUnassignedQueuedTask({
        id: 'for-ollama',
        metadata: {
          eligible_providers: ['ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
      });

      const result = scheduler.runSlotPullPass();

      expect(result.assigned).toBe(3);
      expect(startTask).toHaveBeenCalledTimes(3);

      const tasks = rawDb().prepare(
        "SELECT id, provider FROM tasks WHERE id IN ('for-codex', 'for-groq', 'for-ollama') ORDER BY id"
      ).all();
      expect(tasks).toEqual([
        { id: 'for-codex', provider: 'codex' },
        { id: 'for-groq', provider: 'groq' },
        { id: 'for-ollama', provider: 'ollama' },
      ]);
    });

    it('fills multiple slots per provider when max_concurrent allows', () => {
      setProviderConfig('codex', {
        maxConcurrent: 3,
        capabilityTags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
        qualityBand: 'A',
      });
      // Disable all others
      for (const p of ['ollama', 'aider-ollama', 'hashline-ollama', 'claude-cli']) {
        setProviderConfig(p, { enabled: 0 });
      }

      createUnassignedQueuedTask({
        id: 'batch-1',
        metadata: { eligible_providers: ['codex'], capability_requirements: [], quality_tier: 'normal' },
      });
      createUnassignedQueuedTask({
        id: 'batch-2',
        metadata: { eligible_providers: ['codex'], capability_requirements: [], quality_tier: 'normal' },
      });
      createUnassignedQueuedTask({
        id: 'batch-3',
        metadata: { eligible_providers: ['codex'], capability_requirements: [], quality_tier: 'normal' },
      });

      const result = scheduler.runSlotPullPass();

      expect(result.assigned).toBe(3);
      expect(startTask).toHaveBeenCalledTimes(3);
    });
  });

  describe('starvation handling', () => {
    it('allows an old complex task onto a band C provider after the starvation threshold', () => {
      setProviderConfig('ollama', {
        maxConcurrent: 1,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'C',
      });

      createUnassignedQueuedTask({
        id: 'starved-complex',
        created_at: new Date(FIXED_NOW.getTime() - scheduler.STARVATION_THRESHOLD_MS - 1000).toISOString(),
        metadata: {
          eligible_providers: ['ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'complex',
        },
      });

      expect(scheduler.findBestTaskForProvider('ollama')).toBe('starved-complex');
    });

    it('does not relax capability requirements during starvation overrides', () => {
      setProviderConfig('ollama', {
        maxConcurrent: 1,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'C',
      });

      createUnassignedQueuedTask({
        id: 'starved-but-ineligible',
        created_at: new Date(FIXED_NOW.getTime() - scheduler.STARVATION_THRESHOLD_MS - 1000).toISOString(),
        metadata: {
          eligible_providers: ['ollama'],
          capability_requirements: ['file_creation'],
          quality_tier: 'complex',
        },
      });

      expect(scheduler.findBestTaskForProvider('ollama')).toBeNull();
    });
  });
});
