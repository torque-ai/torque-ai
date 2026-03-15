'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { createRequire } = require('module');

const { setupTestDb, teardownTestDb } = require('./vitest-setup');

function loadCompliance(injectedModules = {}) {
  const resolvedPath = path.resolve(__dirname, '../handlers/peek/compliance.js');
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const requireFromModule = createRequire(resolvedPath);
  const exportedModule = { exports: {} };
  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    source,
  );

  const customRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(injectedModules, request)) {
      return injectedModules[request];
    }
    return requireFromModule(request);
  };

  compiled(customRequire, exportedModule, exportedModule.exports, resolvedPath, path.dirname(resolvedPath));
  return exportedModule.exports;
}

function createLoggerMock() {
  const instance = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    instance,
    module: {
      child: vi.fn(() => instance),
    },
  };
}

function createMockResponse() {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const listeners = {};
  const responseHeaders = {};
  const writtenChunks = [];

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    on: vi.fn((event, callback) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    }),
    emit: vi.fn((event, ...args) => {
      for (const callback of listeners[event] || []) {
        callback(...args);
      }
    }),
    setHeader: vi.fn((name, value) => {
      responseHeaders[name.toLowerCase()] = value;
    }),
    getHeader: vi.fn((name) => responseHeaders[name.toLowerCase()]),
    write: vi.fn((chunk) => {
      writtenChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      response.body = writtenChunks.join('');
    }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      if (body) {
        writtenChunks.push(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
      }
      response.body = writtenChunks.join('');
      for (const callback of listeners.finish || []) {
        callback();
      }
      resolveDone();
    }),
  };

  return { response, done };
}

function parseJsonBody(response) {
  return response.body ? JSON.parse(response.body) : null;
}

async function dispatchRequest(handler, { method, url, headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress };
  req.connection = { remoteAddress };

  const { response, done } = createMockResponse();
  const handlerPromise = handler(req, response);

  process.nextTick(() => {
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', payload);
    }
    req.emit('end');
  });

  await handlerPromise;
  await done;
  return response;
}

describe('peek attestation export', () => {
  let compliance;

  beforeEach(() => {
    const loggerMock = createLoggerMock();
    compliance = loadCompliance({
      '../../database': {},
      '../../logger': loggerMock.module,
      './webhook-outbound': {
        fireWebhookForEvent: vi.fn(() => Promise.resolve()),
      },
      './rollback': {
        classifyActionRisk: vi.fn(() => ({ level: 'unknown' })),
      },
    });
  });

  it('exportAttestation returns the expected standalone attestation structure', () => {
    const reportData = {
      report_id: 'report-123',
      generated_at: '2026-02-20T12:00:00.000Z',
      period: {
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-28T23:59:59.999Z',
      },
      chain_integrity: {
        verified: true,
        valid: true,
        entries_checked: 6,
        gaps: [],
        broken_at: null,
      },
      policy_summary: {
        total_evaluations: 5,
        allow: 4,
        deny: 1,
        warn: 0,
      },
      attestation_block: {
        policy_coverage_percent: 80,
      },
      risk_audit_trail: [
        { id: 'risk-low', risk_level: 'low' },
        { id: 'risk-medium', risk_level: 'medium' },
        { id: 'risk-high', risk_level: 'high' },
        { id: 'risk-unknown-a', risk_level: 'unknown' },
        { id: 'risk-unknown-b' },
      ],
    };

    const attestation = compliance.exportAttestation(reportData);
    const expectedHash = crypto.createHash('sha256')
      .update(JSON.stringify({
        ...reportData,
        attestation_block: {
          ...reportData.attestation_block,
          report_id: 'report-123',
        },
      }))
      .digest('hex');

    expect(attestation).toEqual({
      report_id: 'report-123',
      report_hash: expectedHash,
      chain_integrity: {
        verified: true,
        valid: true,
        entries_checked: 6,
        gaps: [],
        broken_at: null,
      },
      policy_coverage_percent: 80,
      risk_counts: {
        total: 5,
        low: 1,
        medium: 1,
        high: 1,
        unknown: 2,
      },
      review_workflow: {
        reviewer: null,
        reviewed_at: null,
        approved: null,
      },
    });
  });

  it('includes review workflow fields with null defaults', () => {
    const attestation = compliance.exportAttestation({
      report_id: 'report-empty',
      risk_audit_trail: [],
    });

    expect(attestation.chain_integrity).toEqual({
      verified: false,
      valid: false,
      entries_checked: 0,
      gaps: [],
      broken_at: null,
    });
    expect(attestation.policy_coverage_percent).toBe(0);
    expect(attestation.risk_counts).toEqual({
      total: 0,
      low: 0,
      medium: 0,
      high: 0,
      unknown: 0,
    });
    expect(attestation.review_workflow).toEqual({
      reviewer: null,
      reviewed_at: null,
      approved: null,
    });
  });

  it('throws when report data is missing', () => {
    expect(() => compliance.exportAttestation()).toThrow('Valid report data with report_id is required');
  });

  it('throws when report_id is missing', () => {
    expect(() => compliance.exportAttestation({
      chain_integrity: { valid: true, entries_checked: 1, broken_at: null },
    })).toThrow('Valid report data with report_id is required');
  });
});

describe('peek attestation export api', () => {
  let api;
  let db;
  let requestHandler;
  let createServerSpy;

  beforeAll(async () => {
    ({ db } = setupTestDb('peek-attestation-export'));
    api = require('../api-server.core');

    const mockServer = {
      on: vi.fn(),
      listen: vi.fn((_port, _host, callback) => {
        if (callback) callback();
      }),
      close: vi.fn(),
    };

    createServerSpy = vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    const startResult = await api.start({ port: 4323 });
    expect(startResult.success).toBe(true);
  });

  beforeEach(() => {
    db.setConfig('api_key', '');
    db.setConfig('api_rate_limit', '');
    db.setConfig('v2_auth_mode', 'permissive');
    db.setConfig('v2_rate_policy', 'enforced');
    db.setConfig('v2_rate_limit', '120');
  });

  afterAll(() => {
    api.stop();
    api.stopRateLimitCleanup();
    createServerSpy.mockRestore();
    teardownTestDb();
  });

  it('returns 200 with a valid attestation payload', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/peek/attestations/report-123?since=2026-02-01T00:00:00.000Z&until=2026-02-01T23:59:59.999Z',
    });

    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual(expect.objectContaining({
      report_id: 'report-123',
      report_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      chain_integrity: expect.any(Object),
      policy_coverage_percent: expect.any(Number),
      risk_counts: expect.any(Object),
      review_workflow: {
        reviewer: null,
        reviewed_at: null,
        approved: null,
      },
    }));
  });
});
