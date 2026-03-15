'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const { MCPPlatform, isPlatformEnabled } = require('../mcp/platform');
const { createCorrelationId, okEnvelope, errorEnvelope } = require('../mcp/envelope');
const { TOOL_CATALOG_V1, listTools, hasTool } = require('../mcp/catalog-v1');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEMA_REGISTRY_PATH = require.resolve('../mcp/schema-registry');

function loadSchemaRegistryModule(options = {}) {
  const source = fs.readFileSync(SCHEMA_REGISTRY_PATH, 'utf8');
  const requireFromModule = createRequire(SCHEMA_REGISTRY_PATH);
  const exportedModule = { exports: {} };
  const fsModule = options.fsModule || requireFromModule('fs');
  const appendedSource = `
module.exports.__testInternals = {
  inferType,
  typeMatches,
  validateObject,
};
`;

  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    `${source}\n${appendedSource}`,
  );

  compiled(
    (specifier) => {
      if (specifier === 'fs') return fsModule;
      return requireFromModule(specifier);
    },
    exportedModule,
    exportedModule.exports,
    SCHEMA_REGISTRY_PATH,
    path.dirname(SCHEMA_REGISTRY_PATH),
  );

  return exportedModule.exports;
}

function createFsMock(overrides = {}) {
  return {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => '{}'),
    ...overrides,
  };
}

