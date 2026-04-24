'use strict';

/**
 * Generates an OpenAPI 3.0.3 spec from TORQUE route definitions.
 */

const { version: PACKAGE_VERSION } = require('../package.json');

const OPENAPI_VERSION = '3.0.3';
const API_TITLE = 'TORQUE API';
const API_VERSION = typeof PACKAGE_VERSION === 'string' && PACKAGE_VERSION.trim()
  ? PACKAGE_VERSION.trim()
  : '0.0.0';
const API_DESCRIPTION = 'TORQUE - Threaded Orchestration Router for Queued Unit Execution';
const DEFAULT_SERVER_URL = 'http://localhost:3457';
const JSON_CONTENT_TYPE = 'application/json';
const GENERIC_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
};

const COMPONENT_SCHEMAS = {
  ResponseMeta: {
    type: 'object',
    required: ['request_id', 'timestamp'],
    properties: {
      request_id: { type: 'string', format: 'uuid' },
      timestamp: { type: 'string', format: 'date-time' },
    },
  },
  ErrorEnvelope: {
    type: 'object',
    required: ['error', 'meta'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'details', 'request_id'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: GENERIC_OBJECT_SCHEMA,
          request_id: { type: 'string', format: 'uuid' },
        },
      },
      meta: { $ref: '#/components/schemas/ResponseMeta' },
    },
  },
  TaskSummary: {
    type: 'object',
    required: ['id', 'status', 'priority', 'auto_approve', 'progress_percent', 'files_modified', 'metadata'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string' },
      description: { type: 'string', nullable: true },
      provider: { type: 'string', nullable: true },
      model: { type: 'string', nullable: true },
      working_directory: { type: 'string', nullable: true },
      exit_code: { type: 'integer', nullable: true },
      priority: { type: 'integer' },
      auto_approve: { type: 'boolean' },
      timeout_minutes: { type: 'integer', nullable: true },
      progress_percent: { type: 'number' },
      ollama_host_id: { type: 'string', nullable: true },
      files_modified: {
        type: 'array',
        items: { type: 'string' },
      },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      started_at: { type: 'string', format: 'date-time', nullable: true },
      completed_at: { type: 'string', format: 'date-time', nullable: true },
      metadata: GENERIC_OBJECT_SCHEMA,
    },
  },
  TaskDetail: {
    allOf: [
      { $ref: '#/components/schemas/TaskSummary' },
      {
        type: 'object',
        properties: {
          output: { type: 'string', nullable: true },
          error_output: { type: 'string', nullable: true },
        },
      },
    ],
  },
  TaskSubmissionData: {
    allOf: [
      { $ref: '#/components/schemas/TaskSummary' },
      {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string', format: 'uuid' },
        },
      },
    ],
  },
  WorkflowTaskSummary: {
    type: 'object',
    required: ['id', 'status', 'progress'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      node_id: { type: 'string', nullable: true },
      status: { type: 'string' },
      description: { type: 'string', nullable: true },
      task_description: { type: 'string', nullable: true },
      provider: { type: 'string', nullable: true },
      model: { type: 'string', nullable: true },
      progress: { type: 'number' },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        nullable: true,
      },
      started_at: { type: 'string', format: 'date-time', nullable: true },
      completed_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  WorkflowCostSummary: {
    type: 'object',
    required: ['total_cost_usd', 'total_input_tokens', 'total_output_tokens', 'by_model'],
    properties: {
      total_cost_usd: { type: 'number' },
      total_input_tokens: { type: 'integer' },
      total_output_tokens: { type: 'integer' },
      by_model: {
        type: 'array',
        items: GENERIC_OBJECT_SCHEMA,
      },
    },
  },
  WorkflowTaskCounts: {
    type: 'object',
    required: [
      'total',
      'completed',
      'running',
      'pending',
      'queued',
      'failed',
      'cancelled',
      'blocked',
      'skipped',
    ],
    properties: {
      total: { type: 'integer' },
      completed: { type: 'integer' },
      running: { type: 'integer' },
      pending: { type: 'integer' },
      queued: { type: 'integer' },
      failed: { type: 'integer' },
      cancelled: { type: 'integer' },
      blocked: { type: 'integer' },
      skipped: { type: 'integer' },
    },
  },
  WorkflowControlHandlerMap: {
    type: 'object',
    additionalProperties: { type: 'string' },
  },
  WorkflowControlHandlers: {
    type: 'object',
    properties: {
      queries: { $ref: '#/components/schemas/WorkflowControlHandlerMap' },
      signals: { $ref: '#/components/schemas/WorkflowControlHandlerMap' },
      updates: { $ref: '#/components/schemas/WorkflowControlHandlerMap' },
    },
    additionalProperties: true,
  },
  WorkflowSummary: {
    type: 'object',
    required: ['id', 'status'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string', nullable: true },
      status: { type: 'string' },
      description: { type: 'string', nullable: true },
      working_directory: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      started_at: { type: 'string', format: 'date-time', nullable: true },
      completed_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  WorkflowDetail: {
    allOf: [
      { $ref: '#/components/schemas/WorkflowSummary' },
      {
        type: 'object',
        required: ['cost', 'task_counts', 'tasks'],
        properties: {
          control_handlers: { $ref: '#/components/schemas/WorkflowControlHandlers' },
          cost: { $ref: '#/components/schemas/WorkflowCostSummary' },
          task_counts: { $ref: '#/components/schemas/WorkflowTaskCounts' },
          tasks: {
            type: 'array',
            items: { $ref: '#/components/schemas/WorkflowTaskSummary' },
          },
        },
      },
    ],
  },
  TaskSubmissionRequest: {
    type: 'object',
    properties: {
      task: { type: 'string', maxLength: 50000 },
      description: { type: 'string', maxLength: 50000 },
      provider: { type: 'string' },
      model: { type: 'string' },
      working_directory: { type: 'string' },
      timeout_minutes: { type: 'integer', minimum: 1 },
      auto_approve: { type: 'boolean' },
      priority: { type: 'integer' },
    },
    anyOf: [
      { required: ['task'] },
      { required: ['description'] },
    ],
    additionalProperties: true,
  },
  WorkflowTaskInput: {
    type: 'object',
    properties: {
      node_id: { type: 'string' },
      task: { type: 'string' },
      task_description: { type: 'string' },
      description: { type: 'string' },
      working_directory: { type: 'string' },
      timeout_minutes: { type: 'integer', minimum: 1 },
      auto_approve: { type: 'boolean' },
      priority: { type: 'integer' },
      provider: { type: 'string' },
      model: { type: 'string' },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    additionalProperties: true,
  },
  WorkflowCreateRequest: {
    type: 'object',
    required: ['name', 'tasks'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string' },
      working_directory: { type: 'string' },
      control_handlers: { $ref: '#/components/schemas/WorkflowControlHandlers' },
      tasks: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/WorkflowTaskInput' },
      },
    },
    additionalProperties: true,
  },
  WorkflowCreateFallbackData: {
    type: 'object',
    required: ['name', 'message'],
    properties: {
      name: { type: 'string' },
      message: { type: 'string' },
    },
  },
  TaskSubmissionSuccessEnvelope: buildSuccessEnvelopeSchema('#/components/schemas/TaskSubmissionData'),
  TaskDetailSuccessEnvelope: buildSuccessEnvelopeSchema('#/components/schemas/TaskDetail'),
  WorkflowDetailSuccessEnvelope: buildSuccessEnvelopeSchema('#/components/schemas/WorkflowDetail'),
  WorkflowCreateFallbackEnvelope: buildSuccessEnvelopeSchema('#/components/schemas/WorkflowCreateFallbackData'),
};

const ROUTE_SCHEMA_OVERRIDES = {
  'post /api/v2/tasks': {
    requestBody: buildJsonRequestBody('#/components/schemas/TaskSubmissionRequest', true),
    responses: {
      201: buildJsonResponse('Task created', '#/components/schemas/TaskSubmissionSuccessEnvelope'),
      400: buildJsonResponse('Validation error', '#/components/schemas/ErrorEnvelope'),
      403: buildJsonResponse('Task blocked by policy', '#/components/schemas/ErrorEnvelope'),
      404: buildJsonResponse('Provider not found', '#/components/schemas/ErrorEnvelope'),
      500: buildJsonResponse('Internal server error', '#/components/schemas/ErrorEnvelope'),
    },
  },
  'get /api/v2/tasks/{task_id}': {
    responses: {
      200: buildJsonResponse('Task detail', '#/components/schemas/TaskDetailSuccessEnvelope'),
      400: buildJsonResponse('Validation error', '#/components/schemas/ErrorEnvelope'),
      404: buildJsonResponse('Task not found', '#/components/schemas/ErrorEnvelope'),
      500: buildJsonResponse('Internal server error', '#/components/schemas/ErrorEnvelope'),
    },
  },
  'post /api/v2/workflows': {
    requestBody: buildJsonRequestBody('#/components/schemas/WorkflowCreateRequest', true),
    responses: {
      201: buildJsonResponse('Workflow created', {
        oneOf: [
          { $ref: '#/components/schemas/WorkflowDetailSuccessEnvelope' },
          { $ref: '#/components/schemas/WorkflowCreateFallbackEnvelope' },
        ],
      }),
      400: buildJsonResponse('Validation error', '#/components/schemas/ErrorEnvelope'),
      500: buildJsonResponse('Internal server error', '#/components/schemas/ErrorEnvelope'),
    },
  },
  'get /api/v2/workflows/{workflow_id}': {
    responses: {
      200: buildJsonResponse('Workflow detail', '#/components/schemas/WorkflowDetailSuccessEnvelope'),
      404: buildJsonResponse('Workflow not found', '#/components/schemas/ErrorEnvelope'),
      500: buildJsonResponse('Internal server error', '#/components/schemas/ErrorEnvelope'),
    },
  },
};

function buildSuccessEnvelopeSchema(dataSchemaRef) {
  return {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: { $ref: dataSchemaRef },
      meta: { $ref: '#/components/schemas/ResponseMeta' },
    },
  };
}

function buildJsonSchemaRef(schemaRef) {
  if (typeof schemaRef === 'string') {
    return { $ref: schemaRef };
  }

  return schemaRef;
}

function buildJsonResponse(description, schemaRef) {
  return {
    description,
    content: {
      [JSON_CONTENT_TYPE]: {
        schema: buildJsonSchemaRef(schemaRef),
      },
    },
  };
}

function buildJsonRequestBody(schemaRef, required = false) {
  return {
    required,
    content: {
      [JSON_CONTENT_TYPE]: {
        schema: buildJsonSchemaRef(schemaRef),
      },
    },
  };
}

function buildInfoBlock() {
  return {
    title: API_TITLE,
    version: API_VERSION,
    description: API_DESCRIPTION,
  };
}

function buildServerBlock(baseUrl = DEFAULT_SERVER_URL) {
  return [{ url: baseUrl, description: 'Local TORQUE server' }];
}

function getFallbackParamName(index) {
  return index === 0 ? 'id' : `id${index + 1}`;
}

function getRegisteredRoutes() {
  return require('./routes');
}

function pathFromRegex(regexPath, mapParams = []) {
  if (!(regexPath instanceof RegExp)) {
    return regexPath;
  }

  let paramIndex = 0;

  return regexPath.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\((?!\?:)[^)]+\)/g, () => {
      const paramName = mapParams[paramIndex] || getFallbackParamName(paramIndex);
      paramIndex += 1;
      return `{${paramName}}`;
    })
    .replace(/\\\//g, '/')
    .replace(/\?/g, '');
}

