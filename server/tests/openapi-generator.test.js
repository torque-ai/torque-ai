'use strict';

const {
  API_TITLE,
  API_VERSION,
  OPENAPI_VERSION,
  buildInfoBlock,
  buildServerBlock,
  getFallbackParamName,
  pathFromRegex,
  buildPathItem,
  generateOpenApiSpec,
} = require('../api/openapi-generator');
const routes = require('../api/routes');

const GENERIC_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
};

function countOperations(spec) {
  return Object.values(spec.paths).reduce(
    (count, pathItem) => count + Object.keys(pathItem).length,
    0,
  );
}

function getUniqueRouteEntries(routeTable) {
  const seen = new Set();
  const entries = [];

  for (const route of routeTable) {
    const method = (route.method || 'get').toLowerCase();
    const pathKey = pathFromRegex(route.path, route.mapParams);
    const signature = `${method} ${pathKey}`;
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    entries.push({ route, method, pathKey, signature });
  }

  return entries;
}

function getPathParamNames(pathKey) {
  return Array.from(String(pathKey).matchAll(/\{([^}]+)\}/g), (match) => match[1]);
}

describe('openapi-generator helpers', () => {
  it('buildInfoBlock returns the package-backed API metadata', () => {
    expect(buildInfoBlock()).toEqual({
      title: API_TITLE,
      version: API_VERSION,
      description: 'TORQUE - Threaded Orchestration Router for Queued Unit Execution',
    });
  });

  it('buildServerBlock returns the default local server', () => {
    expect(buildServerBlock()).toEqual([
      {
        url: 'http://localhost:3457',
        description: 'Local TORQUE server',
      },
    ]);
  });

  it('buildServerBlock accepts a custom base URL', () => {
    expect(buildServerBlock('https://api.example.test')).toEqual([
      {
        url: 'https://api.example.test',
        description: 'Local TORQUE server',
      },
    ]);
  });

  it('getFallbackParamName uses id for the first placeholder and idN after that', () => {
    expect(getFallbackParamName(0)).toBe('id');
    expect(getFallbackParamName(1)).toBe('id2');
    expect(getFallbackParamName(2)).toBe('id3');
  });
});

describe('pathFromRegex', () => {
  it('returns string paths unchanged', () => {
    expect(pathFromRegex('/api/v2/tasks')).toBe('/api/v2/tasks');
  });

  it('converts regex paths to OpenAPI placeholders using mapParams', () => {
    expect(
      pathFromRegex(
        /^\/api\/v2\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)$/,
        ['host_name', 'credential_type'],
      ),
    ).toBe('/api/v2/hosts/{host_name}/credentials/{credential_type}');
  });

  it('falls back to generated parameter names when mapParams are missing', () => {
    expect(
      pathFromRegex(/^\/api\/pairs\/([^/]+)\/versions\/([^/]+)$/),
    ).toBe('/api/pairs/{id}/versions/{id2}');
  });
});

