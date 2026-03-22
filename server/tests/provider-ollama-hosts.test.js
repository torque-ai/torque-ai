/**
 * Tests for provider-ollama-hosts handlers.
 * Uses real database like host-management.test.js.
 */
const { setupTestDbModule, teardownTestDb } = require('./vitest-setup');

let db, mod;

function setup() {
  ({ db, mod } = setupTestDbModule('../handlers/provider-ollama-hosts', 'ollama-hosts'));
}

function teardown() {
  teardownTestDb();
}

describe('provider-ollama-hosts handlers', () => {
  beforeAll(() => setup());
  afterAll(() => teardown());

  describe('handleListOllamaHosts', () => {
    it('returns host list (may be empty)', () => {
      const result = mod.handleListOllamaHosts({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeDefined();
    });
  });

  describe('handleAddOllamaHost', () => {
    it('returns error when name is missing', () => {
      const result = mod.handleAddOllamaHost({});
      expect(result.isError).toBe(true);
    });

    it('returns error when url is missing', () => {
      const result = mod.handleAddOllamaHost({ name: 'NewHost' });
      expect(result.isError).toBe(true);
    });

    it('adds host with valid params', () => {
      const result = mod.handleAddOllamaHost({
        name: 'TestHost1',
        url: 'http://192.0.2.50:11434',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('TestHost1');
    });
  });

  describe('handleRemoveOllamaHost', () => {
    it('returns error when host_id is missing', () => {
      const result = mod.handleRemoveOllamaHost({});
      expect(result.isError).toBe(true);
    });
  });

  describe('handleCleanupNullIdHosts', () => {
    it('returns success', () => {
      const result = mod.handleCleanupNullIdHosts({});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('handleEnableOllamaHost', () => {
    it('returns error when host_id is missing', () => {
      const result = mod.handleEnableOllamaHost({});
      expect(result.isError).toBe(true);
    });
  });

  describe('handleDisableOllamaHost', () => {
    it('returns error when host_id is missing', () => {
      const result = mod.handleDisableOllamaHost({});
      expect(result.isError).toBe(true);
    });
  });

  describe('handleSetHostMemoryLimit', () => {
    it('returns error when host_id is missing', () => {
      const result = mod.handleSetHostMemoryLimit({});
      expect(result.isError).toBe(true);
    });

    it('returns error when memory_limit_mb is missing', () => {
      const result = mod.handleSetHostMemoryLimit({ host_id: 'x' });
      expect(result.isError).toBe(true);
    });
  });

  describe('handleSetHostMaxConcurrent', () => {
    it('returns error when host_id is missing', () => {
      const result = mod.handleSetHostMaxConcurrent({});
      expect(result.isError).toBe(true);
    });

    it('returns error when max_concurrent is missing', () => {
      const result = mod.handleSetHostMaxConcurrent({ host_id: 'x' });
      expect(result.isError).toBe(true);
    });
  });

  describe('handleGetHostCapacity', () => {
    it('returns capacity info', () => {
      const result = mod.handleGetHostCapacity({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeDefined();
    });
  });

  describe('handleGetHostSettings', () => {
    it('returns error message when host_id is missing', () => {
      const result = mod.handleGetHostSettings({});
      expect(result.content[0].text).toContain('host_id is required');
    });
  });

  describe('handleSetHostSettings', () => {
    it('returns error message when host_id is missing', () => {
      const result = mod.handleSetHostSettings({});
      expect(result.content[0].text).toContain('host_id is required');
    });
  });

  describe('handleGetDiscoveryStatus', () => {
    it('returns discovery status', () => {
      const result = mod.handleGetDiscoveryStatus({});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('handleConfigureAutoScan', () => {
    it('updates auto scan settings', () => {
      const result = mod.handleConfigureAutoScan({ enabled: true, interval_minutes: 60 });
      expect(result.isError).toBeFalsy();
    });
  });
});
