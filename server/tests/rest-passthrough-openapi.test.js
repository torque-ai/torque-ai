'use strict';

function resetCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that have not been loaded yet.
  }
}

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

[
  '../api/routes',
  '../api/openapi-generator',
  '../database',
  '../api/v2-schemas',
  '../api/v2-middleware',
].forEach(resetCjsModule);

installCjsModuleMock('../database', { getDefaultProvider: () => null });
installCjsModuleMock('../api/v2-schemas', {
  validateInferenceRequest: vi.fn(() => ({ valid: true, errors: [], value: {} })),
});
installCjsModuleMock('../api/v2-middleware', {
  requestId: vi.fn((_req, _res, next) => next()),
  validateRequest: () => vi.fn((_req, _res, next) => next()),
});

const routes = require('../api/routes');
const passthroughRoutes = require('../api/routes-passthrough');
const { generateOpenApiSpec, pathFromRegex } = require('../api/openapi-generator');

const spec = generateOpenApiSpec(routes);

const PASSTHROUGH_CASES = [
  { method: 'GET', path: '/api/v2/advanced/get-audit-log', tool: 'get_audit_log', domain: 'advanced' },
  { method: 'GET', path: '/api/v2/advanced/get-resource-usage/{task_id}', tool: 'get_resource_usage', domain: 'advanced' },
  { method: 'POST', path: '/api/v2/approvals/approve-diff', tool: 'approve_diff', domain: 'approvals' },
  { method: 'POST', path: '/api/v2/automation/run-tests', tool: 'run_tests', domain: 'automation' },
  { method: 'DELETE', path: '/api/v2/automation/delete-task-template', tool: 'delete_task_template', domain: 'automation' },
  { method: 'GET', path: '/api/v2/baselines/list-backups/{task_id}', tool: 'list_backups', domain: 'baselines' },
  { method: 'GET', path: '/api/v2/integration/list-email-notifications/{task_id}', tool: 'list_email_notifications', domain: 'integration' },
  { method: 'GET', path: '/api/v2/intelligence/intelligence-dashboard', tool: 'intelligence_dashboard', domain: 'intelligence' },
  { method: 'POST', path: '/api/v2/validation/run-build-check', tool: 'run_build_check', domain: 'validation' },
  { method: 'DELETE', path: '/api/v2/advanced/release-lock/{agent_id}', tool: 'release_lock', domain: 'advanced' },
];

const GET_CASES = PASSTHROUGH_CASES.filter((testCase) => testCase.method === 'GET');
const POST_CASES = PASSTHROUGH_CASES.filter((testCase) => testCase.method === 'POST');
const DELETE_CASES = PASSTHROUGH_CASES.filter((testCase) => testCase.method === 'DELETE');

const PARAM_CASES = [
  { method: 'GET', path: '/api/v2/advanced/get-resource-usage/{task_id}', params: ['task_id'] },
  { method: 'GET', path: '/api/v2/baselines/list-backups/{task_id}', params: ['task_id'] },
  { method: 'GET', path: '/api/v2/integration/list-email-notifications/{task_id}', params: ['task_id'] },
  { method: 'DELETE', path: '/api/v2/advanced/release-lock/{agent_id}', params: ['agent_id'] },
];

function getOperation(method, pathKey) {
  return spec.paths[pathKey]?.[method.toLowerCase()];
}

function routeExistsInTable(testCase) {
  return routes.some((route) => (
    route.method === testCase.method
    && route.tool === testCase.tool
    && pathFromRegex(route.path, route.mapParams) === testCase.path
  ));
}

describe('REST passthrough OpenAPI coverage', () => {
  it('loads routes.js with the passthrough routes present under mocked dependencies', () => {
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThanOrEqual(passthroughRoutes.length + 100);

    PASSTHROUGH_CASES.forEach((testCase) => {
      expect(routeExistsInTable(testCase)).toBe(true);
    });
  });

  it('generates a JSON-serializable OpenAPI 3 spec with the required top-level fields', () => {
    const serialized = JSON.stringify(spec);
    const parsed = JSON.parse(serialized);

    expect(parsed).toEqual(expect.objectContaining({
      openapi: expect.stringMatching(/^3\.0\./),
      info: expect.objectContaining({
        title: expect.any(String),
        version: expect.any(String),
      }),
      paths: expect.any(Object),
    }));
    expect(Object.keys(parsed.paths).length).toBeGreaterThan(0);
  });

  it('includes selected passthrough paths from multiple domains with the expected HTTP methods', () => {
    PASSTHROUGH_CASES.forEach(({ method, path }) => {
      expect(spec.paths[path]).toBeDefined();
      expect(Object.keys(spec.paths[path]).sort()).toEqual([method.toLowerCase()]);
    });
  });

  it('documents GET passthrough routes as tool-backed operations without request bodies', () => {
    GET_CASES.forEach(({ path, tool, domain }) => {
      const operation = getOperation('GET', path);

      expect(operation).toEqual(expect.objectContaining({
        operationId: tool,
        summary: tool,
        tags: [domain],
        'x-tool-name': tool,
      }));
      expect(operation.requestBody).toBeUndefined();
      expect(operation.responses).toHaveProperty('200');
    });
  });

  it('documents POST passthrough routes with tool metadata and the default JSON request body', () => {
    POST_CASES.forEach(({ path, tool, domain }) => {
      const operation = getOperation('POST', path);

      expect(operation).toEqual(expect.objectContaining({
        operationId: tool,
        summary: tool,
        tags: [domain],
        'x-tool-name': tool,
      }));
      expect(operation.requestBody).toEqual({
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
      });
      expect(operation.responses).toHaveProperty('200');
    });
  });

  it('documents DELETE passthrough routes without request bodies', () => {
    DELETE_CASES.forEach(({ path, tool, domain }) => {
      const operation = getOperation('DELETE', path);

      expect(operation).toEqual(expect.objectContaining({
        operationId: tool,
        summary: tool,
        tags: [domain],
        'x-tool-name': tool,
      }));
      expect(operation.requestBody).toBeUndefined();
      expect(operation.responses).toHaveProperty('200');
    });
  });

  it('preserves named path parameters for regex-based passthrough routes', () => {
    PARAM_CASES.forEach(({ method, path, params }) => {
      const operation = getOperation(method, path);

      expect(operation.parameters).toEqual(params.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })));
    });
  });

  it('keeps passthrough routes in the generated spec and publishes at least 300 unique paths', () => {
    const missing = passthroughRoutes
      .filter((route) => !getOperation(route.method, pathFromRegex(route.path, route.mapParams)))
      .map((route) => `${route.method} ${pathFromRegex(route.path, route.mapParams)}`);

    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(300);
    expect(missing).toEqual([]);
  });
});