describe('mcp/schema-registry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('helper functions', () => {
    it('inferType distinguishes arrays, null, objects, and primitive values', () => {
      const registry = loadSchemaRegistryModule();

      expect(registry.__testInternals.inferType(['x'])).toBe('array');
      expect(registry.__testInternals.inferType(null)).toBe('null');
      expect(registry.__testInternals.inferType({ ok: true })).toBe('object');
      expect(registry.__testInternals.inferType(3.5)).toBe('number');
      expect(registry.__testInternals.inferType(false)).toBe('boolean');
      expect(registry.__testInternals.inferType('value')).toBe('string');
    });

    it('typeMatches accepts integers and rejects decimal numbers', () => {
      const registry = loadSchemaRegistryModule();
      const { typeMatches } = registry.__testInternals;

      expect(typeMatches('integer', 4)).toBe(true);
      expect(typeMatches('integer', -3)).toBe(true);
      expect(typeMatches('integer', 4.25)).toBe(false);
    });

    it('typeMatches only accepts plain objects for object schemas', () => {
      const registry = loadSchemaRegistryModule();
      const { typeMatches } = registry.__testInternals;

      expect(typeMatches('object', { ok: true })).toBe(true);
      expect(typeMatches('object', null)).toBe(false);
      expect(typeMatches('object', [])).toBe(false);
    });

    it('typeMatches handles array and scalar schema types', () => {
      const registry = loadSchemaRegistryModule();
      const { typeMatches } = registry.__testInternals;

      expect(typeMatches('array', [])).toBe(true);
      expect(typeMatches('array', {})).toBe(false);
      expect(typeMatches('string', 'task')).toBe(true);
      expect(typeMatches('boolean', true)).toBe(true);
    });

    it('validateObject reports top-level type mismatches at the provided path prefix', () => {
      const registry = loadSchemaRegistryModule();

      expect(registry.__testInternals.validateObject(
        { type: 'object' },
        'not-an-object',
        '$.payload',
      )).toEqual([
        {
          path: '$.payload',
          message: 'Expected object, got string',
        },
      ]);
    });

    it('validateObject reports missing required properties', () => {
      const registry = loadSchemaRegistryModule();

      expect(registry.__testInternals.validateObject(
        {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
          },
        },
        {},
      )).toContainEqual({
        path: '$.name',
        message: 'Missing required property',
      });
    });

    it('validateObject rejects unknown properties when additionalProperties is false', () => {
      const registry = loadSchemaRegistryModule();

      expect(registry.__testInternals.validateObject(
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          additionalProperties: false,
        },
        { name: 'ok', extra: true },
      )).toContainEqual({
        path: '$.extra',
        message: 'Unknown property is not allowed',
      });
    });

    it('validateObject checks nested property type, minLength, and enum constraints', () => {
      const registry = loadSchemaRegistryModule();

      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2 },
          status: { type: 'string', enum: ['active', 'inactive'] },
          count: { type: 'integer' },
        },
        additionalProperties: false,
      };

      expect(registry.__testInternals.validateObject(schema, {
        name: 'a',
        status: 'archived',
        count: 1.5,
      })).toEqual([
        {
          path: '$.name',
          message: 'Expected minimum length 2',
        },
        {
          path: '$.status',
          message: 'Value must be one of: active, inactive',
        },
        {
          path: '$.count',
          message: 'Expected integer, got number',
        },
      ]);
    });
  });

  describe('schema loading and validation', () => {
    it('returns 0 when the schema directory does not exist', () => {
      const fsMock = createFsMock({
        existsSync: vi.fn(() => false),
      });
      const registry = loadSchemaRegistryModule({ fsModule: fsMock });

      expect(registry.loadSchemas()).toBe(0);
      expect(registry.getLoadedSchemaIds()).toEqual([]);
      expect(fsMock.readdirSync).not.toHaveBeenCalled();
    });

    it('loads only json files and uses the filename stem as the schema id', () => {
      const fsMock = createFsMock({
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['task.json', 'notes.txt', 'workflow.request.schema.json']),
        readFileSync: vi.fn((absolutePath) => {
          if (absolutePath.endsWith('task.json')) return '{"type":"object"}';
          if (absolutePath.endsWith('workflow.request.schema.json')) return '{"type":"object"}';
          throw new Error(`Unexpected file read: ${absolutePath}`);
        }),
      });
      const registry = loadSchemaRegistryModule({ fsModule: fsMock });

      expect(registry.loadSchemas()).toBe(2);
      expect(registry.getLoadedSchemaIds()).toEqual(['task', 'workflow.request.schema']);
      expect(fsMock.readFileSync).toHaveBeenCalledTimes(2);
    });

    it('clears previously loaded schemas on reload', () => {
      const fsMock = createFsMock({
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['first.json']),
        readFileSync: vi.fn(() => '{"type":"object"}'),
      });
      const registry = loadSchemaRegistryModule({ fsModule: fsMock });

      expect(registry.loadSchemas()).toBe(1);
      expect(registry.getLoadedSchemaIds()).toEqual(['first']);

      fsMock.readdirSync.mockReturnValue(['second.json']);

      expect(registry.loadSchemas()).toBe(1);
      expect(registry.getLoadedSchemaIds()).toEqual(['second']);
    });

    it('surfaces JSON parse failures when a schema file is invalid', () => {
      const fsMock = createFsMock({
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['broken.json']),
        readFileSync: vi.fn(() => '{not valid json'),
      });
      const registry = loadSchemaRegistryModule({ fsModule: fsMock });

      expect(() => registry.loadSchemas()).toThrow(SyntaxError);
    });

    it('loads the real schema catalog from disk', () => {
      const registry = loadSchemaRegistryModule();
      const expectedCount = fs.readdirSync(registry.SCHEMA_DIR).filter((file) => file.endsWith('.json')).length;

      expect(registry.loadSchemas()).toBe(expectedCount);
      expect(registry.getLoadedSchemaIds()).toEqual(expect.arrayContaining([
        'torque.task.submit.request.schema',
        'torque.workflow.create.response.schema',
        'torque.stream.poll.request.schema',
      ]));
    });

    it('returns a schema-not-found error for unknown schema ids', () => {
      const registry = loadSchemaRegistryModule();

      expect(registry.validate('missing.schema', {})).toEqual({
        valid: false,
        errors: [{ path: '$', message: 'Schema not found: missing.schema' }],
      });
    });

    it('validates mocked payloads against a loaded schema', () => {
      const fsMock = createFsMock({
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['tool.json']),
        readFileSync: vi.fn(() => JSON.stringify({
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            count: { type: 'integer' },
            status: { type: 'string', enum: ['active', 'inactive'] },
          },
          additionalProperties: false,
        })),
      });
      const registry = loadSchemaRegistryModule({ fsModule: fsMock });

      registry.loadSchemas();

      expect(registry.validate('tool', {
        name: 'alpha',
        count: 3,
        status: 'active',
      })).toEqual({
        valid: true,
        errors: [],
      });
    });

    it('returns accumulated validation errors for mocked schemas', () => {
      const fsMock = createFsMock({
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['tool.json']),
        readFileSync: vi.fn(() => JSON.stringify({
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2 },
            count: { type: 'integer' },
            status: { type: 'string', enum: ['active', 'inactive'] },
          },
          additionalProperties: false,
        })),
      });
      const registry = loadSchemaRegistryModule({ fsModule: fsMock });

      registry.loadSchemas();

      const result = registry.validate('tool', {
        name: 'a',
        count: 1.5,
        status: 'archived',
        extra: true,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        { path: '$.name', message: 'Expected minimum length 2' },
        { path: '$.count', message: 'Expected integer, got number' },
        { path: '$.status', message: 'Value must be one of: active, inactive' },
        { path: '$.extra', message: 'Unknown property is not allowed' },
      ]));
    });

    it('validates a real task submit request payload', () => {
      const registry = loadSchemaRegistryModule();
      registry.loadSchemas();

      expect(registry.validate('torque.task.submit.request.schema', {
        task: 'ship sprint',
        prompt: 'verify release',
        working_directory: 'C:/repo',
        timeout_minutes: 30,
        auto_approve: false,
        priority: 2,
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        idempotency_key: 'abc123',
      })).toEqual({
        valid: true,
        errors: [],
      });
    });

    it('rejects unknown properties for a real task submit request payload', () => {
      const registry = loadSchemaRegistryModule();
      registry.loadSchemas();

      expect(registry.validate('torque.task.submit.request.schema', {
        task: 'ship sprint',
        extra: true,
      })).toEqual({
        valid: false,
        errors: [{ path: '$.extra', message: 'Unknown property is not allowed' }],
      });
    });

    it('rejects type mismatches for a real task submit request payload', () => {
      const registry = loadSchemaRegistryModule();
      registry.loadSchemas();

      expect(registry.validate('torque.task.submit.request.schema', {
        task: 42,
        auto_approve: 'yes',
      })).toEqual({
        valid: false,
        errors: [
          { path: '$.task', message: 'Expected string, got number' },
          { path: '$.auto_approve', message: 'Expected boolean, got string' },
        ],
      });
    });
  });
});

