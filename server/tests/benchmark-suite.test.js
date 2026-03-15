'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

function installMock(modulePath, exportsValue) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath),
    filename: require.resolve(modulePath),
    loaded: true,
    exports: exportsValue,
  };
}

const SUITE_MODULE = '../orchestrator/benchmark-suite';
const HANDLERS_MODULE = '../handlers/orchestrator-handlers';
const DATABASE_MODULE = '../database';
const TASK_MANAGER_MODULE = '../task-manager';
const STRATEGIC_BRAIN_MODULE = '../orchestrator/strategic-brain';

const {
  DECOMPOSE_CASES,
  DIAGNOSE_CASES,
  REVIEW_CASES,
} = require(SUITE_MODULE);

const TOTAL_CASES = DECOMPOSE_CASES.length + DIAGNOSE_CASES.length + REVIEW_CASES.length;

const decomposeCaseByFeature = new Map(
  DECOMPOSE_CASES.map((testCase) => [testCase.input.feature_name, testCase])
);
const diagnoseCaseByDescription = new Map(
  DIAGNOSE_CASES.map((testCase) => [testCase.input.task_description, testCase])
);
const reviewCaseByDescription = new Map(
  REVIEW_CASES.map((testCase) => [testCase.input.task_description, testCase])
);

const mockDb = {
  getTask: vi.fn(),
};

const mockTaskManager = {};

const brainMocks = {
  decompose: vi.fn(),
  diagnose: vi.fn(),
  review: vi.fn(),
  getUsage: vi.fn(),
};

class MockStrategicBrain {
  constructor(config = {}) {
    this.provider = config.provider || 'mock-provider';
    this.model = config.model || 'mock-model';
    this.confidenceThreshold = 0.4;
  }

  async decompose(args) {
    return brainMocks.decompose(args);
  }

  async diagnose(args) {
    return brainMocks.diagnose(args);
  }

  async review(args) {
    return brainMocks.review(args);
  }

  getUsage() {
    return brainMocks.getUsage();
  }
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // no-op
  }
}

function requireCase(map, key, label) {
  const testCase = map.get(key);
  if (!testCase) {
    throw new Error(`Unexpected ${label}: ${key}`);
  }
  return testCase;
}

function createTasks(testCase, count = testCase.expected_min_tasks) {
  const orderedSteps = [
    ...(testCase.required_steps || []),
    'types',
    'data',
    'events',
    'system',
    'tests',
    'wire',
    'docs',
    'cleanup',
  ].filter((step, index, steps) => steps.indexOf(step) === index);

  return Array.from({ length: count }, (_, index) => ({
    step: orderedSteps[index] || `step_${index + 1}`,
    description: `${testCase.input.feature_name} task ${index + 1}`,
    depends_on: index === 0 ? [] : [orderedSteps[index - 1] || `step_${index}`],
  }));
}

function configureSuccessfulBrain() {
  brainMocks.getUsage.mockReturnValue({
    total_calls: 0,
    total_tokens: 0,
    total_cost: 0,
    total_duration_ms: 0,
    fallback_calls: 0,
  });

  brainMocks.decompose.mockImplementation(async (input) => {
    const testCase = requireCase(decomposeCaseByFeature, input.feature_name, 'decompose feature');
    return {
      source: 'llm',
      confidence: 0.9,
      usage: { tokens: 100, cost: 0.01 },
      tasks: createTasks(testCase),
    };
  });

  brainMocks.diagnose.mockImplementation(async (input) => {
    const testCase = requireCase(diagnoseCaseByDescription, input.task_description, 'diagnose case');
    return {
      source: 'llm',
      confidence: 0.85,
      usage: { tokens: 50, cost: 0.02 },
      action: testCase.expected_action,
      reason: `Matched ${testCase.name}`,
    };
  });

  brainMocks.review.mockImplementation(async (input) => {
    const testCase = requireCase(reviewCaseByDescription, input.task_description, 'review case');
    return {
      source: 'llm',
      confidence: 0.95,
      usage: { tokens: 25, cost: 0.03 },
      decision: testCase.expected_decision,
      reason: `Matched ${testCase.name}`,
      quality_score: testCase.expected_decision === 'approve' ? 92 : 18,
    };
  });
}

