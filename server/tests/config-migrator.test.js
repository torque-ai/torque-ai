'use strict';

/**
 * Tests for server/discovery/config-migrator.js
 *
 * Verifies that migrateConfigToRegistry(db) correctly reads legacy config keys
 * and writes into model_roles, model_capabilities, and model_registry tables.
 */

const { setupTestDbOnly, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

let migrateConfigToRegistry;

describe('discovery/config-migrator', () => {
  beforeAll(() => {
    setupTestDbOnly('config-migrator');
    migrateConfigToRegistry = require('../discovery/config-migrator').migrateConfigToRegistry;
  });

  afterAll(() => teardownTestDb());

  beforeEach(() => {
    resetTables(['config', 'model_roles', 'model_capabilities', 'model_registry']);
  });

  // ── Tier model assignments ──────────────────────────────────────────────────

  describe('ollama_model → model_roles ollama/default', () => {
    it('writes the default model from config to model_roles', () => {
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_model', '${TEST_MODELS.DEFAULT}')`).run();

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        "SELECT model_name FROM model_roles WHERE provider = 'ollama' AND role = 'default'"
      ).get();
      expect(row).toBeTruthy();
      expect(row.model_name).toBe(TEST_MODELS.DEFAULT);
    });
  });

  describe('ollama_fast_model → model_roles ollama/fast', () => {
    it('writes the fast model from config to model_roles', () => {
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_fast_model', '${TEST_MODELS.FAST}')`).run();

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        "SELECT model_name FROM model_roles WHERE provider = 'ollama' AND role = 'fast'"
      ).get();
      expect(row).toBeTruthy();
      expect(row.model_name).toBe(TEST_MODELS.FAST);
    });
  });

  describe('ollama_balanced_model → model_roles ollama/balanced', () => {
    it('writes the balanced model from config to model_roles', () => {
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_balanced_model', '${TEST_MODELS.BALANCED}')`).run();

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        "SELECT model_name FROM model_roles WHERE provider = 'ollama' AND role = 'balanced'"
      ).get();
      expect(row).toBeTruthy();
      expect(row.model_name).toBe(TEST_MODELS.BALANCED);
    });
  });

  describe('ollama_quality_model → model_roles ollama/quality', () => {
    it('writes the quality model from config to model_roles', () => {
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_quality_model', '${TEST_MODELS.QUALITY}')`).run();

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        "SELECT model_name FROM model_roles WHERE provider = 'ollama' AND role = 'quality'"
      ).get();
      expect(row).toBeTruthy();
      expect(row.model_name).toBe(TEST_MODELS.QUALITY);
    });
  });

  describe('multiple tier models', () => {
    it('migrates all four tier models in a single call', () => {
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_model', '${TEST_MODELS.DEFAULT}')`).run();
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_fast_model', '${TEST_MODELS.FAST}')`).run();
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_balanced_model', '${TEST_MODELS.BALANCED}')`).run();
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_quality_model', '${TEST_MODELS.QUALITY}')`).run();

      migrateConfigToRegistry(rawDb());

      const roles = rawDb().prepare(
        "SELECT role, model_name FROM model_roles WHERE provider = 'ollama' ORDER BY role"
      ).all();

      const roleMap = Object.fromEntries(roles.map(r => [r.role, r.model_name]));
      expect(roleMap['default']).toBe(TEST_MODELS.DEFAULT);
      expect(roleMap['fast']).toBe(TEST_MODELS.FAST);
      expect(roleMap['balanced']).toBe(TEST_MODELS.BALANCED);
      expect(roleMap['quality']).toBe(TEST_MODELS.QUALITY);
    });
  });

  // ── Hashline capabilities ───────────────────────────────────────────────────

  describe('hashline_capable_models → model_capabilities rows', () => {
    it('creates capability rows with cap_hashline=1 for comma-separated models', () => {
      rawDb().prepare(
        `INSERT INTO config (key, value) VALUES ('hashline_capable_models', '${TEST_MODELS.DEFAULT},${TEST_MODELS.BALANCED},${TEST_MODELS.FAST}')`
      ).run();

      migrateConfigToRegistry(rawDb());

      const rows = rawDb().prepare(
        "SELECT model_name, cap_hashline, capability_source FROM model_capabilities WHERE cap_hashline = 1 ORDER BY model_name"
      ).all();

      const names = rows.map(r => r.model_name);
      expect(names).toContain(TEST_MODELS.DEFAULT);
      expect(names).toContain(TEST_MODELS.BALANCED);
      expect(names).toContain(TEST_MODELS.FAST);

      for (const row of rows) {
        expect(row.cap_hashline).toBe(1);
        expect(row.capability_source).toBe('config_migration');
      }
    });

    it('trims whitespace from comma-separated model names', () => {
      rawDb().prepare(
        `INSERT INTO config (key, value) VALUES ('hashline_capable_models', ' ${TEST_MODELS.DEFAULT} , ${TEST_MODELS.BALANCED} ')`
      ).run();

      migrateConfigToRegistry(rawDb());

      const row1 = rawDb().prepare(
        `SELECT model_name FROM model_capabilities WHERE model_name = '${TEST_MODELS.DEFAULT}'`
      ).get();
      const row2 = rawDb().prepare(
        `SELECT model_name FROM model_capabilities WHERE model_name = '${TEST_MODELS.BALANCED}'`
      ).get();

      expect(row1).toBeTruthy();
      expect(row2).toBeTruthy();
    });

    it('handles a single model (no commas)', () => {
      rawDb().prepare(
        `INSERT INTO config (key, value) VALUES ('hashline_capable_models', '${TEST_MODELS.DEFAULT}')`
      ).run();

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        `SELECT cap_hashline FROM model_capabilities WHERE model_name = '${TEST_MODELS.DEFAULT}'`
      ).get();
      expect(row).toBeTruthy();
      expect(row.cap_hashline).toBe(1);
    });
  });

  // ── Model tuning JSON ───────────────────────────────────────────────────────

  describe('ollama_model_settings JSON → model_registry.tuning_json', () => {
    it('sets tuning_json on matching registry rows where tuning_json IS NULL', () => {
      // Insert a registry entry without tuning_json
      rawDb().prepare(
        `INSERT INTO model_registry (id, provider, model_name, status, first_seen_at, last_seen_at) VALUES ('mr-1', 'ollama', '${TEST_MODELS.DEFAULT}', 'approved', datetime('now'), datetime('now'))`
      ).run();

      const settings = JSON.stringify({ [TEST_MODELS.DEFAULT]: { temperature: 0.2, top_p: 0.9 } });
      rawDb().prepare("INSERT INTO config (key, value) VALUES ('ollama_model_settings', ?)").run(settings);

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        `SELECT tuning_json FROM model_registry WHERE model_name = '${TEST_MODELS.DEFAULT}'`
      ).get();
      expect(row).toBeTruthy();
      expect(row.tuning_json).toBe(JSON.stringify({ temperature: 0.2, top_p: 0.9 }));
    });

    it('does NOT overwrite existing tuning_json', () => {
      const existing = JSON.stringify({ temperature: 0.7 });
      rawDb().prepare(
        `INSERT INTO model_registry (id, provider, model_name, status, tuning_json, first_seen_at, last_seen_at) VALUES ('mr-2', 'ollama', '${TEST_MODELS.DEFAULT}', 'approved', ?, datetime('now'), datetime('now'))`
      ).run(existing);

      const settings = JSON.stringify({ [TEST_MODELS.DEFAULT]: { temperature: 0.2 } });
      rawDb().prepare("INSERT INTO config (key, value) VALUES ('ollama_model_settings', ?)").run(settings);

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        `SELECT tuning_json FROM model_registry WHERE model_name = '${TEST_MODELS.DEFAULT}'`
      ).get();
      expect(row.tuning_json).toBe(existing); // unchanged
    });
  });

  // ── Model prompts ───────────────────────────────────────────────────────────

  describe('ollama_model_prompts JSON → model_registry.prompt_template', () => {
    it('sets prompt_template on matching registry rows where prompt_template IS NULL', () => {
      rawDb().prepare(
        `INSERT INTO model_registry (id, provider, model_name, status, first_seen_at, last_seen_at) VALUES ('mr-3', 'ollama', '${TEST_MODELS.BALANCED}', 'approved', datetime('now'), datetime('now'))`
      ).run();

      const prompts = JSON.stringify({ [TEST_MODELS.BALANCED]: 'You are a code assistant.' });
      rawDb().prepare("INSERT INTO config (key, value) VALUES ('ollama_model_prompts', ?)").run(prompts);

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        `SELECT prompt_template FROM model_registry WHERE model_name = '${TEST_MODELS.BALANCED}'`
      ).get();
      expect(row).toBeTruthy();
      expect(row.prompt_template).toBe('You are a code assistant.');
    });

    it('does NOT overwrite existing prompt_template', () => {
      const existing = 'Original prompt.';
      rawDb().prepare(
        `INSERT INTO model_registry (id, provider, model_name, status, prompt_template, first_seen_at, last_seen_at) VALUES ('mr-4', 'ollama', '${TEST_MODELS.BALANCED}', 'approved', ?, datetime('now'), datetime('now'))`
      ).run(existing);

      const prompts = JSON.stringify({ [TEST_MODELS.BALANCED]: 'New prompt.' });
      rawDb().prepare("INSERT INTO config (key, value) VALUES ('ollama_model_prompts', ?)").run(prompts);

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        `SELECT prompt_template FROM model_registry WHERE model_name = '${TEST_MODELS.BALANCED}'`
      ).get();
      expect(row.prompt_template).toBe(existing); // unchanged
    });
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('running twice does not error or duplicate model_roles rows', () => {
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_model', '${TEST_MODELS.DEFAULT}')`).run();

      expect(() => {
        migrateConfigToRegistry(rawDb());
        migrateConfigToRegistry(rawDb());
      }).not.toThrow();

      const count = rawDb().prepare(
        "SELECT COUNT(*) AS cnt FROM model_roles WHERE provider = 'ollama' AND role = 'default'"
      ).get().cnt;
      expect(count).toBe(1);
    });

    it('running twice does not duplicate model_capabilities rows', () => {
      rawDb().prepare(
        `INSERT INTO config (key, value) VALUES ('hashline_capable_models', '${TEST_MODELS.DEFAULT}')`
      ).run();

      migrateConfigToRegistry(rawDb());
      migrateConfigToRegistry(rawDb());

      const count = rawDb().prepare(
        `SELECT COUNT(*) AS cnt FROM model_capabilities WHERE model_name = '${TEST_MODELS.DEFAULT}'`
      ).get().cnt;
      expect(count).toBe(1);
    });
  });

  // ── Graceful skip on missing keys ────────────────────────────────────────────

  describe('missing config keys', () => {
    it('does not error when no config keys are present', () => {
      expect(() => migrateConfigToRegistry(rawDb())).not.toThrow();
    });

    it('does not error when only some config keys are present', () => {
      rawDb().prepare(`INSERT INTO config (key, value) VALUES ('ollama_model', '${TEST_MODELS.DEFAULT}')`).run();
      // ollama_fast_model, hashline_capable_models etc. are absent

      expect(() => migrateConfigToRegistry(rawDb())).not.toThrow();

      const row = rawDb().prepare(
        "SELECT model_name FROM model_roles WHERE provider = 'ollama' AND role = 'default'"
      ).get();
      expect(row.model_name).toBe(TEST_MODELS.DEFAULT);
    });

    it('does not write roles when config value is empty string', () => {
      rawDb().prepare("INSERT INTO config (key, value) VALUES ('ollama_fast_model', '')").run();

      migrateConfigToRegistry(rawDb());

      const row = rawDb().prepare(
        "SELECT model_name FROM model_roles WHERE provider = 'ollama' AND role = 'fast'"
      ).get();
      expect(row).toBeFalsy();
    });
  });
});
