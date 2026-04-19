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
  '../../../database',
  '../../../api/routes',
  '../../../api/v2-schemas',
  '../../../api/v2-middleware',
  '../../../logger',
  '../../../validation/post-task',
  '../remote-test-routing',
  '../handlers',
];

function loadModules({
  agentRegistry = null,
  project = 'torque-server',
  projectConfig = {
    verify_command: 'npm test && npm run lint',
  },
  parseCommandResult = {
    executable: 'npm',
    args: ['test'],
  },
  runRemoteOrLocalResult = {
    success: true,
    output: 'remote-ok',
    error: '',
    exitCode: 0,
    durationMs: 12,
    remote: true,
  },
  runVerifyCommandResult = {
    success: true,
    output: 'verify-ok',
    error: '',
    exitCode: 0,
    durationMs: 18,
    remote: false,
  },
} = {}) {
  clearModules(MODULES_TO_CLEAR);

  const loggerInstance = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const child = vi.fn(() => loggerInstance);
  const parseCommand = vi.fn(() => parseCommandResult);
  const runRemoteOrLocal = vi.fn().mockResolvedValue(runRemoteOrLocalResult);
  const runVerifyCommand = vi.fn().mockResolvedValue(runVerifyCommandResult);
  const createRemoteTestRouter = vi.fn(() => ({
    runRemoteOrLocal,
    runVerifyCommand,
  }));
  const db = {
    getProjectFromPath: vi.fn().mockReturnValue(project),
    getProjectConfig: vi.fn().mockReturnValue(projectConfig),
  };

  installCjsModuleMock('../../../database', {
    getDefaultProvider: vi.fn(() => null),
    onClose: () => {},
  });
  installCjsModuleMock('../../../api/v2-schemas', {
    validateInferenceRequest: vi.fn(() => ({ valid: true, errors: [], value: {} })),
  });
  installCjsModuleMock('../../../api/v2-middleware', {
    normalizeError: vi.fn((err) => ({
      status: 500,
      body: { error: err?.message || String(err) },
    })),
    requestId: vi.fn((_req, _res, next) => next()),
    validateRequest: vi.fn(() => vi.fn((_req, _res, next) => next())),
  });
  installCjsModuleMock('../../../logger', {
    child,
  });
  installCjsModuleMock('../../../validation/post-task', {
    parseCommand,
  });
  installCjsModuleMock('../remote-test-routing', {
    createRemoteTestRouter,
  });

  const routes = require('../../../api/routes');
  const { createHandlers } = require('../handlers');
  const handlers = createHandlers({ agentRegistry, db });

  return {
    routes,
    handlers,
    db,
    parseCommand,
    runRemoteOrLocal,
    runVerifyCommand,
    createRemoteTestRouter,
    loggerInstance,
  };
}

describe('remote command REST handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearModules(MODULES_TO_CLEAR);
  });

  it('does not define core control-plane routes for remote run and remote test', () => {
    const { routes } = loadModules();

    expect(routes).not.toContainEqual(expect.objectContaining({
      path: '/api/v2/remote/run',
    }));
    expect(routes).not.toContainEqual(expect.objectContaining({
      path: '/api/v2/remote/test',
    }));
  });

  it('creates HTTP-callable handlers for remote run and remote test', () => {
    const { handlers } = loadModules();

    expect(typeof handlers.run_remote_command).toBe('function');
    expect(typeof handlers.run_tests).toBe('function');
  });

  it('run_remote_command is callable as an HTTP handler', async () => {
    const agentRegistry = { name: 'registry-stub' };
    const response = createMockResponse();
    const {
      handlers,
      parseCommand,
      runRemoteOrLocal,
      createRemoteTestRouter,
      db,
      loggerInstance,
    } = loadModules({ agentRegistry });

    await handlers.run_remote_command({
      method: 'POST',
      body: {
        command: 'npm test',
        working_directory: '/repo',
      },
    }, response);

    expect(parseCommand).toHaveBeenCalledWith('npm test');
    expect(createRemoteTestRouter).toHaveBeenCalledWith({
      agentRegistry,
      db,
      logger: loggerInstance,
    });
    expect(runRemoteOrLocal).toHaveBeenCalledWith('npm', ['test'], '/repo', {
      timeout: 300000,
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

  it('run_tests is callable as an HTTP handler', async () => {
    const agentRegistry = { name: 'registry-stub' };
    const response = createMockResponse();
    const {
      handlers,
      db,
      runVerifyCommand,
      createRemoteTestRouter,
      loggerInstance,
    } = loadModules({ agentRegistry });

    await handlers.run_tests({
      method: 'POST',
      body: {
        working_directory: '/repo',
      },
    }, response);

    expect(db.getProjectFromPath).toHaveBeenCalledWith('/repo');
    expect(db.getProjectConfig).toHaveBeenCalledWith('torque-server');
    expect(createRemoteTestRouter).toHaveBeenCalledWith({
      agentRegistry,
      db,
      logger: loggerInstance,
    });
    expect(runVerifyCommand).toHaveBeenCalledWith('npm test && npm run lint', '/repo');
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual({
      success: true,
      output: 'verify-ok',
      exitCode: 0,
      durationMs: 18,
      remote: false,
      warning: 'Remote agent unavailable or not configured; tests ran locally.',
    });
  });
});
