'use strict';

const { filterToolsBrief, filterToolsFull } = require('../mcp/tool-list-modes');
const { hashToolSchema, hashAllToolSchemas, detectChangedTools } = require('../mcp/schema-hash');

function buildMockTools() {
  return [
    {
      name: 'tool.one',
      description: 'Short description',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    },
    {
      name: 'tool.two',
      description: 'a'.repeat(130),
      inputSchema: { type: 'object', properties: { b: { type: 'number' } } },
    },
    {
      name: 'tool.three',
      description: 'Exact fit ' + 'b'.repeat(110),
      inputSchema: { type: 'object', properties: { c: { type: 'boolean' } } },
    },
    {
      name: 'tool.four',
      description: '',
      inputSchema: { type: 'object', properties: {} },
      mutation: true,
    },
  ];
}

function getToolSchemaByName(tools, toolName) {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return { error: `Tool not found: ${toolName}` };
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

describe('tool-list-modes', () => {
  it('filterToolsBrief returns only name and truncated description', () => {
    const tools = buildMockTools();
    const brief = filterToolsBrief(tools);

    expect(brief).toHaveLength(4);
    expect(brief[0]).toEqual({ name: 'tool.one', description: 'Short description' });
    expect(brief[1]).toEqual({ name: 'tool.two', description: 'a'.repeat(117) + '...' });
    expect(brief[3]).toEqual({ name: 'tool.four', description: '' });

    expect(Object.keys(brief[0])).toHaveLength(2);
    expect(Object.keys(brief[0])).toContain('name');
    expect(Object.keys(brief[0])).toContain('description');
    expect(Object.keys(brief[1])).toHaveLength(2);
    expect(Object.keys(brief[2])).not.toContain('inputSchema');
  });

  it('filterToolsFull returns all fields including inputSchema', () => {
    const tools = buildMockTools();
    const full = filterToolsFull(tools);

    expect(full).toEqual(tools);
    expect(full[0]).toHaveProperty('inputSchema');
    expect(full[3]).toHaveProperty('mutation', true);
    expect(full[0]).toHaveProperty('name', 'tool.one');
    expect(full[0]).toHaveProperty('description', 'Short description');
  });

  it('adds truncation at 120 chars with ... suffix', () => {
    const tools = buildMockTools();
    const brief = filterToolsBrief(tools);

    expect(brief[1].description.length).toBe(120);
    expect(brief[1].description.endsWith('...')).toBe(true);
    expect(brief[1].description).toBe('a'.repeat(117) + '...');
  });

  it('does not truncate short descriptions', () => {
    const shortDescription = 'Short description';
    const tools = [{ name: 'tool.short', description: shortDescription, inputSchema: {} }];
    const brief = filterToolsBrief(tools);

    expect(brief).toHaveLength(1);
    expect(brief[0].description).toBe(shortDescription);
    expect(brief[0].description.length).toBe(shortDescription.length);
  });

  it('hashToolSchema returns consistent 16-char hex hash', () => {
    const tool = { name: 'tool.one', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } };
    const hash = hashToolSchema(tool);

    expect(hashToolSchema(tool)).toBe(hash);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashAllToolSchemas returns map of tool name -> hash', () => {
    const tools = buildMockTools();
    const hashes = hashAllToolSchemas(tools);

    expect(hashes).toEqual({
      'tool.one': hashToolSchema(tools[0]),
      'tool.two': hashToolSchema(tools[1]),
      'tool.three': hashToolSchema(tools[2]),
      'tool.four': hashToolSchema(tools[3]),
    });
  });

  it('detectChangedTools finds added tools', () => {
    const previousHashes = hashAllToolSchemas([buildMockTools()[0]]);
    const currentHashes = hashAllToolSchemas(buildMockTools());

    const changes = detectChangedTools(previousHashes, currentHashes);

    expect(changes.changed).toEqual([]);
    expect(changes.added).toEqual(['tool.two', 'tool.three', 'tool.four']);
    expect(changes.removed).toEqual([]);
    expect(changes.hasChanges).toBe(true);
  });

  it('detectChangedTools finds removed tools', () => {
    const tools = buildMockTools();
    const previousHashes = hashAllToolSchemas(tools);
    const currentHashes = hashAllToolSchemas([tools[0], tools[1], tools[2]]);

    const changes = detectChangedTools(previousHashes, currentHashes);

    expect(changes.changed).toEqual([]);
    expect(changes.added).toEqual([]);
    expect(changes.removed).toEqual(['tool.four']);
    expect(changes.hasChanges).toBe(true);
  });

  it('detectChangedTools finds changed schemas', () => {
    const previousTools = buildMockTools();
    const currentTools = [
      previousTools[0],
      { name: 'tool.two', description: previousTools[1].description, inputSchema: { type: 'object', properties: { b: { type: 'string' } } } },
      previousTools[2],
      previousTools[3],
    ];

    const previousHashes = hashAllToolSchemas(previousTools);
    const currentHashes = hashAllToolSchemas(currentTools);

    expect(detectChangedTools(previousHashes, currentHashes)).toEqual({
      changed: ['tool.two'],
      added: [],
      removed: [],
      hasChanges: true,
    });
  });

  it('detectChangedTools returns hasChanges: false when identical', () => {
    const previousHashes = hashAllToolSchemas(buildMockTools());
    const currentHashes = hashAllToolSchemas(buildMockTools());

    expect(detectChangedTools(previousHashes, currentHashes)).toEqual({
      changed: [],
      added: [],
      removed: [],
      hasChanges: false,
    });
  });

  it('get_tool_schema returns full schema for known tool', () => {
    const tools = buildMockTools();
    const schema = getToolSchemaByName(tools, 'tool.two');

    expect(schema).toEqual({
      name: 'tool.two',
      description: 'a'.repeat(130),
      inputSchema: { type: 'object', properties: { b: { type: 'number' } } },
    });
  });

  it('get_tool_schema returns error for unknown tool', () => {
    const schema = getToolSchemaByName(buildMockTools(), 'tool.missing');

    expect(schema).toEqual({
      error: 'Tool not found: tool.missing',
    });
  });
});
