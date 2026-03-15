'use strict';

const {
  ToolRegistry,
  cloneSchema,
  inferType,
  typeMatches,
  formatExpectedType,
  normalizeNamespace,
  normalizeToolName,
  validateSchemaNode,
} = require('../mcp/tool-registry');

function buildToolSchema() {
  return {
    type: 'object',
    properties: {
      task: { type: 'string', minLength: 1 },
      retries: { type: 'integer', minimum: 0 },
      tags: {
        type: 'array',
        items: { type: 'string', minLength: 2 },
      },
      metadata: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['manual', 'auto'] },
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
    required: ['task'],
    additionalProperties: false,
  };
}

describe('tool-registry helpers', () => {
  it('cloneSchema returns a deep clone of nested schema objects', () => {
    const schema = buildToolSchema();

    const cloned = cloneSchema(schema);

    expect(cloned).toEqual(schema);
    expect(cloned).not.toBe(schema);
    expect(cloned.properties).not.toBe(schema.properties);
    expect(cloned.properties.tags).not.toBe(schema.properties.tags);
    expect(cloned.properties.tags.items).not.toBe(schema.properties.tags.items);
  });

  it('inferType distinguishes arrays, null, and plain primitives', () => {
    expect(inferType(['a'])).toBe('array');
    expect(inferType(null)).toBe('null');
    expect(inferType(3.5)).toBe('number');
    expect(inferType(true)).toBe('boolean');
    expect(inferType('x')).toBe('string');
  });

  it('typeMatches handles integer, finite number, object, array, and null checks', () => {
    expect(typeMatches('integer', 4)).toBe(true);
    expect(typeMatches('integer', 4.25)).toBe(false);
    expect(typeMatches('number', Infinity)).toBe(false);
    expect(typeMatches('number', 4.25)).toBe(true);
    expect(typeMatches('object', { ok: true })).toBe(true);
    expect(typeMatches('object', null)).toBe(false);
    expect(typeMatches('object', [])).toBe(false);
    expect(typeMatches('array', [])).toBe(true);
    expect(typeMatches('null', null)).toBe(true);
  });

  it('formatExpectedType returns scalar types unchanged and joins unions', () => {
    expect(formatExpectedType('string')).toBe('string');
    expect(formatExpectedType(['string', 'null'])).toBe('string | null');
  });

  it('normalizeNamespace trims whitespace and removes the torque prefix', () => {
    expect(normalizeNamespace(' task ')).toBe('task');
    expect(normalizeNamespace('torque.workflow')).toBe('workflow');
  });

  it('normalizeNamespace rejects empty and unsupported namespaces', () => {
    expect(() => normalizeNamespace('   ')).toThrow('Tool namespace must be a non-empty string');
    expect(() => normalizeNamespace('alerts')).toThrow('Unsupported tool namespace: alerts');
  });

  it('normalizeToolName trims valid names and rejects blank values', () => {
    expect(normalizeToolName(' submit_task ')).toBe('submit_task');
    expect(() => normalizeToolName('')).toThrow('Tool name must be a non-empty string');
  });

  it('validateSchemaNode reports type mismatches with the failing path', () => {
    expect(validateSchemaNode({ type: 'integer' }, 'four', '$')).toEqual([
      { path: '$', message: 'Expected integer, got string' },
    ]);
  });

  it('validateSchemaNode validates nested arrays and nested objects', () => {
    const errors = validateSchemaNode(buildToolSchema(), {
      task: 'ship',
      tags: ['ok', 'x'],
      metadata: { extra: true },
    }, '$');

    expect(errors).toEqual(expect.arrayContaining([
      { path: '$.tags[1]', message: 'Expected minimum length 2' },
      { path: '$.metadata.source', message: 'Missing required property' },
      { path: '$.metadata.extra', message: 'Unknown property is not allowed' },
    ]));
  });

  it('validateSchemaNode validates additionalProperties schema objects', () => {
    const errors = validateSchemaNode({
      type: 'object',
      properties: {},
      additionalProperties: { type: 'number', minimum: 10 },
    }, {
      good: 12,
      low: 3,
      wrongType: 'x',
    }, '$');

    expect(errors).toEqual(expect.arrayContaining([
      { path: '$.low', message: 'Expected minimum value 10' },
      { path: '$.wrongType', message: 'Expected number, got string' },
    ]));
  });
});

