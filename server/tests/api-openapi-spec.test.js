import { describe, expect, it, vi } from 'vitest';

const routes = require('../api/routes');
const { version: packageVersion } = require('../package.json');
const {
  API_TITLE,
  API_VERSION,
  OPENAPI_VERSION,
  buildPathItem,
  generateOpenApiSpec,
  pathFromRegex,
} = require('../api/openapi-generator');

function createMockResponse() {
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      response.body = body;
    }),
  };

  return response;
}

describe('openapi-generator', () => {
  it('returns a valid OpenAPI 3.0.3 structure', () => {
    const spec = generateOpenApiSpec([
      { method: 'GET', path: '/api/tasks', tool: 'list_tasks' },
      { method: 'POST', path: '/api/tasks', tool: 'submit_task', mapBody: true },
    ]);

    expect(spec).toEqual(expect.objectContaining({
      openapi: OPENAPI_VERSION,
      info: {
        title: API_TITLE,
        version: API_VERSION,
        description: expect.any(String),
      },
      servers: [
        {
          url: 'http://localhost:3457',
          description: 'Local TORQUE server',
        },
      ],
      paths: expect.any(Object),
      components: expect.any(Object),
    }));
    expect(spec.openapi).toMatch(/^3\.0\.\d+$/);
  });

  it('includes the expected top-level keys', () => {
    const spec = generateOpenApiSpec([{ method: 'GET', path: '/api/tasks', tool: 'list_tasks' }]);

    expect(Object.keys(spec)).toEqual(expect.arrayContaining([
      'openapi',
      'info',
      'servers',
      'paths',
    ]));
  });

  it('uses the package version in the info block', () => {
    expect(API_VERSION).toBe(packageVersion);
    expect(generateOpenApiSpec([]).info.version).toBe(packageVersion);
  });

  it('sets the OpenAPI version to 3.0.3', () => {
    const spec = generateOpenApiSpec([]);
    expect(spec.openapi).toBe('3.0.3');
  });

  it('converts regex paths to OpenAPI format', () => {
    expect(pathFromRegex(/^\/api\/tasks\/([^/]+)$/)).toBe('/api/tasks/{id}');
    expect(
      pathFromRegex(
        /^\/api\/v2\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)$/,
        ['host_name', 'credential_type'],
      ),
    ).toBe('/api/v2/hosts/{host_name}/credentials/{credential_type}');
  });

  it('adds requestBody for generic POST routes', () => {
    const item = buildPathItem({ method: 'POST', path: '/api/tasks', tool: 'submit_task' });

    expect(item.post.requestBody).toEqual({
      required: false,
      content: {
        'application/json': {
          schema: { type: 'object', additionalProperties: true },
        },
      },
    });
  });

  it('does not add requestBody for GET routes', () => {
    const item = buildPathItem({ method: 'GET', path: '/api/tasks', tool: 'list_tasks' });

    expect(item.get.requestBody).toBeUndefined();
  });

  it('extracts path parameters from mapParams', () => {
    const spec = generateOpenApiSpec([
      {
        method: 'GET',
        path: /^\/api\/tasks\/([^/]+)$/,
        tool: 'get_result',
        mapParams: ['task_id'],
      },
    ]);

    expect(spec.paths['/api/tasks/{task_id}'].get.parameters).toEqual([
      {
        name: 'task_id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ]);
  });

  it('reads routes.js by default and includes the OpenAPI endpoint', () => {
    const spec = generateOpenApiSpec();

    expect(spec.paths).toHaveProperty('/api/openapi.json');
    expect(spec.paths['/api/openapi.json'].get.operationId).toBe('handleOpenApiSpec');
  });

  it('covers peek-related endpoints from the route table', () => {
    const spec = generateOpenApiSpec(routes);

    expect(spec.paths).toHaveProperty('/api/v2/peek/attestations/{id}');
    expect(spec.paths).toHaveProperty('/api/v2/peek-hosts');
    expect(spec.paths).toHaveProperty('/api/v2/peek-hosts/{host_name}');
    expect(spec.paths['/api/v2/peek/attestations/{id}'].get.operationId).toBe('handleV2CpPeekAttestationExport');
    expect(spec.paths['/api/v2/peek-hosts'].get.operationId).toBe('handleV2CpListPeekHosts');
    expect(spec.paths['/api/v2/peek-hosts'].post.operationId).toBe('handleV2CpCreatePeekHost');
    expect(spec.paths['/api/v2/peek-hosts/{host_name}'].delete.operationId).toBe('handleV2CpDeletePeekHost');
  });

  it('adds concrete schemas for task and workflow control-plane endpoints', () => {
    const spec = generateOpenApiSpec(routes);

    expect(spec.paths['/api/v2/tasks'].post.requestBody).toEqual(expect.objectContaining({
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TaskSubmissionRequest' },
        },
      },
    }));
    expect(spec.paths['/api/v2/tasks'].post.responses['201']).toEqual(expect.objectContaining({
      description: 'Task created',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TaskSubmissionSuccessEnvelope' },
        },
      },
    }));
    expect(spec.paths['/api/v2/tasks/{task_id}'].get.responses['200']).toEqual(expect.objectContaining({
      description: 'Task detail',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TaskDetailSuccessEnvelope' },
        },
      },
    }));
    expect(spec.paths['/api/v2/workflows'].post.requestBody).toEqual(expect.objectContaining({
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/WorkflowCreateRequest' },
        },
      },
    }));
    expect(spec.paths['/api/v2/workflows'].post.responses['201']).toEqual(expect.objectContaining({
      description: 'Workflow created',
      content: {
        'application/json': {
          schema: {
            oneOf: [
              { $ref: '#/components/schemas/WorkflowDetailSuccessEnvelope' },
              { $ref: '#/components/schemas/WorkflowCreateFallbackEnvelope' },
            ],
          },
        },
      },
    }));
    expect(spec.paths['/api/v2/workflows/{workflow_id}'].get.responses['200']).toEqual(expect.objectContaining({
      description: 'Workflow detail',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/WorkflowDetailSuccessEnvelope' },
        },
      },
    }));
  });

  it('serves the generated spec from the route table handler', async () => {
    const route = routes.find((candidate) => (
      candidate.method === 'GET'
      && candidate.path === '/api/openapi.json'
    ));

    const response = createMockResponse();
    const request = {
      requestId: 'req-openapi',
      headers: {},
    };

    await route.handler(request, response, {
      requestId: request.requestId,
      params: {},
      query: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    expect(JSON.parse(response.body)).toEqual(generateOpenApiSpec());
  });

  it('serializes to valid JSON', () => {
    const spec = generateOpenApiSpec([
      { method: 'GET', path: '/api/tasks', tool: 'list_tasks' },
    ]);

    const serialized = JSON.stringify(spec);
    expect(JSON.parse(serialized)).toEqual(spec);
  });
});
