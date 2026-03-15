'use strict';

const HANDLER_MODULE = '../api/v2-governance-handlers';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../api/v2-control-plane',
  '../api/middleware',
  '../database',
  '../handlers/policy-handlers',
  '../tools',
];

const FIXED_TIMESTAMP = '2026-03-10T12:34:56.789Z';
const REQUEST_ID = 'req-config-123';
const UNKNOWN_KEY = 'not_a_real_config_key';
const { VALID_CONFIG_KEYS } = require('../db/config-keys');

const READ_KEY = VALID_CONFIG_KEYS.has('default_provider')
  ? 'default_provider'
  : VALID_CONFIG_KEYS.values().next().value;
const WRITE_KEY = VALID_CONFIG_KEYS.has('max_concurrent')
  ? 'max_concurrent'
  : READ_KEY;

let currentModules = {};

vi.mock('../database', () => currentModules.db);
vi.mock('../api/middleware', () => currentModules.middleware);
vi.mock('../api/v2-control-plane', () => currentModules.controlPlane);
vi.mock('../handlers/policy-handlers', () => currentModules.policyHandlers);
vi.mock('../tools', () => currentModules.tools);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that were not loaded.
    }
  }
}

function createEnvelopeMeta(requestId = REQUEST_ID) {
  return {
    request_id: requestId,
    timestamp: FIXED_TIMESTAMP,
  };
}

function createDefaultModules() {
  const sendSuccess = vi.fn((res, requestId, data, status = 200, req = null) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req?.requestId) {
      headers['X-Request-ID'] = req.requestId;
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify({
      data,
      meta: createEnvelopeMeta(requestId),
    }));
  });

  const sendError = vi.fn((res, requestId, code, message, status = 400, details = {}, req = null) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req?.requestId) {
      headers['X-Request-ID'] = req.requestId;
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify({
      error: {
        code,
        message,
        details,
        request_id: requestId,
      },
      meta: createEnvelopeMeta(requestId),
    }));
  });

  return {
    db: {
      getAllConfig: vi.fn().mockReturnValue({}),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
    },
    controlPlane: {
      sendSuccess,
      sendError,
      sendList: vi.fn(),
      resolveRequestId: vi.fn().mockReturnValue(REQUEST_ID),
    },
    middleware: {
      parseBody: vi.fn(async (req) => req?._parsedBody ?? req?.body ?? {}),
      sendJson: vi.fn(),
    },
    policyHandlers: {
      isCoreError: vi.fn((result) => Boolean(result?.error?.code)),
      listPoliciesCore: vi.fn().mockReturnValue({ policies: [] }),
      getPolicyCore: vi.fn().mockReturnValue({ policy: null }),
      setPolicyModeCore: vi.fn().mockReturnValue({ success: true }),
      evaluatePoliciesCore: vi.fn().mockReturnValue({ results: [] }),
      listPolicyEvaluationsCore: vi.fn().mockReturnValue({ evaluations: [] }),
      getPolicyEvaluationCore: vi.fn().mockReturnValue({ evaluation: null }),
      overridePolicyDecisionCore: vi.fn().mockReturnValue({ override_id: 'override-1' }),
    },
    tools: {
      handleToolCall: vi.fn().mockResolvedValue({ success: true }),
    },
    taskManager: {
      cancelTask: vi.fn(),
    },
  };
}

