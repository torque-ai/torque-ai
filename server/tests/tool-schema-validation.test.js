'use strict';

/**
 * Unit Tests: Centralized JSON Schema validation in tools.js
 *
 * Tests the validateArgsAgainstSchema function and its integration
 * into the handleToolCall dispatch pipeline.
 *
 * Covers:
 * 1. validateArgsAgainstSchema — required fields, type checks, enum checks
 * 2. Integration — handleToolCall returns errors for invalid args
 * 3. Schema map — all tools with inputSchema are indexed
 * 4. Schema hash change detection helpers
 */

const { validateArgsAgainstSchema, schemaMap, TOOLS, handleToolCall } = require('../tools');
const { hashToolSchema, hashAllToolSchemas, detectChangedTools } = require('../mcp/schema-hash');

// ─── validateArgsAgainstSchema unit tests ──────────────────────────────────

describe('validateArgsAgainstSchema', () => {
  describe('returns null for valid args', () => {
    it('returns null when all required fields are present with correct types', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name'],
      };
      expect(validateArgsAgainstSchema({ name: 'hello', count: 5 }, schema)).toBeNull();
    });

    it('returns null when no required fields and args are empty', () => {
      const schema = {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
        required: [],
      };
      expect(validateArgsAgainstSchema({}, schema)).toBeNull();
    });

    it('returns null for schema without properties', () => {
      const schema = { type: 'object', properties: {} };
      expect(validateArgsAgainstSchema({}, schema)).toBeNull();
    });

    it('returns null for null/missing schema', () => {
      expect(validateArgsAgainstSchema({ foo: 'bar' }, null)).toBeNull();
      expect(validateArgsAgainstSchema({ foo: 'bar' }, undefined)).toBeNull();
    });

    it('returns null for non-object schema type', () => {
      expect(validateArgsAgainstSchema({}, { type: 'string' })).toBeNull();
    });

    it('allows extra fields not in properties', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };
      expect(validateArgsAgainstSchema({ name: 'hello', extra: 123 }, schema)).toBeNull();
    });

    it('skips internal __ prefixed fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };
      // __taskId is not in properties but should not cause type errors
      expect(validateArgsAgainstSchema({ name: 'test', __taskId: 'abc' }, schema)).toBeNull();
    });
  });

  describe('detects missing required fields', () => {
    it('reports a single missing required field', () => {
      const schema = {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
        },
        required: ['task_id'],
      };
      const result = validateArgsAgainstSchema({}, schema);
      expect(result).not.toBeNull();
      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toContain('task_id');
      expect(result.details[0]).toContain('Missing required parameter');
    });

    it('reports multiple missing required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          file_path: { type: 'string', description: 'File path' },
          working_directory: { type: 'string' },
        },
        required: ['task_id', 'file_path', 'working_directory'],
      };
      const result = validateArgsAgainstSchema({}, schema);
      expect(result).not.toBeNull();
      expect(result.details).toHaveLength(3);
      expect(result.message).toContain('3 parameter(s)');
    });

    it('includes field description in error when available', () => {
      const schema = {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to check' },
        },
        required: ['task_id'],
      };
      const result = validateArgsAgainstSchema({}, schema);
      expect(result.details[0]).toContain('Task ID to check');
    });

    it('treats null as missing for required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };
      const result = validateArgsAgainstSchema({ name: null }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('Missing required parameter');
    });

    it('treats undefined as missing for required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };
      const result = validateArgsAgainstSchema({ name: undefined }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('Missing required parameter');
    });
  });

  describe('detects type violations', () => {
    it('rejects number where string expected', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: [],
      };
      const result = validateArgsAgainstSchema({ name: 123 }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('must be of type string');
      expect(result.details[0]).toContain('got number');
    });

    it('rejects string where number expected', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
        required: [],
      };
      const result = validateArgsAgainstSchema({ count: 'five' }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('must be of type number');
    });

    it('rejects string where boolean expected', () => {
      const schema = {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
        },
        required: [],
      };
      const result = validateArgsAgainstSchema({ enabled: 'true' }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('must be of type boolean');
    });

    it('rejects object where array expected', () => {
      const schema = {
        type: 'object',
        properties: {
          items: { type: 'array' },
        },
        required: [],
      };
      const result = validateArgsAgainstSchema({ items: { a: 1 } }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('must be of type array');
    });

    it('rejects array where object expected', () => {
      const schema = {
        type: 'object',
        properties: {
          config: { type: 'object' },
        },
        required: [],
      };
      const result = validateArgsAgainstSchema({ config: [1, 2] }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('must be of type object');
    });

    it('rejects NaN for number type', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
        required: [],
      };
      const result = validateArgsAgainstSchema({ count: NaN }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('must be of type number');
    });

    it('accepts integer type for numbers', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'integer' },
        },
        required: [],
      };
      expect(validateArgsAgainstSchema({ count: 42 }, schema)).toBeNull();
    });

    it('skips type check for null/undefined values', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: [],
      };
      // null/undefined optional fields should not trigger type errors
      expect(validateArgsAgainstSchema({ name: null }, schema)).toBeNull();
      expect(validateArgsAgainstSchema({ name: undefined }, schema)).toBeNull();
    });
  });

  describe('detects enum violations', () => {
    it('rejects value not in enum', () => {
      const schema = {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'running', 'completed'],
          },
        },
        required: [],
      };
      const result = validateArgsAgainstSchema({ status: 'invalid' }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('must be one of');
      expect(result.details[0]).toContain('pending');
      expect(result.details[0]).toContain('running');
      expect(result.details[0]).toContain('completed');
      expect(result.details[0]).toContain('invalid');
    });

    it('accepts value in enum', () => {
      const schema = {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'running', 'completed'],
          },
        },
        required: [],
      };
      expect(validateArgsAgainstSchema({ status: 'running' }, schema)).toBeNull();
    });

    it('validates numeric enums', () => {
      const schema = {
        type: 'object',
        properties: {
          tier: {
            type: 'number',
            enum: [1, 2, 3],
          },
        },
        required: [],
      };
      expect(validateArgsAgainstSchema({ tier: 2 }, schema)).toBeNull();
      const result = validateArgsAgainstSchema({ tier: 4 }, schema);
      expect(result).not.toBeNull();
      expect(result.details[0]).toContain('must be one of');
    });
  });

  describe('combined errors', () => {
    it('reports both missing required and type errors', () => {
      const schema = {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['task_id'],
      };
      const result = validateArgsAgainstSchema({ count: 'not-a-number' }, schema);
      expect(result).not.toBeNull();
      expect(result.details).toHaveLength(2);
      expect(result.message).toContain('2 parameter(s)');
    });
  });

  describe('handles schemas without required array', () => {
    it('returns null when schema has no required field', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        // no required field at all
      };
      expect(validateArgsAgainstSchema({}, schema)).toBeNull();
    });
  });
});

