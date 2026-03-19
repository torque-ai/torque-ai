'use strict';

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module was not loaded in this test.
  }
}

function clearModules(modulePaths) {
  for (const modulePath of modulePaths) {
    clearCjsModule(modulePath);
  }
}

function createHandlerModuleMock() {
  const stubHandler = vi.fn();
  return new Proxy({ init: vi.fn() }, {
    get(target, prop) {
      if (prop in target) {
        return target[prop];
      }
      return stubHandler;
    },
  });
}

function createMockResponse() {
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead: vi.fn((statusCode, headers) => {
      response.statusCode = statusCode;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      response.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    }),
  };

  return response;
}

function parseJsonBody(response) {
  return response.body ? JSON.parse(response.body) : null;
}

const MODULES_TO_CLEAR = [
  '../database',
  '../api/routes',
  '../api/v2-dispatch',
  '../api/v2-schemas',
  '../api/v2-middleware',
  '../api/v2-task-handlers',
  '../api/v2-workflow-handlers',
  '../api/v2-governance-handlers',
  '../api/v2-analytics-handlers',
  '../api/v2-infrastructure-handlers',
  '../handlers/remote-agent-handlers',
];

function loadModules() {
  clearModules(MODULES_TO_CLEAR);

  installCjsModuleMock('../database', {
    getDefaultProvider: vi.fn(() => null),
    onClose: () => {},
  });
  installCjsModuleMock('../api/v2-schemas', {
    validateInferenceRequest: vi.fn(() => ({ valid: true, errors: [], value: {} })),
  });
  installCjsModuleMock('../api/v2-middleware', {
    normalizeError: vi.fn((err) => ({
      status: 500,
      body: { error: err?.message || String(err) },
    })),
    requestId: vi.fn((_req, _res, next) => next()),
    validateRequest: vi.fn(() => vi.fn((_req, _res, next) => next())),
  });
  installCjsModuleMock('../api/v2-task-handlers', createHandlerModuleMock());
  installCjsModuleMock('../api/v2-workflow-handlers', createHandlerModuleMock());
  installCjsModuleMock('../api/v2-governance-handlers', createHandlerModuleMock());
  installCjsModuleMock('../api/v2-analytics-handlers', createHandlerModuleMock());
  installCjsModuleMock('../api/v2-infrastructure-handlers', createHandlerModuleMock());

  return {
    routes: require('../api/routes'),
    ...require('../api/v2-dispatch'),
    remoteAgentHandlers: require('../handlers/remote-agent-handlers'),
  };
}

describe('remote command REST control-plane wiring', () => {
  let routes;
  let V2_CP_HANDLER_LOOKUP;
  let remoteAgentHandlers;

  beforeEach(() => {
    ({
      routes,
      V2_CP_HANDLER_LOOKUP,
      remoteAgentHandlers,
    } = loadModules());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearModules(MODULES_TO_CLEAR);
  });

  it('defines POST control-plane routes for remote run and remote test', () => {
    expect(routes).toContainEqual(expect.objectContaining({
      method: 'POST',
      path: '/api/v2/remote/run',
      handlerName: 'handleV2CpRunRemoteCommand',
    }));
    expect(routes).toContainEqual(expect.objectContaining({
      method: 'POST',
      path: '/api/v2/remote/test',
      handlerName: 'handleV2CpRunTests',
    }));
  });

  it('maps both control-plane handlers into V2_CP_HANDLER_LOOKUP', () => {
    expect(V2_CP_HANDLER_LOOKUP.handleV2CpRunRemoteCommand).toBe(remoteAgentHandlers.handleRunRemoteCommand);
    expect(V2_CP_HANDLER_LOOKUP.handleV2CpRunTests).toBe(remoteAgentHandlers.handleRunTests);
  });

  it('handleV2CpRunRemoteCommand is callable as an HTTP handler', async () => {
    const response = createMockResponse();
    const runRemoteCommandCoreSpy = vi.spyOn(remoteAgentHandlers, 'runRemoteCommandCore').mockResolvedValue({
      success: true,
      output: 'remote-ok',
      exitCode: 0,
      durationMs: 12,
      remote: true,
    });

    await V2_CP_HANDLER_LOOKUP.handleV2CpRunRemoteCommand({
      method: 'POST',
      body: {
        command: 'npm test',
        working_directory: '/repo',
      },
    }, response, {});

    expect(runRemoteCommandCoreSpy).toHaveBeenCalledWith({
      command: 'npm test',
      working_directory: '/repo',
    });
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual({
      success: true,
      output: 'remote-ok',
      exitCode: 0,
      durationMs: 12,
      remote: true,
      warning: null,
    });
  });

  it('handleV2CpRunTests is callable as an HTTP handler', async () => {
    const response = createMockResponse();
    const runTestsCoreSpy = vi.spyOn(remoteAgentHandlers, 'runTestsCore').mockResolvedValue({
      success: true,
      output: 'verify-ok',
      exitCode: 0,
      durationMs: 18,
      remote: true,
    });

    await V2_CP_HANDLER_LOOKUP.handleV2CpRunTests({
      method: 'POST',
      body: {
        working_directory: '/repo',
      },
    }, response, {});

    expect(runTestsCoreSpy).toHaveBeenCalledWith({
      working_directory: '/repo',
    });
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual({
      success: true,
      output: 'verify-ok',
      exitCode: 0,
      durationMs: 18,
      remote: true,
      warning: null,
    });
  });
});