function loadHandlers() {
  currentModules = createDefaultModules();

  vi.resetModules();
  clearLoadedModules();

  installCjsModuleMock('../database', currentModules.db);
  installCjsModuleMock('../api/middleware', currentModules.middleware);
  installCjsModuleMock('../api/v2-control-plane', currentModules.controlPlane);
  installCjsModuleMock('../handlers/policy-handlers', currentModules.policyHandlers);
  installCjsModuleMock('../tools', currentModules.tools);

  return {
    handlers: require(HANDLER_MODULE),
    mocks: currentModules,
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
    },
    end(body) {
      this._body = typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
}

function createMockContext(overrides = {}) {
  const { parsedBody, ...reqOverrides } = overrides;
  const req = {
    method: 'GET',
    params: {},
    query: {},
    body: undefined,
    headers: {},
    requestId: 'req-original',
    ...reqOverrides,
  };

  if (parsedBody !== undefined) {
    req._parsedBody = parsedBody;
  }

  return {
    req,
    res: createMockRes(),
  };
}

function expectMeta(body, requestId = REQUEST_ID) {
  expect(body.meta).toEqual(createEnvelopeMeta(requestId));
}

function expectSuccessEnvelope(res, data, options = {}) {
  const {
    requestId = REQUEST_ID,
    status = 200,
  } = options;

  expect(res.statusCode).toBe(status);
  expect(res._body.data).toEqual(data);
  expectMeta(res._body, requestId);
}

function expectErrorEnvelope(res, {
  code,
  message,
  status = 400,
  details = {},
  requestId = REQUEST_ID,
}) {
  expect(res.statusCode).toBe(status);
  expect(res._body.error).toEqual({
    code,
    message,
    details,
    request_id: requestId,
  });
  expectMeta(res._body, requestId);
}

describe('api/v2-governance-handlers config API', () => {
  let handlers;
  let mocks;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TIMESTAMP));

    const loaded = loadHandlers();
    handlers = loaded.handlers;
    mocks = loaded.mocks;
    handlers.init(mocks.taskManager);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    currentModules = {};
    clearLoadedModules();
    vi.resetModules();
  });

  describe('handleGetConfig', () => {
    it('returns all config in a data envelope', async () => {
      const config = {
        [READ_KEY]: 'openai',
        [WRITE_KEY]: '8',
      };
      const { req, res } = createMockContext();
      mocks.db.getAllConfig.mockReturnValue(config);

      await handlers.handleGetConfig(req, res);

      expect(mocks.controlPlane.resolveRequestId).toHaveBeenCalledWith(req);
      expect(mocks.db.getAllConfig).toHaveBeenCalledOnce();
      expect(mocks.db.getConfig).not.toHaveBeenCalled();
      expect(mocks.controlPlane.sendSuccess).toHaveBeenCalledWith(res, REQUEST_ID, config, 200, req);
      expectSuccessEnvelope(res, config);
    });

    it('returns a single valid config key with its value', async () => {
      const { req, res } = createMockContext({
        params: { key: READ_KEY },
      });
      mocks.db.getConfig.mockReturnValue('anthropic');

      await handlers.handleGetConfig(req, res);

      expect(mocks.controlPlane.resolveRequestId).toHaveBeenCalledWith(req);
      expect(mocks.db.getConfig).toHaveBeenCalledWith(READ_KEY);
      expect(mocks.db.getAllConfig).not.toHaveBeenCalled();
      expect(mocks.controlPlane.sendSuccess).toHaveBeenCalledWith(
        res,
        REQUEST_ID,
        { key: READ_KEY, value: 'anthropic' },
        200,
        req
      );
      expectSuccessEnvelope(res, { key: READ_KEY, value: 'anthropic' });
    });

    it('returns validation_error for an unknown config key', async () => {
      const { req, res } = createMockContext({
        params: { key: UNKNOWN_KEY },
      });

      await handlers.handleGetConfig(req, res);

      expect(mocks.controlPlane.resolveRequestId).toHaveBeenCalledWith(req);
      expect(mocks.db.getConfig).not.toHaveBeenCalled();
      expect(mocks.db.getAllConfig).not.toHaveBeenCalled();
      expect(mocks.controlPlane.sendError).toHaveBeenCalledWith(
        res,
        REQUEST_ID,
        'validation_error',
        `Unknown config key: ${UNKNOWN_KEY}`,
        400,
        {},
        req
      );
      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: `Unknown config key: ${UNKNOWN_KEY}`,
      });
    });
  });

  describe('handleSetConfig', () => {
    it('sets a valid key from a PUT route param and returns the current value', async () => {
      const { req, res } = createMockContext({
        method: 'PUT',
        params: { key: WRITE_KEY },
        body: { value: 8 },
      });
      mocks.db.getConfig.mockReturnValue('8');

      await handlers.handleSetConfig(req, res);

      expect(mocks.controlPlane.resolveRequestId).toHaveBeenCalledWith(req);
      expect(mocks.middleware.parseBody).not.toHaveBeenCalled();
      expect(mocks.db.setConfig).toHaveBeenCalledWith(WRITE_KEY, '8');
      expect(mocks.db.getConfig).toHaveBeenCalledWith(WRITE_KEY);
      expect(mocks.controlPlane.sendSuccess).toHaveBeenCalledWith(
        res,
        REQUEST_ID,
        { key: WRITE_KEY, value: '8' },
        200,
        req
      );
      expectSuccessEnvelope(res, { key: WRITE_KEY, value: '8' });
    });

    it('sets a key from a POST body and returns the stored value', async () => {
      const { req, res } = createMockContext({
        method: 'POST',
        parsedBody: {
          key: READ_KEY,
          value: 'openrouter',
        },
      });
      mocks.db.getConfig.mockReturnValue('openrouter');

      await handlers.handleSetConfig(req, res);

      expect(mocks.controlPlane.resolveRequestId).toHaveBeenCalledWith(req);
      expect(mocks.middleware.parseBody).toHaveBeenCalledWith(req);
      expect(mocks.db.setConfig).toHaveBeenCalledWith(READ_KEY, 'openrouter');
      expect(mocks.db.getConfig).toHaveBeenCalledWith(READ_KEY);
      expect(mocks.controlPlane.sendSuccess).toHaveBeenCalledWith(
        res,
        REQUEST_ID,
        { key: READ_KEY, value: 'openrouter' },
        200,
        req
      );
      expectSuccessEnvelope(res, { key: READ_KEY, value: 'openrouter' });
    });

    it('returns 400 when a PUT request omits value', async () => {
      const { req, res } = createMockContext({
        method: 'PUT',
        params: { key: WRITE_KEY },
        parsedBody: {},
      });

      await handlers.handleSetConfig(req, res);

      expect(mocks.middleware.parseBody).toHaveBeenCalledWith(req);
      expect(mocks.db.setConfig).not.toHaveBeenCalled();
      expect(mocks.db.getConfig).not.toHaveBeenCalled();
      expect(mocks.controlPlane.sendError).toHaveBeenCalledWith(
        res,
        REQUEST_ID,
        'validation_error',
        'value is required',
        400,
        {},
        req
      );
      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'value is required',
      });
    });

    it('returns validation_error when PUT uses an unknown key', async () => {
      const { req, res } = createMockContext({
        method: 'PUT',
        params: { key: UNKNOWN_KEY },
        body: { value: 'x' },
      });

      await handlers.handleSetConfig(req, res);

      expect(mocks.middleware.parseBody).not.toHaveBeenCalled();
      expect(mocks.db.setConfig).not.toHaveBeenCalled();
      expect(mocks.db.getConfig).not.toHaveBeenCalled();
      expect(mocks.controlPlane.sendError).toHaveBeenCalledWith(
        res,
        REQUEST_ID,
        'validation_error',
        `Unknown config key: ${UNKNOWN_KEY}. Use GET /api/v2/config for valid keys.`,
        400,
        {},
        req
      );
      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: `Unknown config key: ${UNKNOWN_KEY}. Use GET /api/v2/config for valid keys.`,
      });
    });

    it('returns 400 when the provided key is empty', async () => {
      const { req, res } = createMockContext({
        method: 'PUT',
        parsedBody: {
          key: '   ',
          value: 'anything',
        },
      });

      await handlers.handleSetConfig(req, res);

      expect(mocks.middleware.parseBody).toHaveBeenCalledWith(req);
      expect(mocks.db.setConfig).not.toHaveBeenCalled();
      expect(mocks.db.getConfig).not.toHaveBeenCalled();
      expect(mocks.controlPlane.sendError).toHaveBeenCalledWith(
        res,
        REQUEST_ID,
        'validation_error',
        'key is required',
        400,
        {},
        req
      );
      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'key is required',
      });
    });
  });
});