describe('mcp/platform', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('isPlatformEnabled', () => {
    it.each(['1', 'true', ' YES ', 'On'])('treats %j as enabled', (value) => {
      expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: value })).toBe(true);
    });

    it.each([undefined, '', '0', 'false', 'disabled'])('treats %j as disabled', (value) => {
      expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: value })).toBe(false);
    });
  });

  it('uses injected dependencies and starts in a not-ready state', () => {
    const toolRegistry = { registerTool: vi.fn() };
    const telemetry = { recordCall: vi.fn() };
    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
      toolRegistry,
      telemetry,
    });

    expect(platform.toolRegistry).toBe(toolRegistry);
    expect(platform.telemetry).toBe(telemetry);
    expect(platform.isReady()).toBe(false);
  });

  it('init marks the platform ready when the feature flag is enabled', () => {
    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
    });

    expect(platform.init()).toBe(true);
    expect(platform.isReady()).toBe(true);
  });

  it('start delegates to init when the feature flag is enabled', () => {
    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
    });
    const initSpy = vi.spyOn(platform, 'init');

    expect(platform.start()).toBe(true);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(platform.isReady()).toBe(true);
  });

  it('start short-circuits without calling init when the feature flag is disabled', () => {
    const platform = new MCPPlatform({
      env: {},
    });
    const initSpy = vi.spyOn(platform, 'init');

    expect(platform.start()).toBe(false);
    expect(initSpy).not.toHaveBeenCalled();
    expect(platform.isReady()).toBe(false);
  });

  it('isReady requires both an enabled environment and an initialized platform', () => {
    const platform = new MCPPlatform({
      env: {},
    });

    platform._ready = true;

    expect(platform.isReady()).toBe(false);
  });

  it('createCorrelationId returns a uuid string', () => {
    const platform = new MCPPlatform();

    expect(platform.createCorrelationId()).toMatch(UUID_PATTERN);
  });

  it('wrapRequest creates request envelopes with default params and timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:15:30.000Z'));

    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
    });
    const request = platform.wrapRequest('torque.task.get');

    expect(request.id).toMatch(UUID_PATTERN);
    expect(request).toEqual({
      id: request.id,
      tool: 'torque.task.get',
      params: {},
      timestamp: '2026-03-12T10:15:30.000Z',
    });
    expect(platform._requestStarts.get(request.id)).toMatchObject({
      startedAt: Date.parse('2026-03-12T10:15:30.000Z'),
      toolName: 'torque.task.get',
    });
  });

  it('wrapRequest preserves explicitly provided params', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:15:35.000Z'));

    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
    });

    expect(platform.wrapRequest('torque.task.submit', {
      task: 'release',
      priority: 1,
    })).toMatchObject({
      tool: 'torque.task.submit',
      params: {
        task: 'release',
        priority: 1,
      },
      timestamp: '2026-03-12T10:15:35.000Z',
    });
  });

  it('wrapResponse calculates request duration and clears tracked requests', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:16:00.000Z'));

    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
    });
    const request = platform.wrapRequest('torque.task.list', { limit: 10 });

    vi.advanceTimersByTime(42);

    expect(platform.wrapResponse(request.id, { items: [] })).toEqual({
      id: request.id,
      result: { items: [] },
      duration_ms: 42,
      timestamp: '2026-03-12T10:16:00.042Z',
    });
    expect(platform._requestStarts.has(request.id)).toBe(false);
  });

  it('wrapResponse returns zero duration for unknown request ids', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:16:05.000Z'));

    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
    });

    expect(platform.wrapResponse('missing-id', { ok: true })).toEqual({
      id: 'missing-id',
      result: { ok: true },
      duration_ms: 0,
      timestamp: '2026-03-12T10:16:05.000Z',
    });
  });

  it('stop clears readiness and pending requests and returns the enabled status', () => {
    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
    });

    platform.init();
    platform.wrapRequest('torque.task.get', { id: 'task-1' });
    platform.wrapRequest('torque.task.get', { id: 'task-2' });

    expect(platform._requestStarts.size).toBe(2);
    expect(platform.stop()).toBe(true);
    expect(platform.isReady()).toBe(false);
    expect(platform._requestStarts.size).toBe(0);
  });

  it('stop still clears internal state when the platform is disabled', () => {
    const platform = new MCPPlatform({
      env: {},
    });

    platform._ready = true;
    platform._requestStarts.set('stale', {
      startedAt: Date.now(),
      toolName: 'torque.task.get',
    });

    expect(platform.stop()).toBe(false);
    expect(platform._ready).toBe(false);
    expect(platform._requestStarts.size).toBe(0);
  });
});

