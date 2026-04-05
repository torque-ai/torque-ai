import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const HANDLER_MODULE = '../handlers/evidence-risk-handlers';
const CONTAINER_MODULE = '../container';
const MODULE_PATHS = [
  HANDLER_MODULE,
  CONTAINER_MODULE,
];

const fileRisk = {
  getFileRisk: vi.fn(),
  getTaskRiskSummary: vi.fn(),
  setManualOverride: vi.fn(),
  getFilesAtRisk: vi.fn(),
};

const verificationLedger = {
  getChecksForTask: vi.fn(),
  getCheckSummary: vi.fn(),
};

const adversarialReviews = {
  getReviewsForTask: vi.fn(),
};

const taskCore = {
  getTask: vi.fn(),
};

const services = {
  fileRisk,
  verificationLedger,
  adversarialReviews,
  taskCore,
};

const defaultContainer = {
  get: vi.fn(),
};

let handlers;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that were not loaded in this test process.
  }
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) {
    clearModule(modulePath);
  }
}

function resetServiceMocks() {
  fileRisk.getFileRisk.mockReset();
  fileRisk.getTaskRiskSummary.mockReset();
  fileRisk.setManualOverride.mockReset();
  fileRisk.getFilesAtRisk.mockReset();
  verificationLedger.getChecksForTask.mockReset();
  verificationLedger.getCheckSummary.mockReset();
  adversarialReviews.getReviewsForTask.mockReset();
  taskCore.getTask.mockReset();

  verificationLedger.getChecksForTask.mockReturnValue([]);
  verificationLedger.getCheckSummary.mockReturnValue({});
  adversarialReviews.getReviewsForTask.mockReturnValue([]);

  defaultContainer.get.mockReset();
  defaultContainer.get.mockImplementation((name) => {
    if (!Object.prototype.hasOwnProperty.call(services, name)) {
      throw new Error(`Unknown service: ${name}`);
    }
    return services[name];
  });
}

function loadHandlers() {
  clearModules();
  installCjsModuleMock(CONTAINER_MODULE, { defaultContainer });
  return require(HANDLER_MODULE);
}

function getText(result) {
  return result?.content?.[0]?.text ?? '';
}

function parsePayload(result) {
  return JSON.parse(getText(result));
}

function expectError(result, errorCode, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(errorCode);
  expect(getText(result)).toContain(textFragment);
}

beforeEach(() => {
  setupTestDbOnly('evidence-risk-handlers');
  resetServiceMocks();
  handlers = loadHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearModules();
  teardownTestDb();
});

