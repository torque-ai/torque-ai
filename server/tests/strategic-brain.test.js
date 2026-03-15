import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSubmit = vi.fn();
vi.mock('../logger', () => ({
  child: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

const StrategicBrain = require('../orchestrator/strategic-brain');

describe('StrategicBrain', () => {
  let brain;
  let providerInstance;

  beforeEach(() => {
    mockSubmit.mockReset();
    providerInstance = {
      submit: (task, model, opts) => mockSubmit(task, model, opts),
    };
    brain = new StrategicBrain({
      provider: 'deepinfra',
      model: 'meta-llama/Llama-3.1-405B-Instruct',
      apiKey: 'test-key',
      providerInstance,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('creates with default config', () => {
      const instance = new StrategicBrain({ apiKey: 'k' });
      expect(instance.provider).toBe('deepinfra');
      expect(instance.model).toBe('meta-llama/Llama-3.1-405B-Instruct');
    });

    it('accepts provider override', () => {
      const instance = new StrategicBrain({ provider: 'hyperbolic', apiKey: 'k' });
      expect(instance.provider).toBe('hyperbolic');
    });

    it('accepts ollama provider and resolves it without throwing', () => {
      const instance = new StrategicBrain({ provider: 'ollama' });
      expect(instance.provider).toBe('ollama');
      expect(() => instance._getProvider()).not.toThrow();
      expect(instance._getProvider().name).toBe('ollama');
    });
  });

  describe('decompose', () => {
    it('calls LLM and returns parsed tasks', async () => {
      mockSubmit.mockResolvedValue({
        output: JSON.stringify({
          tasks: [
            { step: 'types', description: 'Create types', depends_on: [] },
            { step: 'system', description: 'Create system', depends_on: ['types'] },
          ],
          reasoning: 'Standard',
          confidence: 0.85,
        }),
        status: 'completed',
        usage: { tokens: 500, cost: 0.001, duration_ms: 2000 },
      });

      const result = await brain.decompose({
        feature_name: 'TestFeature',
        working_directory: '/project',
      });

      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].step).toBe('types');
      expect(result.source).toBe('llm');
    });

    it('falls back to deterministic on LLM failure', async () => {
      mockSubmit.mockRejectedValue(new Error('API unavailable'));

      const result = await brain.decompose({
        feature_name: 'TestFeature',
        working_directory: '/project',
      });

      expect(result.tasks).toHaveLength(6);
      expect(result.source).toBe('deterministic');
    });

    it('falls back to deterministic on invalid JSON', async () => {
      mockSubmit.mockResolvedValue({
        output: 'This is not JSON at all.',
        status: 'completed',
        usage: { tokens: 100, cost: 0.0001, duration_ms: 1000 },
      });

      const result = await brain.decompose({
        feature_name: 'TestFeature',
        working_directory: '/project',
      });

      expect(result.source).toBe('deterministic');
    });

    it('falls back on low confidence', async () => {
      mockSubmit.mockResolvedValue({
        output: JSON.stringify({
          tasks: [{ step: 'types', description: 'maybe?', depends_on: [] }],
          confidence: 0.2,
        }),
        status: 'completed',
        usage: { tokens: 200, cost: 0.0002, duration_ms: 1000 },
      });

      const result = await brain.decompose({
        feature_name: 'TestFeature',
        working_directory: '/project',
      });

      expect(result.source).toBe('deterministic');
    });
  });

  describe('diagnose', () => {
    it('calls LLM and returns diagnosis', async () => {
      mockSubmit.mockResolvedValue({
        output: JSON.stringify({
          action: 'fix_task',
          reason: 'Missing import',
          fix_description: 'Add import',
          confidence: 0.9,
        }),
        status: 'completed',
        usage: { tokens: 300, cost: 0.0005, duration_ms: 1500 },
      });

      const result = await brain.diagnose({
        error_output: 'error TS2304',
        provider: 'codex',
        exit_code: 1,
      });

      expect(result.action).toBe('fix_task');
      expect(result.source).toBe('llm');
    });

    it('falls back to deterministic on LLM failure', async () => {
      mockSubmit.mockRejectedValue(new Error('timeout'));

      const result = await brain.diagnose({
        error_output: 'CUDA out of memory',
        provider: 'ollama',
        exit_code: 1,
      });

      expect(result.action).toBe('switch_provider');
      expect(result.source).toBe('deterministic');
    });
  });

  describe('review', () => {
    it('calls LLM and returns review decision', async () => {
      mockSubmit.mockResolvedValue({
        output: JSON.stringify({
          decision: 'approve',
          reason: 'Looks good',
          quality_score: 85,
          issues: [],
          confidence: 0.9,
        }),
        status: 'completed',
        usage: { tokens: 400, cost: 0.0008, duration_ms: 2000 },
      });

      const result = await brain.review({
        task_output: 'Created FooSystem.ts',
        validation_failures: [],
        file_size_delta_pct: 10,
      });

      expect(result.decision).toBe('approve');
      expect(result.source).toBe('llm');
    });

    it('falls back to deterministic on LLM failure', async () => {
      mockSubmit.mockRejectedValue(new Error('rate limited'));

      const result = await brain.review({
        validation_failures: [{ severity: 'critical', rule: 'stub_detection' }],
        file_size_delta_pct: -60,
      });

      expect(result.decision).toBe('reject');
      expect(result.source).toBe('deterministic');
    });
  });

  describe('usage tracking', () => {
    it('tracks cumulative usage across calls', async () => {
      mockSubmit.mockResolvedValue({
        output: '{"tasks":[{"step":"types","description":"x","depends_on":[]}],"confidence":0.8}',
        status: 'completed',
        usage: { tokens: 500, cost: 0.001, duration_ms: 2000 },
      });

      await brain.decompose({ feature_name: 'A', working_directory: '/p' });
      await brain.decompose({ feature_name: 'B', working_directory: '/p' });

      const usage = brain.getUsage();
      expect(usage.total_calls).toBe(2);
      expect(usage.total_tokens).toBe(1000);
      expect(usage.total_cost).toBeCloseTo(0.002);
    });

    it('counts fallback calls separately', async () => {
      mockSubmit.mockRejectedValue(new Error('fail'));

      await brain.decompose({ feature_name: 'A', working_directory: '/p' });

      const usage = brain.getUsage();
      expect(usage.total_calls).toBe(0);
      expect(usage.fallback_calls).toBe(1);
    });
  });
});