describe('mcp/envelope', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('createCorrelationId returns unique uuid values', () => {
    const ids = [
      createCorrelationId(),
      createCorrelationId(),
      createCorrelationId(),
    ];

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(UUID_PATTERN);
    }
  });

  it('okEnvelope wraps data with default metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));

    expect(okEnvelope({ tool: 'status' })).toEqual({
      ok: true,
      data: { tool: 'status' },
      metadata: {
        schema_version: 'v1',
        tool_version: 'v1',
        timestamp: '2026-03-12T11:00:00.000Z',
      },
    });
  });

  it('okEnvelope normalizes undefined data to null', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:05.000Z'));

    expect(okEnvelope(undefined)).toEqual({
      ok: true,
      data: null,
      metadata: {
        schema_version: 'v1',
        tool_version: 'v1',
        timestamp: '2026-03-12T11:00:05.000Z',
      },
    });
  });

  it.each([
    ['zero', 0],
    ['false', false],
    ['empty string', ''],
  ])('okEnvelope preserves %s data values', (_label, value) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:10.000Z'));

    expect(okEnvelope(value).data).toBe(value);
  });

  it('okEnvelope allows metadata to override default versions and timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:15.000Z'));

    expect(okEnvelope({ ok: true }, {
      schema_version: 'v2',
      tool_version: 'custom',
      timestamp: 'manual-timestamp',
      correlation_id: 'corr-1',
    })).toEqual({
      ok: true,
      data: { ok: true },
      metadata: {
        schema_version: 'v2',
        tool_version: 'custom',
        timestamp: 'manual-timestamp',
        correlation_id: 'corr-1',
      },
    });
  });

  it('errorEnvelope wraps a complete error payload', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:01:00.000Z'));

    expect(errorEnvelope({
      code: 'BAD_INPUT',
      message: 'Invalid tool arguments',
      retryable: true,
      details: { field: 'tool' },
    })).toEqual({
      ok: false,
      isError: true,
      error: {
        code: 'BAD_INPUT',
        message: 'Invalid tool arguments',
        retryable: true,
        details: { field: 'tool' },
      },
      metadata: {
        schema_version: 'v1',
        tool_version: 'v1',
        timestamp: '2026-03-12T11:01:00.000Z',
      },
    });
  });

  it('errorEnvelope normalizes missing error fields to safe defaults', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:01:05.000Z'));

    expect(errorEnvelope(null)).toEqual({
      ok: false,
      isError: true,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unknown error',
        retryable: false,
        details: null,
      },
      metadata: {
        schema_version: 'v1',
        tool_version: 'v1',
        timestamp: '2026-03-12T11:01:05.000Z',
      },
    });
  });

  it('errorEnvelope coerces retryable to a boolean and defaults details to null', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:01:10.000Z'));

    expect(errorEnvelope({
      code: 'TOO_BUSY',
      message: 'Try again later',
      retryable: 'yes',
    })).toEqual({
      ok: false,
      isError: true,
      error: {
        code: 'TOO_BUSY',
        message: 'Try again later',
        retryable: true,
        details: null,
      },
      metadata: {
        schema_version: 'v1',
        tool_version: 'v1',
        timestamp: '2026-03-12T11:01:10.000Z',
      },
    });
  });

  it('errorEnvelope allows metadata to override defaults', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:01:15.000Z'));

    expect(errorEnvelope({ message: 'boom' }, {
      schema_version: 'v2',
      tool_version: 'custom',
      timestamp: 'manual',
      correlation_id: 'corr-9',
    })).toEqual({
      ok: false,
      isError: true,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'boom',
        retryable: false,
        details: null,
      },
      metadata: {
        schema_version: 'v2',
        tool_version: 'custom',
        timestamp: 'manual',
        correlation_id: 'corr-9',
      },
    });
  });
});

