/**
 * Tests for provider-ollama-hosts handlers.
 * Uses real database like host-management.test.js.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

let testDir, origDataDir, db, handlers;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-ollama-hosts-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  // Clear module cache for fresh instances
  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  handlers = require('../handlers/provider-ollama-hosts');
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
    else delete process.env.TORQUE_DATA_DIR;
  }
}

describe('provider-ollama-hosts handlers', () => {
  beforeAll(() => setup());
  afterAll(() => teardown());

  describe('handleListOllamaHosts', () => {
    it('returns host list (may be empty)', () => {
      const result = handlers.handleListOllamaHosts({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeDefined();
    });
  });

  describe('handleAddOllamaHost', () => {
    it('returns error when name is missing', () => {
      const result = handlers.handleAddOllamaHost({});
      expect(result.isError).toBe(true);
    });

    it('returns error when url is missing', () => {
      const result = handlers.handleAddOllamaHost({ name: 'NewHost' });
      expect(result.isError).toBe(true);
    });

    it('adds host with valid params', () => {
      const result = handlers.handleAddOllamaHost({
        name: 'TestHost1',
        url: 'http://192.168.1.50:11434',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('TestHost1');
    });
  });

  describe('handleRemoveOllamaHost', () => {
    it('returns error when host_id is missing', () => {
      const result = handlers.handleRemoveOllamaHost({});
      expect(result.isError).toBe(true);
    });
  });

  describe('handleCleanupNullIdHosts', () => {
    it('returns success', () => {
      const result = handlers.handleCleanupNullIdHosts({});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('handleEnableOllamaHost', () => {
    it('returns error when host_id is missing', () => {
      const result = handlers.handleEnableOllamaHost({});
      expect(result.isError).toBe(true);
    });
  });

  describe('handleDisableOllamaHost', () => {
    it('returns error when host_id is missing', () => {
      const result = handlers.handleDisableOllamaHost({});
      expect(result.isError).toBe(true);
    });
  });

  describe('handleSetHostMemoryLimit', () => {
    it('returns error when host_id is missing', () => {
      const result = handlers.handleSetHostMemoryLimit({});
      expect(result.isError).toBe(true);
    });

    it('returns error when memory_limit_mb is missing', () => {
      const result = handlers.handleSetHostMemoryLimit({ host_id: 'x' });
      expect(result.isError).toBe(true);
    });
  });

  describe('handleSetHostMaxConcurrent', () => {
    it('returns error when host_id is missing', () => {
      const result = handlers.handleSetHostMaxConcurrent({});
      expect(result.isError).toBe(true);
    });

    it('returns error when max_concurrent is missing', () => {
      const result = handlers.handleSetHostMaxConcurrent({ host_id: 'x' });
      expect(result.isError).toBe(true);
    });
  });

  describe('handleGetHostCapacity', () => {
    it('returns capacity info', () => {
      const result = handlers.handleGetHostCapacity({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeDefined();
    });
  });

  describe('handleGetHostSettings', () => {
    it('returns error message when host_id is missing', () => {
      const result = handlers.handleGetHostSettings({});
      expect(result.content[0].text).toContain('host_id is required');
    });
  });

  describe('handleSetHostSettings', () => {
    it('returns error message when host_id is missing', () => {
      const result = handlers.handleSetHostSettings({});
      expect(result.content[0].text).toContain('host_id is required');
    });
  });

  describe('handleGetDiscoveryStatus', () => {
    it('returns discovery status', () => {
      const result = handlers.handleGetDiscoveryStatus({});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('handleConfigureAutoScan', () => {
    it('updates auto scan settings', () => {
      const result = handlers.handleConfigureAutoScan({ enabled: true, interval_minutes: 60 });
      expect(result.isError).toBeFalsy();
    });
  });
});
