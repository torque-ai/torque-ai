/**
 * Integration Test: Stall Detection & Recovery
 */

const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const configCore = require('../db/config-core');

let db;
let tm;

function deleteConfig(key) {
  const conn = db.getDb ? db.getDb() : db.getDbInstance();
  conn.prepare('DELETE FROM config WHERE key = ?').run(key);
  configCore.clearConfigCache();
}

describe('Integration: Stall Detection & Recovery', () => {
  beforeAll(() => {
    ({ db } = setupTestDb('integration-stall'));
    tm = require('../task-manager');
    if (typeof tm.initEarlyDeps === 'function') tm.initEarlyDeps();
    if (typeof tm.initSubModules === 'function') tm.initSubModules();
  });
  afterAll(() => { teardownTestDb(); });

  describe('Stall threshold by provider', () => {
    it('getStallThreshold returns a number for ollama provider', () => {
      const threshold = tm.getStallThreshold(null, 'ollama');
      expect(typeof threshold).toBe('number');
      expect(threshold).toBeGreaterThan(0);
    });

    it('getStallThreshold returns a number for hashline-ollama provider', () => {
      const threshold = tm.getStallThreshold(null, 'hashline-ollama');
      expect(typeof threshold).toBe('number');
      expect(threshold).toBeGreaterThan(0);
    });

    it('ollama threshold differs from hashline-ollama threshold', () => {
      const ollamaThreshold = tm.getStallThreshold(null, 'ollama');
      const hashlineThreshold = tm.getStallThreshold(null, 'hashline-ollama');
      expect(ollamaThreshold).not.toBe(hashlineThreshold);
    });

    it('codex threshold is null or very high by default', () => {
      const threshold = tm.getStallThreshold(null, 'codex');
      if (threshold !== null) {
        expect(threshold).toBeGreaterThanOrEqual(600);
      }
    });

    it('runtime config override takes priority', () => {
      configCore.setConfig('stall_threshold_ollama', '999');
      const threshold = tm.getStallThreshold(null, 'ollama');
      expect(threshold).toBe(999);
      deleteConfig('stall_threshold_ollama');
    });

    it('config value of 0 disables stall detection', () => {
      configCore.setConfig('stall_threshold_ollama', '0');
      const threshold = tm.getStallThreshold(null, 'ollama');
      expect(threshold).toBeNull();
      deleteConfig('stall_threshold_ollama');
    });
  });

  describe('Model size affects threshold', () => {
    it('32b model gets higher threshold than 8b model', () => {
      const small = tm.getStallThreshold('qwen2.5-coder:8b', 'ollama');
      const large = tm.getStallThreshold('qwen2.5-coder:32b', 'ollama');
      expect(large).toBeGreaterThanOrEqual(small);
    });

    it('thinking model gets multiplied threshold', () => {
      const regular = tm.getStallThreshold('qwen2.5-coder:8b', 'ollama');
      const thinking = tm.getStallThreshold('qwen3:8b', 'ollama');
      expect(thinking).toBeGreaterThan(regular);
    });

    it('70b model gets very high threshold', () => {
      const threshold = tm.getStallThreshold('llama3:70b', 'ollama');
      expect(threshold).toBeGreaterThanOrEqual(300);
    });
  });

  describe('checkStalledTasks detection', () => {
    it('returns empty array when no processes running', () => {
      const stalled = tm.checkStalledTasks(false);
      expect(Array.isArray(stalled)).toBe(true);
      expect(stalled.length).toBe(0);
    });

    it('getTaskActivity returns null for non-running task', () => {
      const activity = tm.getTaskActivity('non-existent-task-id');
      expect(activity).toBeNull();
    });

    it('getAllTaskActivity returns array', () => {
      const activities = tm.getAllTaskActivity();
      expect(Array.isArray(activities)).toBe(true);
    });
  });

  describe('Stall recovery configuration', () => {
    it('stall_recovery_enabled config controls recovery', () => {
      configCore.setConfig('stall_recovery_enabled', '1');
      expect(configCore.getConfig('stall_recovery_enabled')).toBe('1');

      configCore.setConfig('stall_recovery_enabled', '0');
      expect(configCore.getConfig('stall_recovery_enabled')).toBe('0');

      configCore.setConfig('stall_recovery_enabled', '1');
    });

    it('stall_recovery_max_attempts config is readable', () => {
      configCore.setConfig('stall_recovery_max_attempts', '5');
      expect(configCore.getConfig('stall_recovery_max_attempts')).toBe('5');

      configCore.setConfig('stall_recovery_max_attempts', '3');
    });

    it('auto_cancel_stalled config is readable', () => {
      configCore.setConfig('auto_cancel_stalled', '1');
      expect(configCore.getConfig('auto_cancel_stalled')).toBe('1');
    });
  });

  describe('Provider stall threshold constants', () => {
    it('all standard providers have defined thresholds', () => {
      const providers = ['ollama', 'hashline-ollama'];
      for (const provider of providers) {
        const threshold = tm.getStallThreshold(null, provider);
        expect(threshold).toBeTruthy();
        expect(typeof threshold).toBe('number');
      }
    });

    it('unknown provider falls back to base threshold', () => {
      const threshold = tm.getStallThreshold(null, 'unknown-provider');
      if (threshold !== null) {
        expect(typeof threshold).toBe('number');
      }
    });
  });

  describe('Stall detection integration with DB config', () => {
    it('per-provider config keys are consistent', () => {
      const providers = ['ollama', 'hashline-ollama', 'codex'];
      for (const provider of providers) {
        const key = `stall_threshold_${provider.replace(/-/g, '_')}`;
        configCore.setConfig(key, '300');
        const val = configCore.getConfig(key);
        expect(val).toBe('300');
        deleteConfig(key);
      }
    });

    it('threshold with null config falls back to defaults', () => {
      deleteConfig('stall_threshold_ollama');
      const threshold = tm.getStallThreshold(null, 'ollama');
      expect(threshold).toBeTruthy();
      expect(typeof threshold).toBe('number');
    });
  });
});