function loadHandlers() {
  clearModule(HANDLERS_MODULE);
  installMock(DATABASE_MODULE, mockDb);
  installMock(TASK_MANAGER_MODULE, mockTaskManager);
  installMock(STRATEGIC_BRAIN_MODULE, MockStrategicBrain);
  return require(HANDLERS_MODULE);
}

beforeEach(() => {
  mockDb.getTask.mockReset();
  brainMocks.decompose.mockReset();
  brainMocks.diagnose.mockReset();
  brainMocks.review.mockReset();
  brainMocks.getUsage.mockReset();
  configureSuccessfulBrain();
  clearModule(HANDLERS_MODULE);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearModule(HANDLERS_MODULE);
  clearModule(DATABASE_MODULE);
  clearModule(TASK_MANAGER_MODULE);
  clearModule(STRATEGIC_BRAIN_MODULE);
});

describe('orchestrator/benchmark-suite exports', () => {
  it('exports the expected benchmark case buckets', () => {
    expect(DECOMPOSE_CASES).toHaveLength(3);
    expect(DIAGNOSE_CASES).toHaveLength(3);
    expect(REVIEW_CASES).toHaveLength(2);
  });

  it('defines decompose cases with bounded task expectations and required steps', () => {
    for (const testCase of DECOMPOSE_CASES) {
      expect(testCase.name).toBeTruthy();
      expect(testCase.input.feature_name).toBeTruthy();
      expect(testCase.expected_min_tasks).toBeGreaterThan(0);
      expect(testCase.expected_max_tasks).toBeGreaterThanOrEqual(testCase.expected_min_tasks);
      expect(Array.isArray(testCase.required_steps)).toBe(true);
      expect(testCase.required_steps.length).toBeGreaterThan(0);

      const generatedTasks = createTasks(testCase);
      expect(generatedTasks).toHaveLength(testCase.expected_min_tasks);
      for (const step of testCase.required_steps) {
        expect(generatedTasks.map((task) => task.step)).toContain(step);
      }
    }
  });

  it('defines diagnose and review cases with explicit expected outcomes', () => {
    for (const testCase of DIAGNOSE_CASES) {
      expect(testCase.name).toBeTruthy();
      expect(testCase.input.task_description).toBeTruthy();
      expect(testCase.input.error_output).toBeTruthy();
      expect(testCase.expected_action).toMatch(/^(fix_task|retry|switch_provider|escalate)$/);
    }

    for (const testCase of REVIEW_CASES) {
      expect(testCase.name).toBeTruthy();
      expect(testCase.input.task_description).toBeTruthy();
      expect(testCase.input.task_output).toBeTruthy();
      expect(Array.isArray(testCase.input.validation_failures)).toBe(true);
      expect(testCase.expected_decision).toMatch(/^(approve|reject)$/);
    }
  });
});

