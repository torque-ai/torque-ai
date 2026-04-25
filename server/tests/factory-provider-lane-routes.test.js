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

function mockRes() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

describe('factory provider lane audit route', () => {
  let mockHandlers;
  let mockSendSuccess;
  let mockSendError;
  let FACTORY_V2_ROUTES;

  beforeEach(() => {
    vi.resetModules();
    try { delete require.cache[require.resolve('../api/routes/factory-routes')]; } catch { /* not loaded */ }
    try { delete require.cache[require.resolve('../handlers/factory-handlers')]; } catch { /* not loaded */ }

    mockHandlers = {
      handleFactoryProviderLaneAudit: vi.fn(),
    };
    mockSendSuccess = vi.fn();
    mockSendError = vi.fn();

    installCjsModuleMock('../handlers/factory-handlers', mockHandlers);
    installCjsModuleMock('../api/v2-control-plane', {
      sendSuccess: mockSendSuccess,
      sendError: mockSendError,
    });
    installCjsModuleMock('../api/middleware', {
      parseBody: vi.fn(),
    });

    ({ FACTORY_V2_ROUTES } = require('../api/routes/factory-routes'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers provider-lane audit and maps query policy into handler args', async () => {
    const route = FACTORY_V2_ROUTES.find((entry) => entry.tool === 'factory_provider_lane_audit');
    expect(route).toMatchObject({
      method: 'GET',
      mapParams: ['project'],
      mapQuery: true,
      handlerName: 'handleFactoryProviderLaneAudit',
    });
    expect(route.path.test('/api/v2/factory/projects/project-1/provider-lane')).toBe(true);

    mockHandlers.handleFactoryProviderLaneAudit.mockResolvedValueOnce({
      structuredData: {
        project: { id: 'project-1' },
        guard: { status: 'fail', violations_count: 1 },
      },
    });

    const req = {
      params: { project: 'project-1' },
      query: {
        limit: '25',
        expected_provider: 'ollama-cloud',
        allowed_fallback_providers: 'codex, deepinfra',
        require_classified_fallback: 'false',
      },
    };
    const res = mockRes();

    await route.handler(req, res, { requestId: 'provider-lane-req', params: req.params, query: req.query });

    expect(mockHandlers.handleFactoryProviderLaneAudit).toHaveBeenCalledWith({
      project: 'project-1',
      limit: 25,
      expected_provider: 'ollama-cloud',
      allowed_fallback_providers: ['codex', 'deepinfra'],
      require_classified_fallback: false,
    });
    expect(mockSendSuccess).toHaveBeenCalledWith(
      res,
      'provider-lane-req',
      { project: { id: 'project-1' }, guard: { status: 'fail', violations_count: 1 } },
      200,
      expect.objectContaining({ params: req.params, query: req.query }),
    );
    expect(mockSendError).not.toHaveBeenCalled();
  });
});
