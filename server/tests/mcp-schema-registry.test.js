'use strict';

// Install fs mock via require.cache before loading schema-registry
const fsMock = {
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => '{}'),
};

function installFsMock() {
  const resolved = require.resolve('fs');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: fsMock,
  };
}

installFsMock();
const registry = require('../mcp/schema-registry');

describe('mcp/schema-registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readdirSync.mockReturnValue([]);
    fsMock.readFileSync.mockReturnValue('{}');
  });

  describe('loadSchemas', () => {
    it('returns 0 when schema dir does not exist', () => {
      fsMock.existsSync.mockReturnValue(false);
      expect(registry.loadSchemas()).toBe(0);
    });

    it('loads .json files and ignores non-json', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(['task.json', 'notes.txt', 'workflow.json']);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ type: 'object' }));

      const count = registry.loadSchemas();
      expect(count).toBe(2);
      // readFileSync called once per .json file
      expect(fsMock.readFileSync).toHaveBeenCalledTimes(2);
    });

    it('clears previous schemas on reload', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(['a.json']);
      fsMock.readFileSync.mockReturnValue('{"type":"object"}');
      registry.loadSchemas();
      expect(registry.getLoadedSchemaIds()).toEqual(['a']);

      fsMock.readdirSync.mockReturnValue(['b.json']);
      registry.loadSchemas();
      expect(registry.getLoadedSchemaIds()).toEqual(['b']);
    });
  });

  describe('getLoadedSchemaIds', () => {
    it('returns empty array when no schemas loaded', () => {
      registry.loadSchemas(); // dir doesn't exist
      expect(registry.getLoadedSchemaIds()).toEqual([]);
    });

    it('returns schema ids (filenames without .json)', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(['task.submit.request.schema.json']);
      fsMock.readFileSync.mockReturnValue('{"type":"object"}');
      registry.loadSchemas();
      expect(registry.getLoadedSchemaIds()).toEqual(['task.submit.request.schema']);
    });
  });

  describe('validate', () => {
    beforeEach(() => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(['test.json']);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          count: { type: 'integer' },
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
        additionalProperties: false,
      }));
      registry.loadSchemas();
    });

    it('returns valid:false for unknown schema', () => {
      const result = registry.validate('nonexistent', {});
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Schema not found');
    });

    it('returns valid:true for valid payload', () => {
      const result = registry.validate('test', { name: 'hello' });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('detects missing required properties', () => {
      const result = registry.validate('test', {});
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: '$.name', message: 'Missing required property' })
      );
    });

    it('detects type mismatches', () => {
      const result = registry.validate('test', { name: 123 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: '$.name', message: expect.stringContaining('Expected string') })
      );
    });

    it('detects integer type requirement', () => {
      const result = registry.validate('test', { name: 'ok', count: 1.5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: '$.count' })
      );
    });

    it('validates enum values', () => {
      const result = registry.validate('test', { name: 'ok', status: 'deleted' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: '$.status', message: expect.stringContaining('must be one of') })
      );
    });

    it('detects additional properties when additionalProperties is false', () => {
      const result = registry.validate('test', { name: 'ok', extra: true });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: '$.extra', message: expect.stringContaining('not allowed') })
      );
    });

    it('validates minLength for strings', () => {
      const result = registry.validate('test', { name: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: '$.name', message: expect.stringContaining('minimum length') })
      );
    });

    it('detects wrong top-level type', () => {
      const result = registry.validate('test', 'not-an-object');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Expected object');
    });
  });

  describe('SCHEMA_DIR', () => {
    it('exports the schema directory path', () => {
      expect(registry.SCHEMA_DIR).toContain('schemas');
      expect(registry.SCHEMA_DIR).toContain('v1');
    });
  });
});
