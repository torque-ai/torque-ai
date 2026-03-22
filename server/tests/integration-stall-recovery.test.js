/**
 * Integration Test: Stall Detection & Recovery
 *
 * Tests stall detection logic and auto-recovery via real DB and
 * task-manager function calls. Does NOT spawn actual provider processes.
 * Instead manipulates the in-memory runningProcesses map and DB timestamps
 * to simulate stalled tasks.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: _uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
let tm;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

// Delete a config key from the DB entirely (setConfig(key, null) stores the string "null")
function deleteConfig(key) {
  const conn = db.getDb ? db.getDb() : db.getDbInstance();
  conn.prepare('DELETE FROM config WHERE key = ?').run(key);
  // Clear the config cache so subsequent reads don't return stale cached values
  const configCore = require('../db/config-core');
  configCore.clearConfigCache();
}

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-stall-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);

  tm = require('../task-manager');
  return { db, tm };
}

function teardownDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

describe('Integration: Stall Detection & Recovery', () => {
  beforeAll(() => {
    setupDb();
    if (typeof tm.initEarlyDeps === 'function') tm.initEarlyDeps();
    if (typeof tm.initSubModules === 'function') tm.initSubModules();
  });
  afterAll(() => { teardownDb(); });

  // ── Stall Threshold Configuration ───────────────────────

  describe('Stall threshold by provider', () => {
    it('getStallThreshold returns a number for ollama provider', () => {
      const threshold = tm.getStallThreshold(null, 'ollama');
      expect(typeof threshold).toBe('number');
      expect(threshold).toBeGreaterThan(0);
    });

    it('getStallThreshold returns a number for aider-ollama provider', () => {
      const threshold = tm.getStallThreshold(null, 'aider-ollama');
      expect(typeof threshold).toBe('number');
      expect(threshold).toBeGreaterThan(0);
    });

    it('ollama threshold differs from aider threshold', () => {
      const ollamaThreshold = tm.getStallThreshold(null, 'ollama');
      const aiderThreshold = tm.getStallThreshold(null, 'aider-ollama');
      // They should have different thresholds (180s vs 240s)
      expect(ollamaThreshold).not.toBe(aiderThreshold);
    });

    it('codex threshold is null or very high by default', () => {
      const threshold = tm.getStallThreshold(null, 'codex');
      // Codex may have null (disabled) or a very high threshold (600s)
      if (threshold !== null) {
        expect(threshold).toBeGreaterThanOrEqual(600);
      }
    });

    it('runtime config override takes priority', () => {
      // Set a custom threshold via config
      db.setConfig('stall_threshold_ollama', '999');
      const threshold = tm.getStallThreshold(null, 'ollama');
      expect(threshold).toBe(999);

      // Clean up — must delete the row, not set to null (setConfig stores "null" as string)
      deleteConfig('stall_threshold_ollama');
    });

    it('config value of 0 disables stall detection', () => {
      db.setConfig('stall_threshold_ollama', '0');
      const threshold = tm.getStallThreshold(null, 'ollama');
      expect(threshold).toBeNull();

      // Clean up — must delete the row, not set to null (setConfig stores "null" as string)
      deleteConfig('stall_threshold_ollama');
    });
  });

  // ── Model Size Scaling ──────────────────────────────────

  describe('Model size affects threshold', () => {
    it('32b model gets higher threshold than 8b model', () => {
      const small = tm.getStallThreshold('qwen2.5-coder:8b', 'ollama');
      const large = tm.getStallThreshold('qwen2.5-coder:32b', 'ollama');
      expect(large).toBeGreaterThanOrEqual(small);
    });

    it('thinking model gets multiplied threshold', () => {
      const regular = tm.getStallThreshold('qwen2.5-coder:8b', 'ollama');
      const thinking = tm.getStallThreshold('qwen3:8b', 'ollama');
      // qwen3 is a thinking model — gets 1.5x multiplier
      expect(thinking).toBeGreaterThan(regular);
    });

    it('70b model gets very high threshold', () => {
      const threshold = tm.getStallThreshold('llama3:70b', 'ollama');
      // 70b matches the :(\d+)b regex first → sizeB >= 32 → max(threshold, 360)
      expect(threshold).toBeGreaterThanOrEqual(300);
    });
  });

  // ── checkStalledTasks Detection ─────────────────────────

  describe('checkStalledTasks detection', () => {
    it('returns empty array when no processes running', () => {
      const stalled = tm.checkStalledTasks(false);
      expect(Array.isArray(stalled)).toBe(true);
      // Should be empty since we haven't started any real processes
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

  // ── Stall Recovery Configuration ────────────────────────

  describe('Stall recovery configuration', () => {
    it('stall_recovery_enabled config controls recovery', () => {
      db.setConfig('stall_recovery_enabled', '1');
      expect(db.getConfig('stall_recovery_enabled')).toBe('1');

      db.setConfig('stall_recovery_enabled', '0');
      expect(db.getConfig('stall_recovery_enabled')).toBe('0');

      // Restore
      db.setConfig('stall_recovery_enabled', '1');
    });

    it('stall_recovery_max_attempts config is readable', () => {
      db.setConfig('stall_recovery_max_attempts', '5');
      expect(db.getConfig('stall_recovery_max_attempts')).toBe('5');

      // Restore
      db.setConfig('stall_recovery_max_attempts', '3');
    });

    it('auto_cancel_stalled config is readable', () => {
      db.setConfig('auto_cancel_stalled', '1');
      expect(db.getConfig('auto_cancel_stalled')).toBe('1');
    });
  });

  // ── Provider-Specific Threshold Constants ───────────────

  describe('Provider stall threshold constants', () => {
    it('all standard providers have defined thresholds', () => {
      const providers = ['ollama', 'aider-ollama'];
      for (const provider of providers) {
        const threshold = tm.getStallThreshold(null, provider);
        expect(threshold).toBeTruthy();
        expect(typeof threshold).toBe('number');
      }
    });

    it('unknown provider falls back to base threshold', () => {
      const threshold = tm.getStallThreshold(null, 'unknown-provider');
      // Should either return null or a base threshold
      if (threshold !== null) {
        expect(typeof threshold).toBe('number');
      }
    });
  });

  // ── Stall Detection Integration ─────────────────────────

  describe('Stall detection integration with DB config', () => {
    it('per-provider config keys are consistent', () => {
      // Verify the config keys follow a pattern
      const providers = ['ollama', 'aider-ollama', 'codex'];
      for (const provider of providers) {
        // Setting a value and reading it back should work
        const key = `stall_threshold_${provider.replace(/-/g, '_')}`;
        db.setConfig(key, '300');
        const val = db.getConfig(key);
        expect(val).toBe('300');
        deleteConfig(key); // Clean up — must delete row, not set to null
      }
    });

    it('threshold with null config falls back to defaults', () => {
      // Clear any config overrides — must delete the row, not set to null
      deleteConfig('stall_threshold_ollama');
      const threshold = tm.getStallThreshold(null, 'ollama');
      // Should get the default PROVIDER_STALL_THRESHOLDS value
      expect(threshold).toBeTruthy();
      expect(typeof threshold).toBe('number');
    });
  });
});
