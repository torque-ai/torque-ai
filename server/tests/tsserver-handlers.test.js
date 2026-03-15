/**
 * Unit Tests: handlers/tsserver-handlers.js
 *
 * Tests the MCP handler functions with mocked tsserver client.
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('tsserver Handlers', () => {
  beforeAll(() => {
    setupTestDb('tsserver-handlers');
  });
  afterAll(() => {
    teardownTestDb();
  });

  describe('tsserver_status', () => {
    it('reports disabled when tsserver_enabled is not set', async () => {
      const result = await safeTool('tsserver_status', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('tsserver');
    });

    it('returns valid response structure', async () => {
      const result = await safeTool('tsserver_status', {});
      expect(result).toBeTruthy();
      expect(result.content).toBeTruthy();
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('tsserver_diagnostics', () => {
    it('returns error when disabled', async () => {
      const result = await safeTool('tsserver_diagnostics', {
        working_directory: '/tmp/test',
        file_paths: ['/tmp/test/foo.ts']
      });
      const text = getText(result);
      expect(text).toContain('disabled');
    });

    it('returns error when missing required args', async () => {
      const result = await safeTool('tsserver_diagnostics', {});
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain('required');
    });

    it('returns error with empty file_paths', async () => {
      const result = await safeTool('tsserver_diagnostics', {
        working_directory: '/tmp/test',
        file_paths: []
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('tsserver_quickinfo', () => {
    it('returns error when disabled', async () => {
      const result = await safeTool('tsserver_quickinfo', {
        working_directory: '/tmp/test',
        file_path: '/tmp/test/foo.ts',
        line: 1,
        offset: 1
      });
      const text = getText(result);
      expect(text).toContain('disabled');
    });

    it('returns error when missing required args', async () => {
      const result = await safeTool('tsserver_quickinfo', {
        working_directory: '/tmp/test'
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('tsserver_definition', () => {
    it('returns error when disabled', async () => {
      const result = await safeTool('tsserver_definition', {
        working_directory: '/tmp/test',
        file_path: '/tmp/test/foo.ts',
        line: 1,
        offset: 1
      });
      const text = getText(result);
      expect(text).toContain('disabled');
    });

    it('returns error when missing required args', async () => {
      const result = await safeTool('tsserver_definition', {
        working_directory: '/tmp/test'
      });
      expect(result.isError).toBe(true);
    });
  });
});