describe('mcp/catalog-v1', () => {
  it('exports a frozen v1 catalog array', () => {
    expect(Object.isFrozen(TOOL_CATALOG_V1)).toBe(true);
  });

  it('listTools returns the shared catalog reference', () => {
    expect(listTools()).toBe(TOOL_CATALOG_V1);
  });

  it('contains unique tool names across the catalog', () => {
    const names = listTools().map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(0);
  });

  it('keeps tool names aligned with their domain and action fields', () => {
    for (const tool of listTools()) {
      expect(tool.name).toBe(`torque.${tool.domain}.${tool.action}`);
      expect(typeof tool.domain).toBe('string');
      expect(typeof tool.action).toBe('string');
      expect(typeof tool.mutation).toBe('boolean');
    }
  });

  it('covers the expected top-level domains', () => {
    expect([...new Set(listTools().map((tool) => tool.domain))]).toEqual([
      'task',
      'workflow',
      'provider',
      'route',
      'policy',
      'audit',
      'telemetry',
      'session',
      'stream',
    ]);
  });

  it('contains both read-only and mutating tools', () => {
    const tools = listTools();

    expect(tools.some((tool) => tool.mutation)).toBe(true);
    expect(tools.some((tool) => !tool.mutation)).toBe(true);
  });

  it.each([
    'torque.task.submit',
    'torque.workflow.retryNode',
    'torque.provider.setDefault',
    'torque.stream.poll',
  ])('hasTool returns true for %s', (toolName) => {
    expect(hasTool(toolName)).toBe(true);
  });

  it.each([
    'torque.task.unknown',
    'TORQUE.task.submit',
    ' torque.task.submit ',
  ])('hasTool returns false for %s', (toolName) => {
    expect(hasTool(toolName)).toBe(false);
  });
});