describe('handlers/evidence-risk-handlers', () => {
  it('handleGetFileRisk returns found:true with parsed risk data', () => {
    fileRisk.getFileRisk.mockReturnValue({
      file_path: 'src/engine.js',
      working_directory: '/repo',
      risk_level: 'high',
      risk_reasons: '["touches scheduler","missing verification"]',
      auto_scored: 1,
      scored_by: 'risk-engine',
      scored_at: '2026-04-05T12:00:00.000Z',
    });

    const result = handlers.handleGetFileRisk({
      file_path: 'src/engine.js',
      working_directory: '/repo',
    });
    const payload = parsePayload(result);

    expect(fileRisk.getFileRisk).toHaveBeenCalledWith('src/engine.js', '/repo');
    expect(payload).toEqual({
      found: true,
      file_path: 'src/engine.js',
      working_directory: '/repo',
      risk_level: 'high',
      risk_reasons: ['touches scheduler', 'missing verification'],
      auto_scored: true,
      scored_by: 'risk-engine',
      scored_at: '2026-04-05T12:00:00.000Z',
    });
  });

  it('handleGetFileRisk returns found:false when no record exists', () => {
    fileRisk.getFileRisk.mockReturnValue(null);

    const result = handlers.handleGetFileRisk({
      file_path: 'src/missing.js',
      working_directory: '/repo',
    });
    const payload = parsePayload(result);

    expect(payload).toEqual({
      found: false,
      file_path: 'src/missing.js',
      working_directory: '/repo',
      message: 'No risk data found for src/missing.js',
    });
  });

  it('handleGetFileRisk returns an error when file_path is missing', () => {
    const result = handlers.handleGetFileRisk({
      working_directory: '/repo',
    });

    expectError(result, 'MISSING_REQUIRED_PARAM', 'file_path is required');
    expect(defaultContainer.get).not.toHaveBeenCalled();
    expect(fileRisk.getFileRisk).not.toHaveBeenCalled();
  });

  it('handleGetTaskRiskSummary returns summary counts and message', () => {
    fileRisk.getTaskRiskSummary.mockReturnValue({
      high: [{ file_path: 'src/a.js' }],
      medium: [{ file_path: 'src/b.js' }, { file_path: 'src/c.js' }],
      low: [],
      unscored: [{ file_path: 'src/d.js' }],
      overall_risk: 'high',
    });

    const result = handlers.handleGetTaskRiskSummary({ task_id: 'task-123' });
    const payload = parsePayload(result);

    expect(fileRisk.getTaskRiskSummary).toHaveBeenCalledWith('task-123');
    expect(payload.task_id).toBe('task-123');
    expect(payload.counts).toEqual({
      high: 1,
      medium: 2,
      low: 0,
      unscored: 1,
    });
    expect(payload.overall_risk).toBe('high');
    expect(payload.message).toContain('1 high, 2 medium, 0 low, 1 unscored');
  });

  it('handleSetFileRiskOverride validates params and calls setManualOverride', () => {
    fileRisk.getFileRisk.mockReturnValue({
      risk_level: 'medium',
      risk_reasons: '["accepted after review"]',
    });

    const result = handlers.handleSetFileRiskOverride({
      file_path: 'src/engine.js',
      working_directory: '/repo',
      risk_level: ' Medium ',
      reason: ' accepted after review ',
    });
    const payload = parsePayload(result);

    expect(fileRisk.setManualOverride).toHaveBeenCalledWith(
      'src/engine.js',
      '/repo',
      'medium',
      'accepted after review',
    );
    expect(fileRisk.getFileRisk).toHaveBeenCalledWith('src/engine.js', '/repo');
    expect(payload).toEqual({
      file_path: 'src/engine.js',
      working_directory: '/repo',
      risk_level: 'medium',
      risk_reasons: ['accepted after review'],
      auto_scored: false,
      override: true,
      reason: 'accepted after review',
    });
  });

  it('handleSetFileRiskOverride rejects an invalid risk_level', () => {
    const result = handlers.handleSetFileRiskOverride({
      file_path: 'src/engine.js',
      working_directory: '/repo',
      risk_level: 'critical',
      reason: 'needs escalation',
    });

    expectError(result, 'INVALID_PARAM', 'risk_level must be one of: high, medium, low');
    expect(fileRisk.setManualOverride).not.toHaveBeenCalled();
  });

  it('handleGetHighRiskFiles returns filtered files with parsed reasons', () => {
    fileRisk.getFilesAtRisk.mockReturnValue([
      {
        file_path: 'src/high.js',
        risk_level: 'high',
        risk_reasons: '["modifies approval flow"]',
        auto_scored: 1,
        scored_by: 'risk-engine',
        scored_at: '2026-04-05T11:00:00.000Z',
      },
      {
        file_path: 'src/medium.js',
        risk_level: 'medium',
        risk_reasons: '["touches persistence"]',
        auto_scored: 0,
        scored_by: 'manual',
        scored_at: '2026-04-05T11:05:00.000Z',
      },
    ]);

    const result = handlers.handleGetHighRiskFiles({
      working_directory: '/repo',
      min_level: 'medium',
    });
    const payload = parsePayload(result);

    expect(fileRisk.getFilesAtRisk).toHaveBeenCalledWith('/repo', 'medium');
    expect(payload.count).toBe(2);
    expect(payload.min_level).toBe('medium');
    expect(payload.files).toEqual([
      {
        file_path: 'src/high.js',
        risk_level: 'high',
        risk_reasons: ['modifies approval flow'],
        auto_scored: true,
        scored_by: 'risk-engine',
        scored_at: '2026-04-05T11:00:00.000Z',
      },
      {
        file_path: 'src/medium.js',
        risk_level: 'medium',
        risk_reasons: ['touches persistence'],
        auto_scored: false,
        scored_by: 'manual',
        scored_at: '2026-04-05T11:05:00.000Z',
      },
    ]);
    expect(payload.message).toContain('Found 2 file(s)');
  });

  it('handleGetVerificationChecks returns checks for a task with filters', () => {
    verificationLedger.getChecksForTask.mockReturnValue([
      {
        id: 'check-1',
        phase: 'build',
        check_name: 'unit-tests',
        status: 'passed',
      },
    ]);

    const result = handlers.handleGetVerificationChecks({
      task_id: 'task-123',
      phase: 'build',
      check_name: 'unit-tests',
    });
    const payload = parsePayload(result);

    expect(verificationLedger.getChecksForTask).toHaveBeenCalledWith('task-123', {
      phase: 'build',
      checkName: 'unit-tests',
    });
    expect(payload).toEqual({
      task_id: 'task-123',
      count: 1,
      checks: [
        {
          id: 'check-1',
          phase: 'build',
          check_name: 'unit-tests',
          status: 'passed',
        },
      ],
      phase: 'build',
      check_name: 'unit-tests',
      message: 'Found 1 verification check(s) for task task-123',
    });
  });

  it('handleGetVerificationLedger mirrors the verification checks payload', () => {
    verificationLedger.getChecksForTask.mockReturnValue([
      {
        id: 'check-2',
        phase: 'verify',
        check_name: 'lint',
        status: 'failed',
      },
    ]);

    const result = handlers.handleGetVerificationLedger({ task_id: 'task-456' });
    const payload = parsePayload(result);

    expect(verificationLedger.getChecksForTask).toHaveBeenCalledWith('task-456', {});
    expect(payload.count).toBe(1);
    expect(payload.checks[0].check_name).toBe('lint');
    expect(payload.message).toContain('task task-456');
  });

  it('handleGetVerificationSummary returns a workflow summary with totals', () => {
    verificationLedger.getCheckSummary.mockReturnValue({
      build: { total: 2, passed: 1, failed: 1 },
      verify: { total: 3, passed: 3, failed: 0 },
    });

    const result = handlers.handleGetVerificationSummary({ workflow_id: 'wf-9' });
    const payload = parsePayload(result);

    expect(verificationLedger.getCheckSummary).toHaveBeenCalledWith('wf-9');
    expect(payload).toEqual({
      workflow_id: 'wf-9',
      total: 5,
      summary: {
        build: { total: 2, passed: 1, failed: 1 },
        verify: { total: 3, passed: 3, failed: 0 },
      },
      message: 'Verification check summary for workflow wf-9: 5 checks',
    });
  });

  it('handleGetAdversarialReviews returns reviews with parsed issues', async () => {
    adversarialReviews.getReviewsForTask.mockReturnValue([
      {
        id: 'review-1',
        task_id: 'task-123',
        reviewer: 'deepinfra',
        issues: '[{"severity":"high","title":"Race condition"}]',
      },
    ]);

    const result = await handlers.handleGetAdversarialReviews({ task_id: 'task-123' });
    const payload = parsePayload(result);

    expect(adversarialReviews.getReviewsForTask).toHaveBeenCalledWith('task-123');
    expect(payload.task_id).toBe('task-123');
    expect(payload.count).toBe(1);
    expect(payload.reviews).toEqual([
      {
        id: 'review-1',
        task_id: 'task-123',
        reviewer: 'deepinfra',
        issues: [{ severity: 'high', title: 'Race condition' }],
      },
    ]);
  });

  it('handleRequestAdversarialReview returns an error when task_id is missing', async () => {
    const result = await handlers.handleRequestAdversarialReview({
      working_directory: '/repo',
    });

    expectError(result, 'MISSING_REQUIRED_PARAM', 'task_id is required');
    expect(defaultContainer.get).not.toHaveBeenCalled();
  });
});