describe('ToolRegistry', () => {
  it('registerTool returns the normalized fully qualified tool name', () => {
    const registry = new ToolRegistry();

    const fullName = registry.registerTool(' torque.task ', ' submit ', buildToolSchema(), vi.fn());

    expect(fullName).toBe('torque.task.submit');
  });

  it('registerTool stores a cloned schema and lookupTool returns the handler', () => {
    const registry = new ToolRegistry();
    const schema = buildToolSchema();
    const handler = vi.fn();

    const fullName = registry.registerTool('task', 'submit', schema, handler);
    schema.properties.task.minLength = 99;

    expect(registry.lookupTool(fullName)).toEqual({
      schema: buildToolSchema(),
      handler,
    });
  });

  it('getTool and lookupTool both return fresh schema clones', () => {
    const registry = new ToolRegistry();
    const fullName = registry.registerTool('workflow', 'create', buildToolSchema(), vi.fn());

    const first = registry.lookupTool(fullName);
    first.schema.properties.task.minLength = 99;

    const second = registry.getTool(fullName);

    expect(second.schema.properties.task.minLength).toBe(1);
    expect(second.schema).not.toBe(first.schema);
  });

  it('lookupTool returns null for unknown tools', () => {
    const registry = new ToolRegistry();

    expect(registry.lookupTool('torque.task.missing')).toBeNull();
    expect(registry.getTool('torque.task.missing')).toBeNull();
  });

  it('registerTool rejects invalid schema and handler inputs', () => {
    const registry = new ToolRegistry();

    expect(() => registry.registerTool('task', 'submit', null, vi.fn()))
      .toThrow('Tool schema must be a JSON schema object');
    expect(() => registry.registerTool('task', 'submit', { type: 'object' }, 'nope'))
      .toThrow('Tool handler must be a function');
  });

  it('registerTool rejects duplicate registrations after normalization', () => {
    const registry = new ToolRegistry();
    const originalHandler = vi.fn();
    const replacementHandler = vi.fn();

    registry.registerTool('task', 'submit', buildToolSchema(), originalHandler);

    expect(() => registry.registerTool(' torque.task ', ' submit ', buildToolSchema(), replacementHandler))
      .toThrow('Tool already registered: torque.task.submit');

    expect(registry.lookupTool('torque.task.submit').handler).toBe(originalHandler);
  });

  it('listTools sorts registered tools by full name', () => {
    const registry = new ToolRegistry();

    registry.registerTool('workflow', 'resume', buildToolSchema(), vi.fn());
    registry.registerTool('task', 'submit', buildToolSchema(), vi.fn());
    registry.registerTool('provider', 'listModels', buildToolSchema(), vi.fn());

    expect(registry.listTools().map((tool) => tool.name)).toEqual([
      'torque.provider.listModels',
      'torque.task.submit',
      'torque.workflow.resume',
    ]);
  });

  it('listTools filters by namespace and accepts a torque-prefixed namespace', () => {
    const registry = new ToolRegistry();

    registry.registerTool('task', 'submit', buildToolSchema(), vi.fn());
    registry.registerTool('task', 'cancel', buildToolSchema(), vi.fn());
    registry.registerTool('system', 'health', buildToolSchema(), vi.fn());

    expect(registry.listTools('torque.task').map((tool) => tool.name)).toEqual([
      'torque.task.cancel',
      'torque.task.submit',
    ]);
  });

  it('listTools returns cloned schemas instead of live registry objects', () => {
    const registry = new ToolRegistry();

    registry.registerTool('task', 'submit', buildToolSchema(), vi.fn());

    const [first] = registry.listTools();
    first.schema.properties.task.minLength = 99;

    const [second] = registry.listTools();
    expect(second.schema.properties.task.minLength).toBe(1);
  });

  it('unregisterTool removes an existing tool and returns true', () => {
    const registry = new ToolRegistry();
    const fullName = registry.registerTool('task', 'submit', buildToolSchema(), vi.fn());

    expect(registry.unregisterTool(fullName)).toBe(true);
    expect(registry.lookupTool(fullName)).toBeNull();
  });

  it('unregisterTool returns false for tools that are not registered', () => {
    const registry = new ToolRegistry();

    expect(registry.unregisterTool('torque.task.missing')).toBe(false);
  });

  it('validateParams returns success for payloads that satisfy the schema', () => {
    const registry = new ToolRegistry();
    registry.registerTool('provider', 'setWeight', buildToolSchema(), vi.fn());

    expect(registry.validateParams('torque.provider.setWeight', {
      task: 'ship',
      retries: 0,
      tags: ['ab', 'cd'],
      metadata: { source: 'manual' },
    })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('validateParams returns a not-registered error for unknown tools', () => {
    const registry = new ToolRegistry();

    expect(registry.validateParams('torque.system.health', {})).toEqual({
      valid: false,
      errors: [{ path: '$', message: 'Tool not registered: torque.system.health' }],
    });
  });

  it('validateParams reports missing required, enum, item, and unknown-property failures', () => {
    const registry = new ToolRegistry();
    registry.registerTool('task', 'submit', buildToolSchema(), vi.fn());

    const result = registry.validateParams('torque.task.submit', {
      task: '',
      retries: 1.5,
      tags: ['ok', 'x'],
      metadata: { source: 'script', extra: true },
      extra: 'blocked',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      { path: '$.task', message: 'Expected minimum length 1' },
      { path: '$.retries', message: 'Expected integer, got number' },
      { path: '$.tags[1]', message: 'Expected minimum length 2' },
      { path: '$.metadata.source', message: 'Value must be one of: manual, auto' },
      { path: '$.metadata.extra', message: 'Unknown property is not allowed' },
      { path: '$.extra', message: 'Unknown property is not allowed' },
    ]));
  });
});