function derivePrimaryTag(pathKey) {
  const segments = String(pathKey)
    .split('/')
    .filter(Boolean);

  if (segments[0] === 'api' && segments[1] === 'v2') {
    return segments[2] || 'v2';
  }

  if (segments[0] === 'api') {
    return segments[1] || 'general';
  }

  return segments[0] || 'general';
}

function deriveOperationId(route, pathKey, method) {
  if (route.handlerName) return route.handlerName;
  if (typeof route.handler?.name === 'string' && route.handler.name) return route.handler.name;
  if (route.tool) return route.tool;

  const normalizedPath = String(pathKey)
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `${method}_${normalizedPath || 'route'}`;
}

function buildDefaultResponses() {
  return {
    200: buildJsonResponse('Successful operation', GENERIC_OBJECT_SCHEMA),
    400: { description: 'Bad request' },
    404: { description: 'Not found' },
    500: { description: 'Internal server error' },
  };
}

function buildPathItem(route) {
  const method = (route.method || 'get').toLowerCase();
  const pathKey = pathFromRegex(route.path, route.mapParams);
  const schemaOverride = ROUTE_SCHEMA_OVERRIDES[`${method} ${pathKey}`];
  const operationId = deriveOperationId(route, pathKey, method);
  const operation = {
    operationId,
    summary: route.description || operationId,
    tags: route.tags || [derivePrimaryTag(pathKey)],
    responses: schemaOverride?.responses || buildDefaultResponses(),
  };

  if (schemaOverride?.requestBody) {
    operation.requestBody = schemaOverride.requestBody;
  } else if (['post', 'put', 'patch'].includes(method)) {
    operation.requestBody = buildJsonRequestBody(GENERIC_OBJECT_SCHEMA);
  }

  if (Array.isArray(route.mapParams) && route.mapParams.length > 0) {
    operation.parameters = route.mapParams.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
  }

  if (route.handlerName) {
    operation['x-handler-name'] = route.handlerName;
  }

  if (route.tool) {
    operation['x-tool-name'] = route.tool;
  }

  return { [method]: operation };
}