describe('handleStrategicBenchmark', () => {
  it('executes the decompose suite and records passing task-count expectations', async () => {
    const { handleStrategicBenchmark } = loadHandlers();

    const result = await handleStrategicBenchmark({ suite: 'decompose' });

    expect(brainMocks.decompose).toHaveBeenCalledTimes(DECOMPOSE_CASES.length);
    expect(result.data.results).toHaveLength(DECOMPOSE_CASES.length);
    expect(result.data.results.every((entry) => entry.expected_met)).toBe(true);
    expect(result.data.results.map((entry) => entry.task_name)).toEqual([
      'decompose/simple_feature',
      'decompose/complex_feature',
      'decompose/infrastructure_task',
    ]);
    expect(result.content[0].text).toContain('| Passed | 3/3 (100%) |');
  });

  it('aggregates all suites and summarizes llm usage metrics', async () => {
    const { handleStrategicBenchmark } = loadHandlers();

    const result = await handleStrategicBenchmark({ suite: 'all' });

    expect(result.data.summary.total_runs).toBe(TOTAL_CASES);
    expect(result.data.summary.llm_runs).toBe(TOTAL_CASES);
    expect(result.data.summary.fallback_runs).toBe(0);
    expect(result.data.summary.total_tokens).toBe(500);
    expect(result.data.summary.total_cost).toBeCloseTo(0.15, 6);
    expect(result.data.summary.avg_confidence).toBeCloseTo(0.89375, 6);
    expect(result.content[0].text).toContain('| Total Runs | 8 |');
    expect(result.content[0].text).toContain('| Passed | 8/8 (100%) |');
  });

  it('counts deterministic results separately from llm results', async () => {
    brainMocks.decompose.mockImplementation(async (input) => {
      const testCase = requireCase(decomposeCaseByFeature, input.feature_name, 'decompose feature');
      if (input.feature_name === 'MetricsCollector') {
        return {
          source: 'deterministic',
          confidence: 0.6,
          usage: { tokens: 0, cost: 0 },
          tasks: createTasks(testCase),
        };
      }

      return {
        source: 'llm',
        confidence: 0.9,
        usage: { tokens: 100, cost: 0.01 },
        tasks: createTasks(testCase),
      };
    });

    const { handleStrategicBenchmark } = loadHandlers();
    const result = await handleStrategicBenchmark({ suite: 'decompose' });

    expect(result.data.summary.llm_runs).toBe(2);
    expect(result.data.summary.fallback_runs).toBe(1);
    expect(result.data.results.find((entry) => entry.task_name === 'decompose/infrastructure_task').source).toBe('deterministic');
  });

  it('scores mixed pass and fail results based on expected outcomes', async () => {
    brainMocks.decompose.mockImplementation(async (input) => {
      const testCase = requireCase(decomposeCaseByFeature, input.feature_name, 'decompose feature');
      const count = input.feature_name === 'HealthBar'
        ? testCase.expected_max_tasks + 1
        : testCase.expected_min_tasks;

      return {
        source: 'llm',
        confidence: 0.9,
        usage: { tokens: 100, cost: 0.01 },
        tasks: createTasks(testCase, count),
      };
    });

    const { handleStrategicBenchmark } = loadHandlers();
    const result = await handleStrategicBenchmark({ suite: 'decompose' });

    const passed = result.data.results.filter((entry) => entry.expected_met);
    expect(passed).toHaveLength(2);
    expect(result.data.results.find((entry) => entry.task_name === 'decompose/simple_feature').expected_met).toBe(false);
    expect(result.content[0].text).toContain('| Passed | 2/3 (67%) |');
  });

  it('renders csv output with one row per benchmark result', async () => {
    const { handleStrategicBenchmark } = loadHandlers();

    const result = await handleStrategicBenchmark({
      suite: 'diagnose',
      output_format: 'csv',
    });

    const lines = result.content[0].text.trim().split('\n');
    expect(lines[0]).toBe('task_name,source,duration_ms,tokens,cost,confidence,quality_score,timestamp');
    expect(lines).toHaveLength(DIAGNOSE_CASES.length + 1);
    expect(lines[1]).toContain('diagnose/typescript_error,llm,');
  });

  it('captures per-case execution errors and keeps running the suite', async () => {
    brainMocks.diagnose.mockImplementation(async (input) => {
      const testCase = requireCase(diagnoseCaseByDescription, input.task_description, 'diagnose case');
      if (input.task_description === 'Generate comprehensive test suite') {
        throw new Error('benchmark explosion');
      }

      return {
        source: 'llm',
        confidence: 0.85,
        usage: { tokens: 50, cost: 0.02 },
        action: testCase.expected_action,
        reason: `Matched ${testCase.name}`,
      };
    });

    const { handleStrategicBenchmark } = loadHandlers();
    const result = await handleStrategicBenchmark({
      suite: 'diagnose',
      output_format: 'full',
    });

    const failed = result.data.results.find((entry) => entry.task_name === 'diagnose/timeout_error');
    expect(result.data.results).toHaveLength(DIAGNOSE_CASES.length);
    expect(failed.source).toBe('error');
    expect(failed.error).toBe('benchmark explosion');
    expect(failed.expected_met).toBe(false);
    expect(result.content[0].text).toContain('diagnose/timeout_error');
    expect(result.content[0].text).toContain('FAIL (benchmark explosion)');
    expect(result.content[0].text).toContain('2/3 passed');
  });

  it('returns an invalid parameter error for unknown suites', async () => {
    const { handleStrategicBenchmark } = loadHandlers();

    const result = await handleStrategicBenchmark({ suite: 'unknown-suite' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(result.content[0].text).toContain('Unknown suite: unknown-suite');
  });
});
