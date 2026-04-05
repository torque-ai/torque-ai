'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const HANDLER_MODULE = '../api/v2-audit-handlers';
const CONTROL_PLANE_MODULE = '../api/v2-control-plane';
const MIDDLEWARE_MODULE = '../api/middleware';
const LOGGER_MODULE = '../logger';
const MODULE_PATHS = [
  HANDLER_MODULE,
  CONTROL_PLANE_MODULE,
  MIDDLEWARE_MODULE,
  LOGGER_MODULE,
];

const FIXED_TIMESTAMP = '2026-04-05T00:00:00.000Z';

const mockParseBody = vi.fn();
const mockLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};
const mockLoggerModule = {
  child: vi.fn(() => mockLogger),
};
const mockControlPlane = {
  sendSuccess: vi.fn(),
  sendError: vi.fn(),
  resolveRequestId: vi.fn(),
};

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
    // Ignore modules that were never loaded in this test worker.
  }
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) {
    clearModule(modulePath);
  }
}

function loadHandlers() {
  clearModules();
  installCjsModuleMock(CONTROL_PLANE_MODULE, mockControlPlane);
  installCjsModuleMock(MIDDLEWARE_MODULE, { parseBody: mockParseBody });
  installCjsModuleMock(LOGGER_MODULE, mockLoggerModule);
  return require(HANDLER_MODULE);
}

function createAuditStore() {
  return {
    listAuditRuns: vi.fn(() => []),
    getFindings: vi.fn(() => []),
    updateFinding: vi.fn(() => 1),
    getAuditSummary: vi.fn(() => null),
  };
}

function createOrchestrator() {
  return {
    runAudit: vi.fn(async () => ({
      audit_run_id: 'run-default',
      status: 'running',
    })),
  };
}

function resetControlPlaneMocks() {
  mockControlPlane.resolveRequestId.mockReset().mockImplementation((req) => (
    req?.requestId || req?.headers?.['x-request-id'] || 'req-default'
  ));

  mockControlPlane.sendSuccess.mockReset().mockImplementation((res, requestId, data, statusCode = 200, req) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req?.requestId) {
      headers['X-Request-ID'] = req.requestId;
    }
    res.writeHead(statusCode, headers);
    res.end(JSON.stringify({
      data,
      meta: {
        request_id: requestId,
        timestamp: FIXED_TIMESTAMP,
      },
    }));
  });

  mockControlPlane.sendError.mockReset().mockImplementation((res, requestId, code, message, statusCode = 400, details = {}, req) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req?.requestId) {
      headers['X-Request-ID'] = req.requestId;
    }
    res.writeHead(statusCode, headers);
    res.end(JSON.stringify({
      error: {
        code,
        message,
        details,
        request_id: requestId,
      },
      meta: {
        request_id: requestId,
        timestamp: FIXED_TIMESTAMP,
      },
    }));
  });
}

function mockReq(overrides = {}) {
  return { headers: {}, query: {}, params: {}, ...overrides };
}

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.writeHead = vi.fn((code, hdrs) => { res.statusCode = code; Object.assign(res.headers, hdrs); });
  res.end = vi.fn((data) => { res.body = data; });
  return res;
}

function parseResponse(res) {
  expect(res.end).toHaveBeenCalledOnce();
  expect(res.end).toHaveBeenCalledWith(res.body);
  expect(typeof res.body).toBe('string');
  return JSON.parse(res.body);
}

