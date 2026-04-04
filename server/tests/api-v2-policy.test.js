import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { EventEmitter } = require('events');
const http = require('http');
const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');

let api;
let db;
let requestHandler;
let createServerSpy;

function createMockResponse() {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const listeners = {};
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
    setHeader: vi.fn(),
    getHeader: vi.fn(),
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

function seedProfile({
  id = 'policy-profile-1',
  project = null,
  defaults = { mode: 'advisory' },
  enabled = true,
} = {}) {
  return db.savePolicyProfile({
    id,
    name: `Profile ${id}`,
    project,
    defaults,
    project_match: {},
    policy_overrides: {},
    enabled,
  });
}

function seedRule({
  id,
  name = id,
  category = 'change_safety',
  stage = 'task_complete',
  mode = 'advisory',
  priority = 100,
  matcher = {},
  required_evidence = [],
  actions = [{ type: 'emit_violation', severity: 'warning' }],
  override_policy = { allowed: true, reason_codes: ['approved_exception'] },
  tags = ['policy'],
  enabled = true,
} = {}) {
  return db.savePolicyRule({
    id,
    name,
    category,
    stage,
    mode,
    priority,
    matcher,
    required_evidence,
    actions,
    override_policy,
    tags,
    enabled,
  });
}

function seedBinding({
  id,
  profile_id,
  policy_id,
  mode_override = null,
  binding_json = {},
  enabled = true,
} = {}) {
  return db.savePolicyBinding({
    id,
    profile_id,
    policy_id,
    mode_override,
    binding_json,
    enabled,
  });
}

function seedEvaluation(overrides = {}) {
  const policyId = overrides.policy_id || 'policy-eval';
  const profileId = overrides.profile_id || 'policy-profile-1';

  if (!db.getPolicyProfile(profileId)) {
    seedProfile({ id: profileId });
  }
  if (!db.getPolicyRule(policyId)) {
    seedRule({ id: policyId });
  }

  return db.createPolicyEvaluation({
    id: overrides.id || `eval-${Math.random().toString(16).slice(2)}`,
    policy_id: policyId,
    profile_id: profileId,
    stage: overrides.stage || 'task_complete',
    target_type: overrides.target_type || 'task',
    target_id: overrides.target_id || 'task-1',
    project: overrides.project || 'Torque',
    mode: overrides.mode || 'warn',
    outcome: overrides.outcome || 'fail',
    severity: overrides.severity || 'warning',
    message: overrides.message || 'approval missing',
    evidence: overrides.evidence || { requirements: [] },
    evaluation: overrides.evaluation || {
      override_policy: { allowed: true, reason_codes: ['approved_exception'] },
    },
    override_allowed: overrides.override_allowed ?? true,
    suppressed: overrides.suppressed ?? false,
    suppression_reason: overrides.suppression_reason || null,
    created_at: overrides.created_at || '2026-03-10T00:00:00.000Z',
  });
}

beforeAll(async () => {
  ({ db } = setupTestDbOnly('api-v2-policy'));
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

  const startResult = await api.start({ port: 4322 });
  expect(startResult.success).toBe(true);
  expect(typeof requestHandler).toBe('function');
});

beforeEach(() => {
  resetTables([
    'policy_overrides',
    'policy_evaluations',
    'policy_bindings',
    'policy_rules',
    'policy_profiles',
    'project_metadata',
  ]);
  db.setConfig('api_key', '');
  db.setConfig('v2_auth_mode', 'permissive');
  db.setConfig('v2_rate_policy', 'enforced');
  db.setConfig('v2_rate_limit', '120');
});

afterEach(() => {
  api.stopRateLimitCleanup();
});

afterAll(() => {
  api.stop();
  createServerSpy.mockRestore();
  teardownTestDb();
});

describe('api v2 policy routes', () => {
  it('GET /api/v2/policies returns array', async () => {
    seedProfile({ id: 'profile-list' });
    db.setProjectMetadata('Torque', 'policy_profile_id', 'profile-list');

    seedRule({
      id: 'policy-blocked',
      category: 'change_safety',
      stage: 'task_complete',
      mode: 'warn',
    });
    seedRule({
      id: 'policy-other',
      category: 'privacy_security',
      stage: 'task_complete',
      mode: 'advisory',
    });

    seedBinding({
      id: 'binding-blocked',
      profile_id: 'profile-list',
      policy_id: 'policy-blocked',
      mode_override: 'block',
    });
    seedBinding({
      id: 'binding-other',
      profile_id: 'profile-list',
      policy_id: 'policy-other',
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/policies?project_id=Torque&category=change_safety&stage=task_complete&mode=block',
    });

    expect(response.statusCode).toBe(200);
    const payload = parseJsonBody(response);
    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({
      id: 'policy-blocked',
      policy_id: 'policy-blocked',
      profile_id: 'profile-list',
      category: 'change_safety',
      stage: 'task_complete',
      mode: 'block',
    });
    expect(payload.meta).toEqual({
      request_id: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('GET /api/v2/policies/:id returns 404 for unknown', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/policies/missing-policy',
    });

    expect(response.statusCode).toBe(404);
    expect(parseJsonBody(response)).toEqual({
      error: {
        code: 'policy_not_found',
        message: 'Policy not found: missing-policy',
        details: {},
        request_id: expect.any(String),
      },
      meta: {
        request_id: expect.any(String),
        timestamp: expect.any(String),
      },
    });
  });

  it('POST /api/v2/policies/:id/mode validates mode enum', async () => {
    seedRule({ id: 'policy-mode-check', mode: 'advisory' });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/policies/policy-mode-check/mode',
      headers: { 'content-type': 'application/json' },
      body: {
        mode: 'invalid-mode',
        reason: 'Testing validation',
      },
    });

    expect(response.statusCode).toBe(400);
    const payload = parseJsonBody(response);
    expect(payload.error.code).toBe('policy_mode_invalid');
    expect(payload.error.message).toContain('mode must be one of: off, shadow, advisory, warn, block');
    expect(db.getPolicyRule('policy-mode-check').mode).toBe('advisory');
  });

  it('POST /api/v2/policies/evaluate returns evaluation result', async () => {
    seedProfile({ id: 'profile-evaluate' });
    db.setProjectMetadata('Torque', 'policy_profile_id', 'profile-evaluate');

    seedRule({
      id: 'policy-evaluate',
      category: 'change_safety',
      stage: 'task_complete',
      mode: 'warn',
    });
    seedBinding({
      id: 'binding-evaluate',
      profile_id: 'profile-evaluate',
      policy_id: 'policy-evaluate',
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/policies/evaluate',
      headers: { 'content-type': 'application/json' },
      body: {
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-123',
        project_id: 'Torque',
        changed_files: ['server/api-server.core.js'],
        provider: 'codex',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = parseJsonBody(response);
    expect(payload.data).toMatchObject({
      stage: 'task_complete',
      target: { type: 'task', id: 'task-123' },
      profile_id: 'profile-evaluate',
      total_results: 1,
    });
    expect(payload.data.results).toHaveLength(1);
    expect(payload.data.results[0]).toMatchObject({
      policy_id: 'policy-evaluate',
    });
  });

  it('GET /api/v2/policy-evaluations supports limit/offset', async () => {
    seedEvaluation({
      id: 'eval-newest',
      created_at: '2026-03-10T00:01:00.000Z',
      target_id: 'task-newest',
    });
    seedEvaluation({
      id: 'eval-older',
      created_at: '2026-03-10T00:00:00.000Z',
      target_id: 'task-older',
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/policy-evaluations?limit=1&offset=1',
    });

    expect(response.statusCode).toBe(200);
    const payload = parseJsonBody(response);
    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({
      id: 'eval-older',
      target_id: 'task-older',
    });
  });

  it('POST override returns 400 when not allowed', async () => {
    const evaluation = seedEvaluation({
      id: 'eval-no-override',
      override_allowed: false,
      evaluation: {
        override_policy: { allowed: false },
      },
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: `/api/v2/policy-evaluations/${encodeURIComponent(evaluation.id)}/override`,
      headers: { 'content-type': 'application/json' },
      body: {
        decision: 'override',
        reason_code: 'approved_exception',
        notes: 'Not allowed here',
      },
    });

    expect(response.statusCode).toBe(400);
    const payload = parseJsonBody(response);
    expect(payload.error.code).toBe('override_not_allowed');
    expect(payload.error.message).toContain('does not allow overrides');
  });

  it('response envelopes have correct shape', async () => {
    seedRule({ id: 'policy-envelope' });

    const successResponse = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/policies',
    });
    const errorResponse = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/policies/missing-envelope-policy',
    });

    const successPayload = parseJsonBody(successResponse);
    const errorPayload = parseJsonBody(errorResponse);

    expect(successPayload).toEqual({
      data: expect.any(Array),
      meta: {
        request_id: expect.any(String),
        timestamp: expect.any(String),
      },
    });
    expect(new Date(successPayload.meta.timestamp).toISOString()).toBe(successPayload.meta.timestamp);

    expect(errorPayload).toEqual({
      error: {
        code: expect.any(String),
        message: expect.any(String),
        details: expect.any(Object),
        request_id: expect.any(String),
      },
      meta: {
        request_id: expect.any(String),
        timestamp: expect.any(String),
      },
    });
    expect(errorPayload.meta.request_id).toBe(errorPayload.error.request_id);
  });
});