describe('buildPathItem', () => {
  it('derives a default operation id, summary, tag, and default responses', () => {
    const item = buildPathItem({
      method: 'GET',
      path: '/custom/reports/status',
    });

    expect(item.get).toEqual(expect.objectContaining({
      operationId: 'get_custom_reports_status',
      summary: 'get_custom_reports_status',
      tags: ['custom'],
      responses: expect.objectContaining({
        200: {
          description: 'Successful operation',
          content: {
            'application/json': {
              schema: GENERIC_OBJECT_SCHEMA,
            },
          },
        },
        400: { description: 'Bad request' },
        404: { description: 'Not found' },
        500: { description: 'Internal server error' },
      }),
    }));
  });

  it('prefers handlerName over handler function names and tool names', () => {
    function inferredHandlerName() {}

    const item = buildPathItem({
      method: 'POST',
      path: '/api/v2/custom',
      handlerName: 'handleCustomRoute',
      handler: inferredHandlerName,
      tool: 'custom_tool',
    });

    expect(item.post).toEqual(expect.objectContaining({
      operationId: 'handleCustomRoute',
      summary: 'handleCustomRoute',
      tags: ['custom'],
      'x-handler-name': 'handleCustomRoute',
      'x-tool-name': 'custom_tool',
    }));
    expect(item.post.requestBody).toEqual({
      required: false,
      content: {
        'application/json': {
          schema: GENERIC_OBJECT_SCHEMA,
        },
      },
    });
  });

  it('uses the handler function name when handlerName is absent', () => {
    function listHealthChecks() {}

    const item = buildPathItem({
      method: 'GET',
      path: '/api/health/checks',
      handler: listHealthChecks,
    });

    expect(item.get).toEqual(expect.objectContaining({
      operationId: 'listHealthChecks',
      summary: 'listHealthChecks',
      tags: ['health'],
    }));
  });

  it('uses the route tool name when no handler metadata is present', () => {
    const item = buildPathItem({
      method: 'DELETE',
      path: '/cleanup/jobs',
      tool: 'delete_jobs',
    });

    expect(item.delete).toEqual(expect.objectContaining({
      operationId: 'delete_jobs',
      summary: 'delete_jobs',
      tags: ['cleanup'],
      'x-tool-name': 'delete_jobs',
    }));
    expect(item.delete.requestBody).toBeUndefined();
  });

  it('uses explicit descriptions and tags and maps path params for generic write routes', () => {
    const item = buildPathItem({
      method: 'PATCH',
      path: /^\/api\/tasks\/([^/]+)$/,
      mapParams: ['task_id'],
      tags: ['maintenance'],
      description: 'Update a task',
    });

    expect(item.patch).toEqual(expect.objectContaining({
      summary: 'Update a task',
      tags: ['maintenance'],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: GENERIC_OBJECT_SCHEMA,
          },
        },
      },
      parameters: [
        {
          name: 'task_id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
    }));
  });

  it('does not add requestBody for delete routes', () => {
    const item = buildPathItem({
      method: 'DELETE',
      path: /^\/api\/tasks\/([^/]+)$/,
      mapParams: ['task_id'],
      tool: 'cancel_task',
    });

    expect(item.delete.requestBody).toBeUndefined();
    expect(item.delete.parameters).toEqual([
      {
        name: 'task_id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ]);
  });

  it('applies the concrete task submission schema override', () => {
    const item = buildPathItem({
      method: 'POST',
      path: '/api/v2/tasks',
      handlerName: 'handleV2CpSubmitTask',
    });

    expect(item.post.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TaskSubmissionRequest' },
        },
      },
    });
    expect(item.post.responses['201']).toEqual({
      description: 'Task created',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TaskSubmissionSuccessEnvelope' },
        },
      },
    });
    expect(item.post.responses['400']).toEqual({
      description: 'Validation error',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        },
      },
    });
  });

  it('applies the concrete workflow detail schema override', () => {
    const item = buildPathItem({
      method: 'GET',
      path: /^\/api\/v2\/workflows\/([^/]+)$/,
      mapParams: ['workflow_id'],
      handlerName: 'handleV2CpGetWorkflow',
    });

    expect(item.get.requestBody).toBeUndefined();
    expect(item.get.parameters).toEqual([
      {
        name: 'workflow_id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ]);
    expect(item.get.responses['200']).toEqual({
      description: 'Workflow detail',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/WorkflowDetailSuccessEnvelope' },
        },
      },
    });
    expect(item.get.responses['404']).toEqual({
      description: 'Workflow not found',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        },
      },
    });
  });
});