describe('api/v2-audit-handlers', () => {
  let handlers;
  let mockAuditStore;
  let mockOrchestrator;

  beforeEach(() => {
    setupTestDbOnly('v2-audit-handlers');
    clearModules();

    mockParseBody.mockReset().mockResolvedValue({});
    mockLogger.error.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.info.mockReset();
    mockLogger.debug.mockReset();
    mockLoggerModule.child.mockReset().mockReturnValue(mockLogger);
    resetControlPlaneMocks();

    mockAuditStore = createAuditStore();
    mockOrchestrator = createOrchestrator();

    handlers = loadHandlers();
    handlers.init({ auditStore: mockAuditStore, orchestrator: mockOrchestrator });
  });

  afterEach(() => {
    teardownTestDb();
    clearModules();
    vi.restoreAllMocks();
  });

  it('handleStartAudit returns error when orchestrator not initialized', async () => {
    handlers.init({ auditStore: mockAuditStore, orchestrator: null });
    const req = mockReq({ headers: { 'x-request-id': 'req-start-missing-orch' } });
    const res = mockRes();

    await handlers.handleStartAudit(req, res);

    expect(mockParseBody).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(parseResponse(res)).toEqual({
      error: {
        code: 'internal_error',
        message: 'Audit orchestrator not initialized',
        details: {},
        request_id: 'req-start-missing-orch',
      },
      meta: {
        request_id: 'req-start-missing-orch',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handleStartAudit returns error when path is missing', async () => {
    const req = mockReq({ headers: { 'x-request-id': 'req-start-no-path' } });
    const res = mockRes();

    mockParseBody.mockResolvedValue({});

    await handlers.handleStartAudit(req, res);

    expect(mockParseBody).toHaveBeenCalledWith(req);
    expect(mockOrchestrator.runAudit).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(parseResponse(res)).toEqual({
      error: {
        code: 'validation_error',
        message: 'path is required',
        details: {},
        request_id: 'req-start-no-path',
      },
      meta: {
        request_id: 'req-start-no-path',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handleStartAudit calls orchestrator.runAudit with correct params', async () => {
    const req = mockReq({ headers: { 'x-request-id': 'req-start-ok' } });
    const res = mockRes();
    const body = {
      path: '/repo/project',
      categories: ['security'],
      subcategories: ['injection.sql'],
      provider: 'codex',
      model: 'gpt-5',
      source_dirs: ['server', 'dashboard'],
      ignore_dirs: ['node_modules'],
      ignore_patterns: ['*.snap'],
      dry_run: true,
    };
    const result = {
      audit_run_id: 'run-123',
      workflow_id: 'wf-123',
      status: 'running',
      total_files: 7,
    };

    mockParseBody.mockResolvedValue(body);
    mockOrchestrator.runAudit.mockResolvedValue(result);

    await handlers.handleStartAudit(req, res);

    expect(mockOrchestrator.runAudit).toHaveBeenCalledWith({
      path: '/repo/project',
      categories: ['security'],
      subcategories: ['injection.sql'],
      provider: 'codex',
      model: 'gpt-5',
      source_dirs: ['server', 'dashboard'],
      ignore_dirs: ['node_modules'],
      ignore_patterns: ['*.snap'],
      dry_run: true,
    });
    expect(res.statusCode).toBe(201);
    expect(parseResponse(res)).toEqual({
      data: result,
      meta: {
        request_id: 'req-start-ok',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handleListRuns returns runs array', async () => {
    const req = mockReq({
      headers: { 'x-request-id': 'req-list-runs' },
      query: {
        project_path: '/repo/project',
        status: 'completed',
        limit: '5',
      },
    });
    const res = mockRes();
    const runs = [
      { id: 'run-1', status: 'completed' },
      { id: 'run-2', status: 'running' },
    ];

    mockAuditStore.listAuditRuns.mockReturnValue(runs);

    await handlers.handleListRuns(req, res);

    expect(mockAuditStore.listAuditRuns).toHaveBeenCalledWith({
      project_path: '/repo/project',
      status: 'completed',
      limit: 5,
    });
    expect(res.statusCode).toBe(200);
    expect(parseResponse(res)).toEqual({
      data: { runs },
      meta: {
        request_id: 'req-list-runs',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handleGetRunFindings returns findings with filters', async () => {
    const req = mockReq({
      headers: { 'x-request-id': 'req-run-findings' },
      params: { id: 'run-55' },
      query: {
        category: 'security',
        severity: 'high',
        confidence: 'medium',
        file_path: 'server/api/v2-audit-handlers.js',
        limit: '10',
        offset: '20',
      },
    });
    const res = mockRes();
    const findings = [
      { id: 'finding-1', title: 'SQL injection', severity: 'high' },
    ];

    mockAuditStore.getFindings.mockReturnValue(findings);

    await handlers.handleGetRunFindings(req, res);

    expect(mockAuditStore.getFindings).toHaveBeenCalledWith({
      audit_run_id: 'run-55',
      category: 'security',
      severity: 'high',
      confidence: 'medium',
      file_path: 'server/api/v2-audit-handlers.js',
      limit: 10,
      offset: 20,
    });
    expect(res.statusCode).toBe(200);
    expect(parseResponse(res)).toEqual({
      data: { findings },
      meta: {
        request_id: 'req-run-findings',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handlePatchFinding returns error when finding not found', async () => {
    const req = mockReq({
      headers: { 'x-request-id': 'req-patch-missing' },
      params: { id: 'finding-missing' },
    });
    const res = mockRes();

    mockParseBody.mockResolvedValue({ verified: true });
    mockAuditStore.updateFinding.mockReturnValue(0);

    await handlers.handlePatchFinding(req, res);

    expect(mockAuditStore.updateFinding).toHaveBeenCalledWith('finding-missing', { verified: true });
    expect(res.statusCode).toBe(404);
    expect(parseResponse(res)).toEqual({
      error: {
        code: 'not_found',
        message: 'Finding not found: finding-missing',
        details: {},
        request_id: 'req-patch-missing',
      },
      meta: {
        request_id: 'req-patch-missing',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handlePatchFinding updates finding successfully', async () => {
    const req = mockReq({
      headers: { 'x-request-id': 'req-patch-ok' },
      params: { id: 'finding-7' },
    });
    const res = mockRes();

    mockParseBody.mockResolvedValue({ verified: false, false_positive: true });
    mockAuditStore.updateFinding.mockReturnValue(1);

    await handlers.handlePatchFinding(req, res);

    expect(mockAuditStore.updateFinding).toHaveBeenCalledWith('finding-7', {
      verified: false,
      false_positive: true,
    });
    expect(res.statusCode).toBe(200);
    expect(parseResponse(res)).toEqual({
      data: {
        finding_id: 'finding-7',
        verified: false,
        false_positive: true,
      },
      meta: {
        request_id: 'req-patch-ok',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handleGetRunSummary returns summary', async () => {
    const req = mockReq({
      headers: { 'x-request-id': 'req-summary-ok' },
      params: { id: 'run-77' },
    });
    const res = mockRes();
    const summary = {
      run_id: 'run-77',
      status: 'completed',
      total_findings: 4,
      by_severity: { high: 1, medium: 3 },
    };

    mockAuditStore.getAuditSummary.mockReturnValue(summary);

    await handlers.handleGetRunSummary(req, res);

    expect(mockAuditStore.getAuditSummary).toHaveBeenCalledWith('run-77');
    expect(res.statusCode).toBe(200);
    expect(parseResponse(res)).toEqual({
      data: summary,
      meta: {
        request_id: 'req-summary-ok',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handleGetRunSummary returns 404 when run not found', async () => {
    const req = mockReq({
      headers: { 'x-request-id': 'req-summary-missing' },
      params: { id: 'run-missing' },
    });
    const res = mockRes();

    mockAuditStore.getAuditSummary.mockReturnValue(null);

    await handlers.handleGetRunSummary(req, res);

    expect(res.statusCode).toBe(404);
    expect(parseResponse(res)).toEqual({
      error: {
        code: 'not_found',
        message: 'Audit run not found: run-missing',
        details: {},
        request_id: 'req-summary-missing',
      },
      meta: {
        request_id: 'req-summary-missing',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });

  it('handleGetAllFindings returns findings with global filters', async () => {
    const req = mockReq({
      headers: { 'x-request-id': 'req-all-findings' },
      query: {
        audit_run_id: 'run-global',
        category: 'performance',
        severity: 'medium',
        confidence: 'high',
        file_path: 'server/index.js',
        verified: 'true',
        false_positive: 'false',
        limit: '3',
        offset: '6',
      },
    });
    const res = mockRes();
    const findings = [
      { id: 'finding-global-1', title: 'N+1 query' },
    ];

    mockAuditStore.getFindings.mockReturnValue(findings);

    await handlers.handleGetAllFindings(req, res);

    expect(mockAuditStore.getFindings).toHaveBeenCalledWith({
      audit_run_id: 'run-global',
      category: 'performance',
      severity: 'medium',
      confidence: 'high',
      file_path: 'server/index.js',
      verified: true,
      false_positive: false,
      limit: 3,
      offset: 6,
    });
    expect(res.statusCode).toBe(200);
    expect(parseResponse(res)).toEqual({
      data: { findings },
      meta: {
        request_id: 'req-all-findings',
        timestamp: FIXED_TIMESTAMP,
      },
    });
  });
});
