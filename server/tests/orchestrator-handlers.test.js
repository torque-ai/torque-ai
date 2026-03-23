import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDecompose = vi.fn();
const mockDiagnose = vi.fn();
const mockReview = vi.fn();
const mockGetUsage = vi.fn();
const mockTaskCore = {
  getTask: vi.fn(),
};

class MockBrain {
  constructor() {}

  async decompose(args) {
    return mockDecompose(args);
  }

  async diagnose(args) {
    return mockDiagnose(args);
  }

  async review(args) {
    return mockReview(args);
  }

  getUsage() {
    return mockGetUsage();
  }
}

let handleStrategicDecompose;
let handleStrategicDiagnose;
let handleStrategicReview;
let handleStrategicUsage;

function loadHandlers() {
  const brainPath = require.resolve('../orchestrator/strategic-brain');
  const taskCorePath = require.resolve('../db/task-core');
  const handlersPath = require.resolve('../handlers/orchestrator-handlers');

  vi.resetModules();
  require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: MockBrain };
  require.cache[taskCorePath] = { id: taskCorePath, filename: taskCorePath, loaded: true, exports: mockTaskCore };
  delete require.cache[handlersPath];

  ({
    handleStrategicDecompose,
    handleStrategicDiagnose,
    handleStrategicReview,
    handleStrategicUsage,
  } = require('../handlers/orchestrator-handlers'));
}

describe('orchestrator-handlers', () => {
  beforeEach(() => {
    mockDecompose.mockReset();
    mockDiagnose.mockReset();
    mockReview.mockReset();
    mockGetUsage.mockReset();
    mockTaskCore.getTask.mockReset();
    loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleStrategicDecompose', () => {
    it('returns decomposition result', async () => {
      mockDecompose.mockResolvedValue({
        tasks: [{ step: 'types', description: 'Create types', depends_on: [] }],
        source: 'llm',
        confidence: 0.85,
      });

      const result = await handleStrategicDecompose({
        feature_name: 'TestFeature',
        working_directory: '/project',
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('TestFeature');
    });

    it('returns error for missing feature_name', async () => {
      const result = await handleStrategicDecompose({ working_directory: '/project' });
      expect(result.isError).toBe(true);
    });
  });

  describe('handleStrategicDiagnose', () => {
    it('diagnoses from inline error_output', async () => {
      mockDiagnose.mockResolvedValue({
        action: 'fix_task',
        reason: 'Missing import',
        source: 'llm',
        confidence: 0.9,
      });

      const result = await handleStrategicDiagnose({
        error_output: 'error TS2304',
        provider: 'codex',
        exit_code: 1,
      });

      expect(result.content[0].text).toContain('fix_task');
    });
  });

  describe('handleStrategicReview', () => {
    it('reviews from inline data', async () => {
      mockReview.mockResolvedValue({
        decision: 'approve',
        reason: 'Looks good',
        quality_score: 85,
        source: 'llm',
      });

      const result = await handleStrategicReview({
        task_output: 'Created FooSystem.ts',
        validation_failures: [],
      });

      expect(result.content[0].text).toContain('approve');
    });
  });

  describe('handleStrategicUsage', () => {
    it('returns usage stats', async () => {
      mockGetUsage.mockReturnValue({
        total_calls: 5,
        total_tokens: 2500,
        total_cost: 0.005,
        total_duration_ms: 10000,
        fallback_calls: 1,
      });

      const result = await handleStrategicUsage({});
      expect(result.content[0].text).toContain('5');
    });
  });
});
