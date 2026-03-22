/**
 * Tests for strategic dashboard route handlers:
 * - handleGetRoutingDecisions
 * - handleGetProviderHealth
 * - handleGetStrategicStatus
 * - handleGetRecentOperations
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const db = require('../database');
const providerRoutingCore = require('../db/provider-routing-core');
const fileTracking = require('../db/file-tracking');
const strategic = require('../dashboard/routes/analytics');

// ============================================
// DB reset from global-setup template
// ============================================

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

function resetDb() {
  const buffer = fs.readFileSync(TEMPLATE_BUF);
  db.resetForTest(buffer);
}

// ============================================
// Mock data
// ============================================

const mockTasks = [
  {
    id: 'task-001-aabbccdd',
    description: 'Write tests for EventSystem',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    complexity: 'complex',
    status: 'completed',
    created_at: '2026-03-08T12:00:00Z',
    metadata: JSON.stringify({
      smart_routing: true,
      needs_review: true,
      split_advisory: false,
    }),
  },
  {
    id: 'task-002-eeff0011',
    description: 'Fix import in types.ts',
    provider: 'hashline-ollama',
    model: 'qwen2.5-coder:32b',
    complexity: 'simple',
    status: 'running',
    created_at: '2026-03-08T11:30:00Z',
    metadata: JSON.stringify({
      auto_routed: true,
      fallback_provider: 'codex',
    }),
  },
  {
    id: 'task-003-22334455',
    description: 'Non-routed manual task',
    provider: 'ollama',
    model: 'qwen2.5-coder:32b',
    complexity: 'normal',
    status: 'completed',
    created_at: '2026-03-08T11:00:00Z',
    metadata: JSON.stringify({}),
  },
  {
    id: 'task-004-55667788',
    description: 'Another smart-routed task with strategic review needed',
    provider: 'deepinfra',
    model: 'meta-llama/Llama-3.1-405B-Instruct',
    complexity: 'complex',
    status: 'failed',
    created_at: '2026-03-08T10:00:00Z',
    metadata: JSON.stringify({
      smart_routing: true,
      user_provider_override: true,
      requested_provider: 'deepinfra',
    }),
  },
  {
    id: 'task-005-99aabb',
    description: 'Task with invalid metadata',
    provider: 'ollama',
    model: 'qwen2.5-coder:32b',
    complexity: 'normal',
    status: 'completed',
    created_at: '2026-03-08T09:00:00Z',
    metadata: '{invalid json',
  },
];

const mockProviders = [
  { provider: 'codex', enabled: 1 },
  { provider: 'ollama', enabled: 1 },
  { provider: 'deepinfra', enabled: 1 },
  { provider: 'groq', enabled: 0 },
];

// ============================================
// Test helpers
// ============================================

function createMockRes() {
  let resolvePromise;
  const done = new Promise((resolve) => { resolvePromise = resolve; });
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    _corsOrigin: null,
    writeHead: vi.fn((status, headers) => {
      res.statusCode = status;
      res.headers = headers;
    }),
    end: vi.fn((body = '') => {
      res.body = body;
      resolvePromise();
    }),
  };
  return { res, done };
}

function parseJsonBody(raw) {
  return raw ? JSON.parse(raw) : null;
}

// ============================================
// Tests
// ============================================

describe('strategic dashboard routes', () => {
  beforeEach(() => {
    resetDb();
  });

  describe('handleGetRoutingDecisions', () => {
    let listTasksSpy;

    beforeEach(() => {
      listTasksSpy = vi.spyOn(db, 'listTasks').mockReturnValue(mockTasks);
    });

    afterEach(() => {
      listTasksSpy.mockRestore();
    });

    it('returns only smart-routed and auto-routed tasks', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions.length).toBe(3);
      expect(data.decisions.map(d => d.task_id)).toEqual([
        'task-001-aabbccdd',
        'task-002-eeff0011',
        'task-004-55667788',
      ]);
    });

    it('extracts complexity from task', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions[0].complexity).toBe('complex');
      expect(data.decisions[1].complexity).toBe('simple');
    });

    it('extracts provider and model', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions[0].provider).toBe('codex');
      expect(data.decisions[0].model).toBe('gpt-5.3-codex-spark');
    });

    it('detects fallback_used from metadata flags', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      // task-001: no override, no fallback_provider → false
      expect(data.decisions[0].fallback_used).toBe(false);
      // task-002: has fallback_provider → true
      expect(data.decisions[1].fallback_used).toBe(true);
      // task-004: has user_provider_override → true
      expect(data.decisions[2].fallback_used).toBe(true);
    });

    it('detects needs_review from metadata', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions[0].needs_review).toBe(true);
      expect(data.decisions[1].needs_review).toBe(false);
    });

    it('truncates description to 120 chars', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      for (const d of data.decisions) {
        expect(d.description.length).toBeLessThanOrEqual(120);
      }
    });

    it('respects limit query parameter', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, { limit: '1' });
      const data = parseJsonBody(res.body);

      expect(data.decisions.length).toBe(1);
    });

    it('defaults to limit of 50', () => {
      // Note: mock only has 3 routed tasks, so this doesn't truly test the 50 limit.
      // It verifies no artificial cap below 50 is applied.
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions.length).toBe(3);
    });

    it('handles missing listTasks gracefully', () => {
      listTasksSpy.mockRestore();
      const origFn = db.listTasks;
      db.listTasks = undefined;

      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions).toEqual([]);

      db.listTasks = origFn;
    });

    it('skips tasks with unparseable metadata', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      const ids = data.decisions.map(d => d.task_id);
      expect(ids).not.toContain('task-005-99aabb');
    });

    it('returns task status in decisions', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions[0].status).toBe('completed');
      expect(data.decisions[1].status).toBe('running');
      expect(data.decisions[2].status).toBe('failed');
    });

    it('includes created_at timestamp', () => {
      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions[0].created_at).toBe('2026-03-08T12:00:00Z');
    });

    it('handles listTasks returning object with tasks array', () => {
      listTasksSpy.mockReturnValue({ tasks: mockTasks });

      const { res } = createMockRes();
      strategic.handleGetRoutingDecisions({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.decisions.length).toBe(3);
    });
  });

  describe('handleGetProviderHealth', () => {
    let listProvidersSpy;
    let getProviderStatsSpy;
    let getProviderHealthSpy;
    let isProviderHealthySpy;

    beforeEach(() => {
      listProvidersSpy = vi.spyOn(providerRoutingCore, 'listProviders').mockReturnValue(mockProviders);
      getProviderStatsSpy = vi.spyOn(fileTracking, 'getProviderStats').mockImplementation((provider) => {
        const statsMap = {
          codex: { total_tasks: 20, successful_tasks: 18, failed_tasks: 2, success_rate: 90, avg_duration_seconds: 45 },
          ollama: { total_tasks: 10, successful_tasks: 8, failed_tasks: 2, success_rate: 80, avg_duration_seconds: 120 },
          deepinfra: { total_tasks: 5, successful_tasks: 5, failed_tasks: 0, success_rate: 100, avg_duration_seconds: 30 },
          groq: { total_tasks: 0, successful_tasks: 0, failed_tasks: 0, success_rate: 0, avg_duration_seconds: 0 },
        };
        return statsMap[provider] || { total_tasks: 0, successful_tasks: 0, failed_tasks: 0, success_rate: 0, avg_duration_seconds: 0 };
      });
      getProviderHealthSpy = vi.spyOn(providerRoutingCore, 'getProviderHealth').mockImplementation((provider) => {
        const healthMap = {
          codex: { successes: 18, failures: 1, failureRate: 0.05 },
          ollama: { successes: 6, failures: 4, failureRate: 0.4 },
          deepinfra: { successes: 5, failures: 0, failureRate: 0 },
          groq: { successes: 0, failures: 0, failureRate: 0 },
        };
        return healthMap[provider] || { successes: 0, failures: 0, failureRate: 0 };
      });
      isProviderHealthySpy = vi.spyOn(providerRoutingCore, 'isProviderHealthy').mockImplementation((provider) => {
        const healthyMap = { codex: true, ollama: false, deepinfra: true, groq: true };
        return healthyMap[provider] !== undefined ? healthyMap[provider] : true;
      });
    });

    afterEach(() => {
      listProvidersSpy.mockRestore();
      getProviderStatsSpy.mockRestore();
      getProviderHealthSpy.mockRestore();
      isProviderHealthySpy.mockRestore();
    });

    it('returns health data for all providers', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      expect(data.providers.length).toBe(4);
      expect(data.providers.map(p => p.provider)).toEqual(['codex', 'ollama', 'deepinfra', 'groq']);
    });

    it('marks disabled providers as disabled', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      const groq = data.providers.find(p => p.provider === 'groq');
      expect(groq.health_status).toBe('disabled');
      expect(groq.enabled).toBe(false);
    });

    it('marks unhealthy providers as degraded', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      const ollama = data.providers.find(p => p.provider === 'ollama');
      expect(ollama.health_status).toBe('degraded');
    });

    it('marks healthy providers as healthy', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      const codex = data.providers.find(p => p.provider === 'codex');
      expect(codex.health_status).toBe('healthy');
    });

    it('calculates success rate for last hour', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      const codex = data.providers.find(p => p.provider === 'codex');
      expect(codex.success_rate_1h).toBe(95);
    });

    it('returns null success rate when no data', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      const groq = data.providers.find(p => p.provider === 'groq');
      expect(groq.success_rate_1h).toBeNull();
    });

    it('includes task counts for today', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      const codex = data.providers.find(p => p.provider === 'codex');
      expect(codex.tasks_today).toBe(20);
      expect(codex.completed_today).toBe(18);
      expect(codex.failed_today).toBe(2);
    });

    it('includes avg duration', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      const codex = data.providers.find(p => p.provider === 'codex');
      expect(codex.avg_duration_seconds).toBe(45);
    });

    it('handles missing listProviders gracefully', () => {
      listProvidersSpy.mockRestore();
      const origFn = providerRoutingCore.listProviders;
      providerRoutingCore.listProviders = undefined;

      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      expect(data.providers).toEqual([]);

      providerRoutingCore.listProviders = origFn;
    });

    it('handles missing getProviderStats gracefully', () => {
      getProviderStatsSpy.mockRestore();
      const origFn = fileTracking.getProviderStats;
      fileTracking.getProviderStats = undefined;

      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      expect(data.providers.length).toBe(4);
      for (const p of data.providers) {
        expect(p.tasks_today).toBe(0);
      }

      fileTracking.getProviderStats = origFn;
    });

    it('handles missing getProviderHealth gracefully', () => {
      getProviderHealthSpy.mockRestore();
      const origFn = providerRoutingCore.getProviderHealth;
      providerRoutingCore.getProviderHealth = undefined;

      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      expect(data.providers.length).toBe(4);

      providerRoutingCore.getProviderHealth = origFn;
    });

    it('includes successes and failures from 1h window', () => {
      const { res } = createMockRes();
      strategic.handleGetProviderHealth({}, res);
      const data = parseJsonBody(res.body);

      const codex = data.providers.find(p => p.provider === 'codex');
      expect(codex.successes_1h).toBe(18);
      expect(codex.failures_1h).toBe(1);
    });
  });

  describe('handleGetStrategicStatus', () => {
    it('returns strategic status object', () => {
      const { res } = createMockRes();
      strategic.handleGetStrategicStatus({}, res);
      const data = parseJsonBody(res.body);

      // Status comes from real getStrategicStatus which returns the brain's state
      expect(data).toHaveProperty('provider');
      expect(data).toHaveProperty('model');
      expect(data).toHaveProperty('fallback_chain');
      expect(data).toHaveProperty('usage');
    });

    it('includes usage stats', () => {
      const { res } = createMockRes();
      strategic.handleGetStrategicStatus({}, res);
      const data = parseJsonBody(res.body);

      expect(data.usage).toHaveProperty('total_calls');
      expect(data.usage).toHaveProperty('fallback_calls');
    });

    it('returns 200 status', () => {
      const { res } = createMockRes();
      strategic.handleGetStrategicStatus({}, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe('handleGetRecentOperations', () => {
    let listTasksSpy;

    beforeEach(() => {
      listTasksSpy = vi.spyOn(db, 'listTasks').mockReturnValue(mockTasks);
    });

    afterEach(() => {
      listTasksSpy.mockRestore();
    });

    it('returns filtered operations', () => {
      const { res } = createMockRes();
      strategic.handleGetRecentOperations({}, res, {});
      const data = parseJsonBody(res.body);

      expect(Array.isArray(data.operations)).toBe(true);
    });

    it('filters tasks to strategic-related ones', () => {
      const { res } = createMockRes();
      strategic.handleGetRecentOperations({}, res, {});
      const data = parseJsonBody(res.body);

      expect(data.operations.length).toBeGreaterThan(0);
      // Only task-004 contains "strategic" in its description
      for (const op of data.operations) {
        const desc = (op.description || '').toLowerCase();
        const isStrategic = desc.includes('strategic') || desc.includes('decompos') ||
          desc.includes('diagnos') || desc.includes('review');
        expect(isStrategic).toBe(true);
      }
    });

    it('respects limit parameter', () => {
      const { res } = createMockRes();
      strategic.handleGetRecentOperations({}, res, { limit: '1' });
      const data = parseJsonBody(res.body);

      expect(data.operations.length).toBeLessThanOrEqual(1);
    });
  });
});