describe('generateOpenApiSpec', () => {
  it('builds a valid empty spec with the expected top-level structure', () => {
    const spec = generateOpenApiSpec([]);

    expect(spec).toEqual(expect.objectContaining({
      openapi: OPENAPI_VERSION,
      info: buildInfoBlock(),
      servers: buildServerBlock(),
      paths: {},
      components: expect.objectContaining({
        schemas: expect.any(Object),
      }),
    }));
  });

  it('merges operations for different methods on the same path', () => {
    const spec = generateOpenApiSpec([
      { method: 'GET', path: '/api/tasks', tool: 'list_tasks' },
      { method: 'POST', path: '/api/tasks', tool: 'submit_task' },
    ], { baseUrl: 'https://api.example.test' });

    expect(spec.servers[0].url).toBe('https://api.example.test');
    expect(Object.keys(spec.paths['/api/tasks']).sort()).toEqual(['get', 'post']);
    expect(spec.paths['/api/tasks'].get.operationId).toBe('list_tasks');
    expect(spec.paths['/api/tasks'].post.operationId).toBe('submit_task');
  });

  it('keeps the first registered route for duplicate method and path pairs', () => {
    const spec = generateOpenApiSpec([
      { method: 'GET', path: '/api/tasks', handlerName: 'handleFirstTaskRoute' },
      { method: 'GET', path: '/api/tasks', handlerName: 'handleShadowedTaskRoute' },
    ]);

    expect(spec.paths['/api/tasks'].get.operationId).toBe('handleFirstTaskRoute');
    expect(spec.paths['/api/tasks'].get.summary).toBe('handleFirstTaskRoute');
  });

  it('treats an options object as a request to use the registered route table', () => {
    const spec = generateOpenApiSpec({ baseUrl: 'https://internal.example.test' });

    expect(spec.servers[0].url).toBe('https://internal.example.test');
    expect(spec.paths['/api/openapi.json'].get.operationId).toBe('handleOpenApiSpec');
  });

  it('covers every first-occurrence method and path pair from the real route table', () => {
    const spec = generateOpenApiSpec(routes);
    const uniqueRoutes = getUniqueRouteEntries(routes);

    expect(countOperations(spec)).toBe(uniqueRoutes.length);

    for (const { route, method, pathKey } of uniqueRoutes) {
      expect(spec.paths[pathKey]?.[method]).toBeDefined();
      expect(spec.paths[pathKey][method].operationId).toBe(
        buildPathItem(route)[method].operationId,
      );
    }
  });

  it('generates operations with a consistent minimal OpenAPI contract', () => {
    const spec = generateOpenApiSpec(routes);

    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        expect(['get', 'post', 'put', 'patch', 'delete']).toContain(method);
        expect(operation.operationId).toEqual(expect.any(String));
        expect(operation.summary).toEqual(expect.any(String));
        expect(operation.tags).toEqual(expect.arrayContaining([expect.any(String)]));
        expect(operation.responses).toBeTruthy();

        const placeholderNames = getPathParamNames(pathKey);
        if (placeholderNames.length > 0) {
          expect(operation.parameters?.map((parameter) => parameter.name)).toEqual(placeholderNames);
        } else {
          expect(operation.parameters).toBeUndefined();
        }

        if (['post', 'put', 'patch'].includes(method)) {
          expect(operation.requestBody).toBeDefined();
        } else {
          expect(operation.requestBody).toBeUndefined();
        }
      }
    }
  });

  it('includes multi-parameter credential routes with ordered path parameters', () => {
    const spec = generateOpenApiSpec(routes);
    const credentialPath = '/api/v2/hosts/{host_name}/credentials/{credential_type}';

    expect(spec.paths).toHaveProperty(credentialPath);
    expect(spec.paths[credentialPath].put).toEqual(expect.objectContaining({
      operationId: 'handleV2CpSaveCredential',
      parameters: [
        {
          name: 'host_name',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        {
          name: 'credential_type',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
    }));
    expect(spec.paths[credentialPath].delete.operationId).toBe('handleV2CpDeleteCredential');
  });

  it('includes the expected control-plane and peek endpoints from the real route table', () => {
    const spec = generateOpenApiSpec(routes);

    expect(spec.paths['/api/v2/tasks'].post.operationId).toBe('handleV2CpSubmitTask');
    expect(spec.paths['/api/v2/workflows/{workflow_id}'].get.operationId).toBe('handleV2CpGetWorkflow');
    expect(spec.paths['/api/v2/peek-hosts'].get.operationId).toBe('handleV2CpListPeekHosts');
    expect(spec.paths['/api/v2/peek-hosts'].post.operationId).toBe('handleV2CpCreatePeekHost');
    expect(spec.paths['/api/v2/peek-hosts/{host_name}'].delete.operationId).toBe('handleV2CpDeletePeekHost');
  });

  it('publishes the expected success envelope component schemas', () => {
    const spec = generateOpenApiSpec([]);
    const schemas = spec.components.schemas;

    expect(schemas.ResponseMeta).toEqual({
      type: 'object',
      required: ['request_id', 'timestamp'],
      properties: {
        request_id: { type: 'string', format: 'uuid' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    });
    expect(schemas.ErrorEnvelope.properties.meta).toEqual({
      $ref: '#/components/schemas/ResponseMeta',
    });
    expect(schemas.TaskSubmissionSuccessEnvelope).toEqual({
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: '#/components/schemas/TaskSubmissionData' },
        meta: { $ref: '#/components/schemas/ResponseMeta' },
      },
    });
    expect(schemas.WorkflowCreateFallbackEnvelope.properties.data).toEqual({
      $ref: '#/components/schemas/WorkflowCreateFallbackData',
    });
  });

  it('publishes the expected task and workflow request schema contracts', () => {
    const spec = generateOpenApiSpec([]);
    const schemas = spec.components.schemas;

    expect(schemas.TaskSubmissionRequest).toEqual(expect.objectContaining({
      type: 'object',
      anyOf: [
        { required: ['task'] },
        { required: ['description'] },
      ],
      additionalProperties: true,
      properties: expect.objectContaining({
        task: { type: 'string', maxLength: 50000 },
        description: { type: 'string', maxLength: 50000 },
        timeout_minutes: { type: 'integer', minimum: 1 },
        auto_approve: { type: 'boolean' },
        priority: { type: 'integer' },
      }),
    }));
    expect(schemas.WorkflowCreateRequest).toEqual(expect.objectContaining({
      type: 'object',
      required: ['name', 'tasks'],
      additionalProperties: true,
      properties: expect.objectContaining({
        control_handlers: { $ref: '#/components/schemas/WorkflowControlHandlers' },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        tasks: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/components/schemas/WorkflowTaskInput' },
        },
      }),
    }));
  });
});