function normalizeSpecArgs(routeTableOrOptions, maybeOptions) {
  if (Array.isArray(routeTableOrOptions)) {
    return {
      routeTable: routeTableOrOptions,
      options: maybeOptions || {},
    };
  }

  return {
    routeTable: getRegisteredRoutes(),
    options: routeTableOrOptions || {},
  };
}

function generateOpenApiSpec(routeTableOrOptions, maybeOptions) {
  const { routeTable, options } = normalizeSpecArgs(routeTableOrOptions, maybeOptions);
  const baseUrl = options.baseUrl || DEFAULT_SERVER_URL;
  const paths = {};

  for (const route of routeTable) {
    const pathKey = pathFromRegex(route.path, route.mapParams);
    const method = (route.method || 'get').toLowerCase();
    if (!paths[pathKey]) {
      paths[pathKey] = {};
    }

    // OpenAPI can only represent one operation per method/path. Keep the first
    // registered route so the spec matches actual dispatch precedence.
    if (paths[pathKey][method]) {
      continue;
    }

    Object.assign(paths[pathKey], buildPathItem(route));
  }

  return {
    openapi: OPENAPI_VERSION,
    info: buildInfoBlock(),
    servers: buildServerBlock(baseUrl),
    paths,
    components: {
      schemas: COMPONENT_SCHEMAS,
    },
  };
}

module.exports = {
  OPENAPI_VERSION,
  API_TITLE,
  API_VERSION,
  buildInfoBlock,
  buildServerBlock,
  getFallbackParamName,
  pathFromRegex,
  buildPathItem,
  generateOpenApiSpec,
};
