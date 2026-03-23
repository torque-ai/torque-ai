'use strict';

const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

let mod;

describe('db/model-roles module', () => {
  beforeAll(() => {
    ({ mod } = setupTestDbModule('../db/model-roles', 'model-roles'));
  });

  beforeEach(() => {
    resetTables('model_roles');
  });

  afterAll(() => teardownTestDb());

  describe('getModelForRole', () => {
    it('returns null when no model is assigned', () => {
      expect(mod.getModelForRole('ollama', 'default')).toBeNull();
    });

    it('returns the assigned model for an exact role match', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      expect(mod.getModelForRole('ollama', 'default')).toBe('qwen3-coder:30b');
    });

    it('falls back from fast to default when no fast model assigned', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      expect(mod.getModelForRole('ollama', 'fast')).toBe('qwen3-coder:30b');
    });

    it('falls back from balanced to default when no balanced model assigned', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      expect(mod.getModelForRole('ollama', 'balanced')).toBe('qwen3-coder:30b');
    });

    it('falls back from quality to default when no quality model assigned', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      expect(mod.getModelForRole('ollama', 'quality')).toBe('qwen3-coder:30b');
    });

    it('falls back from fallback to default when no fallback model assigned', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      expect(mod.getModelForRole('ollama', 'fallback')).toBe('qwen3-coder:30b');
    });

    it('returns null when fallback chain exhausted (fast → default → null)', () => {
      expect(mod.getModelForRole('ollama', 'fast')).toBeNull();
    });

    it('prefers the exact role over the fallback', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      mod.setModelRole('ollama', 'fast', 'codestral:22b');
      expect(mod.getModelForRole('ollama', 'fast')).toBe('codestral:22b');
    });

    it('resolves roles independently per provider', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      mod.setModelRole('deepinfra', 'default', 'Qwen/Qwen2.5-72B-Instruct');
      expect(mod.getModelForRole('ollama', 'default')).toBe('qwen3-coder:30b');
      expect(mod.getModelForRole('deepinfra', 'default')).toBe('Qwen/Qwen2.5-72B-Instruct');
    });

    it('throws on invalid role', () => {
      expect(() => mod.getModelForRole('ollama', 'bogus')).toThrow(/Invalid role/);
    });
  });

  describe('setModelRole', () => {
    it('assigns a model correctly', () => {
      mod.setModelRole('codex', 'default', 'gpt-5.3-codex-spark');
      const row = rawDb().prepare(
        'SELECT * FROM model_roles WHERE provider = ? AND role = ?'
      ).get('codex', 'default');
      expect(row).toBeTruthy();
      expect(row.model_name).toBe('gpt-5.3-codex-spark');
      expect(row.updated_at).toBeTruthy();
    });

    it('replaces an existing assignment', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      mod.setModelRole('ollama', 'default', 'codestral:22b');
      expect(mod.getModelForRole('ollama', 'default')).toBe('codestral:22b');

      // Should only have one row, not two
      const rows = rawDb().prepare(
        'SELECT * FROM model_roles WHERE provider = ? AND role = ?'
      ).all('ollama', 'default');
      expect(rows.length).toBe(1);
    });

    it('throws on invalid role', () => {
      expect(() => mod.setModelRole('ollama', 'invalid', 'model')).toThrow(/Invalid role/);
    });
  });

  describe('clearModelRole', () => {
    it('removes an assignment', () => {
      mod.setModelRole('ollama', 'fast', 'qwen3-coder:30b');
      expect(mod.getModelForRole('ollama', 'fast')).toBe('qwen3-coder:30b');

      mod.clearModelRole('ollama', 'fast');
      expect(mod.getModelForRole('ollama', 'fast')).toBeNull();
    });

    it('is a no-op when nothing to clear', () => {
      // Should not throw
      mod.clearModelRole('ollama', 'fast');
    });

    it('throws on invalid role', () => {
      expect(() => mod.clearModelRole('ollama', 'nope')).toThrow(/Invalid role/);
    });
  });

  describe('listModelRoles', () => {
    it('returns empty array when no assignments exist', () => {
      expect(mod.listModelRoles()).toEqual([]);
    });

    it('returns all assignments', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      mod.setModelRole('ollama', 'fast', 'qwen3-coder:30b');
      mod.setModelRole('deepinfra', 'default', 'Qwen/Qwen2.5-72B-Instruct');

      const all = mod.listModelRoles();
      expect(all.length).toBe(3);
      expect(all.map(r => r.provider)).toContain('ollama');
      expect(all.map(r => r.provider)).toContain('deepinfra');
    });

    it('filters by provider', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      mod.setModelRole('ollama', 'fast', 'qwen3-coder:30b');
      mod.setModelRole('deepinfra', 'default', 'Qwen/Qwen2.5-72B-Instruct');

      const ollamaRoles = mod.listModelRoles('ollama');
      expect(ollamaRoles.length).toBe(2);
      expect(ollamaRoles.every(r => r.provider === 'ollama')).toBe(true);

      const deepinfraRoles = mod.listModelRoles('deepinfra');
      expect(deepinfraRoles.length).toBe(1);
      expect(deepinfraRoles[0].model_name).toBe('Qwen/Qwen2.5-72B-Instruct');
    });

    it('returns entries with all expected fields', () => {
      mod.setModelRole('ollama', 'default', 'qwen3-coder:30b');
      const [entry] = mod.listModelRoles('ollama');
      expect(entry).toHaveProperty('provider', 'ollama');
      expect(entry).toHaveProperty('role', 'default');
      expect(entry).toHaveProperty('model_name', 'qwen3-coder:30b');
      expect(entry).toHaveProperty('updated_at');
    });
  });

  describe('VALID_ROLES constant', () => {
    it('contains the expected roles', () => {
      expect(mod.VALID_ROLES).toEqual(['default', 'fallback', 'fast', 'balanced', 'quality']);
    });
  });
});