// ─── schemaMap integrity ────────────────────────────────────────────────────

describe('schemaMap', () => {
  it('is a Map', () => {
    expect(schemaMap).toBeInstanceOf(Map);
  });

  it('has entries for tools with inputSchema', () => {
    const toolsWithSchema = TOOLS
      .filter((t) => t && t.name && t.inputSchema)
      .map((tool) => tool.name);
    const schemaToolNames = new Set(toolsWithSchema);
    const missing = toolsWithSchema.filter((name) => !schemaMap.has(name));
    const stale = [...schemaMap.keys()].filter((name) => !schemaToolNames.has(name));

    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('maps tool names to their inputSchema objects', () => {
    for (const tool of TOOLS) {
      if (tool && tool.name && tool.inputSchema) {
        expect(schemaMap.get(tool.name)).toBe(tool.inputSchema);
      }
    }
  });

  it('includes known tools', () => {
    // Spot-check a few tools we know exist
    expect(schemaMap.has('ping')).toBe(true);
    expect(schemaMap.has('configure')).toBe(true);
    expect(schemaMap.has('share_context')).toBe(true);
  });
});

// ─── handleToolCall integration ─────────────────────────────────────────────

describe('handleToolCall schema validation integration', () => {
  it('rejects call with missing required parameters', async () => {
    // share_context requires task_id and content
    const result = await handleToolCall('share_context', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required parameter');
    expect(result.content[0].text).toContain('task_id');
    expect(result.content[0].text).toContain('content');
  });

  it('rejects call with wrong parameter type', async () => {
    // share_context task_id should be string
    const result = await handleToolCall('share_context', {
      task_id: 12345,
      content: 'some context',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be of type string');
  });

  it('rejects call with invalid enum value', async () => {
    // share_context context_type has enum
    const result = await handleToolCall('share_context', {
      task_id: 'test-123',
      content: 'some context',
      context_type: 'invalid_type',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be one of');
  });

  it('allows valid calls through to handler (ping has no required fields)', async () => {
    const result = await handleToolCall('ping', {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pong).toBe(true);
    expect(parsed.timestamp).toBeDefined();
  });

  it('allows valid calls with correct parameters (ping with message)', async () => {
    const result = await handleToolCall('ping', { message: 'hello' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pong).toBe(true);
    expect(parsed.message).toBe('hello');
  });

  it('still throws for unknown tools', async () => {
    await expect(handleToolCall('nonexistent_tool_xyz', {}))
      .rejects.toEqual(expect.objectContaining({ code: -32602, message: 'Unknown tool: nonexistent_tool_xyz' }));
  });

  it('validates sync_files with missing array parameter', async () => {
    // sync_files requires task_id, direction, files (array)
    const result = await handleToolCall('sync_files', {
      task_id: 'test-123',
      direction: 'push',
      // missing files
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('files');
  });

  it('validates type errors for array parameters', async () => {
    const result = await handleToolCall('sync_files', {
      task_id: 'test-123',
      direction: 'push',
      files: 'not-an-array',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be of type array');
  });

  it('validates enum constraints on direction field', async () => {
    const result = await handleToolCall('sync_files', {
      task_id: 'test-123',
      direction: 'sideways',
      files: ['file.txt'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be one of');
    expect(result.content[0].text).toContain('push');
    expect(result.content[0].text).toContain('pull');
  });
});

// ─── schema hash functions ──────────────────────────────────────────────────

describe('schema hash functions', () => {
  describe('hashToolSchema', () => {
    it('generates stable hashes for equivalent schemas with identical content', () => {
      const schemaA = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name'],
      };
      const schemaB = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name'],
      };

      const hashA = hashToolSchema({ name: 'test', inputSchema: schemaA });
      const hashB = hashToolSchema({ name: 'test', inputSchema: schemaB });

      expect(hashA).toBe(hashB);
      expect(hashA).toMatch(/^[a-f0-9]{16}$/);
    });

    it('generates different hashes for different schemas', () => {
      const stringSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };
      const numberSchema = {
        type: 'object',
        properties: {
          name: { type: 'number' },
        },
        required: ['name'],
      };

      expect(hashToolSchema({ name: 'same_tool', inputSchema: stringSchema }))
        .not.toBe(hashToolSchema({ name: 'same_tool', inputSchema: numberSchema }));
    });

    it('handles empty schemas as hashable schema content', () => {
      const emptyHash = hashToolSchema({ name: 'empty', inputSchema: {} });

      expect(emptyHash).toBe(hashToolSchema({ name: 'another_empty', inputSchema: {} }));
      expect(emptyHash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('handles null and undefined schemas as empty schema content', () => {
      const emptyHash = hashToolSchema({ name: 'empty', inputSchema: {} });

      expect(hashToolSchema({ name: 'null_schema', inputSchema: null })).toBe(emptyHash);
      expect(hashToolSchema({ name: 'undefined_schema', inputSchema: undefined })).toBe(emptyHash);
      expect(hashToolSchema({ name: 'missing_schema' })).toBe(emptyHash);
    });
  });

  describe('hashAllToolSchemas', () => {
    it('generates named hashes for multiple tools', () => {
      const tools = [
        { name: 'tool1', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
        { name: 'tool2', inputSchema: { type: 'object', properties: { b: { type: 'number' } } } },
        { name: 'tool3', inputSchema: null },
      ];

      const hashes = hashAllToolSchemas(tools);

      expect(hashes).toEqual({
        tool1: hashToolSchema(tools[0]),
        tool2: hashToolSchema(tools[1]),
        tool3: hashToolSchema(tools[2]),
      });
      expect(Object.values(hashes)).toEqual([
        expect.stringMatching(/^[a-f0-9]{16}$/),
        expect.stringMatching(/^[a-f0-9]{16}$/),
        expect.stringMatching(/^[a-f0-9]{16}$/),
      ]);
    });

    it('produces consistent results across calls', () => {
      const tools = [
        { name: 'tool1', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
        { name: 'tool2', inputSchema: { type: 'object', properties: { b: { type: 'number' } } } },
      ];

      const hashes1 = hashAllToolSchemas(tools);
      const hashes2 = hashAllToolSchemas(tools);

      expect(hashes1).toEqual(hashes2);
    });

    it('handles tools without inputSchema', () => {
      const tools = [
        { name: 'tool1', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
        { name: 'tool2' },
      ];

      const hashes = hashAllToolSchemas(tools);

      expect(Object.keys(hashes)).toEqual(['tool1', 'tool2']);
      expect(hashes.tool2).toBe(hashToolSchema({ name: 'empty_schema', inputSchema: {} }));
    });
  });

  describe('detectChangedTools', () => {
    it('detects added tools correctly', () => {
      const previous = { tool1: 'hash1' };
      const current = { tool1: 'hash1', tool2: 'hash2' };

      const result = detectChangedTools(previous, current);

      expect(result.added).toEqual(['tool2']);
      expect(result.changed).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.hasChanges).toBe(true);
    });

    it('detects changed tools correctly', () => {
      const previous = { tool1: 'hash1', tool2: 'hash2' };
      const current = { tool1: 'hash1', tool2: 'hash3' };

      const result = detectChangedTools(previous, current);

      expect(result.added).toEqual([]);
      expect(result.changed).toEqual(['tool2']);
      expect(result.removed).toEqual([]);
      expect(result.hasChanges).toBe(true);
    });

    it('detects removed tools correctly', () => {
      const previous = { tool1: 'hash1', tool2: 'hash2' };
      const current = { tool1: 'hash1' };

      const result = detectChangedTools(previous, current);

      expect(result.added).toEqual([]);
      expect(result.changed).toEqual([]);
      expect(result.removed).toEqual(['tool2']);
      expect(result.hasChanges).toBe(true);
    });

    it('detects multiple changes correctly', () => {
      const previous = { tool1: 'hash1', tool2: 'hash2', tool3: 'hash3' };
      const current = { tool1: 'hash1', tool2: 'hash4', tool4: 'hash5' };

      const result = detectChangedTools(previous, current);

      expect(result.added).toEqual(['tool4']);
      expect(result.changed).toEqual(['tool2']);
      expect(result.removed).toEqual(['tool3']);
      expect(result.hasChanges).toBe(true);
    });

    it('reports no changes when hashes are identical', () => {
      const result = detectChangedTools(
        { tool1: 'hash1', tool2: 'hash2' },
        { tool1: 'hash1', tool2: 'hash2' }
      );

      expect(result.added).toEqual([]);
      expect(result.changed).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.hasChanges).toBe(false);
    });

    it('handles empty comparisons correctly', () => {
      const result1 = detectChangedTools({}, {});
      expect(result1.added).toEqual([]);
      expect(result1.changed).toEqual([]);
      expect(result1.removed).toEqual([]);
      expect(result1.hasChanges).toBe(false);

      const result2 = detectChangedTools({}, { tool1: 'hash1' });
      expect(result2.added).toEqual(['tool1']);
      expect(result2.changed).toEqual([]);
      expect(result2.removed).toEqual([]);
      expect(result2.hasChanges).toBe(true);

      const result3 = detectChangedTools({ tool1: 'hash1' }, {});
      expect(result3.added).toEqual([]);
      expect(result3.changed).toEqual([]);
      expect(result3.removed).toEqual(['tool1']);
      expect(result3.hasChanges).toBe(true);
    });
  });
});
