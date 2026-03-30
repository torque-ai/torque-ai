'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

describe('data-dir legacy migration', () => {
  let tmpDir, legacyDir, activeDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-migration-test-'));
    legacyDir = path.join(tmpDir, 'legacy');
    activeDir = path.join(tmpDir, 'active');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(activeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProviderConfigTable(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_config (
        provider TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 5,
        cli_path TEXT,
        transport TEXT DEFAULT 'api',
        cli_args TEXT,
        quota_error_patterns TEXT DEFAULT '[]',
        max_concurrent INTEGER DEFAULT 3,
        created_at TEXT,
        updated_at TEXT,
        api_base_url TEXT,
        api_key_encrypted TEXT,
        provider_type TEXT,
        default_model TEXT
      )
    `);
  }

  function seedProvider(db, provider, opts = {}) {
    db.prepare(`
      INSERT OR IGNORE INTO provider_config (provider, enabled, api_key_encrypted, default_model, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(provider, opts.enabled ? 1 : 0, opts.key || null, opts.model || null);
  }

  it('migrates encrypted keys from legacy to active DB', () => {
    const legacyDb = new Database(path.join(legacyDir, 'tasks.db'));
    createProviderConfigTable(legacyDb);
    seedProvider(legacyDb, 'groq', { enabled: true, key: 'encrypted-groq-key-data' });
    seedProvider(legacyDb, 'cerebras', { enabled: true, key: 'encrypted-cerebras-key-data' });
    legacyDb.close();

    const activeDb = new Database(path.join(activeDir, 'tasks.db'));
    createProviderConfigTable(activeDb);
    seedProvider(activeDb, 'groq', { enabled: false });
    seedProvider(activeDb, 'cerebras', { enabled: false });
    activeDb.close();

    const { migrateLegacyProviderConfigs } = require('../data-dir');
    migrateLegacyProviderConfigs(legacyDir, activeDir);

    const verifyDb = new Database(path.join(activeDir, 'tasks.db'), { readonly: true });
    const groq = verifyDb.prepare('SELECT * FROM provider_config WHERE provider = ?').get('groq');
    const cerebras = verifyDb.prepare('SELECT * FROM provider_config WHERE provider = ?').get('cerebras');
    verifyDb.close();

    expect(groq.api_key_encrypted).toBe('encrypted-groq-key-data');
    expect(groq.enabled).toBe(1);
    expect(cerebras.api_key_encrypted).toBe('encrypted-cerebras-key-data');
    expect(cerebras.enabled).toBe(1);
  });

  it('does not overwrite existing keys in active DB', () => {
    const legacyDb = new Database(path.join(legacyDir, 'tasks.db'));
    createProviderConfigTable(legacyDb);
    seedProvider(legacyDb, 'groq', { enabled: true, key: 'old-legacy-key' });
    legacyDb.close();

    const activeDb = new Database(path.join(activeDir, 'tasks.db'));
    createProviderConfigTable(activeDb);
    seedProvider(activeDb, 'groq', { enabled: true, key: 'existing-active-key' });
    activeDb.close();

    const { migrateLegacyProviderConfigs } = require('../data-dir');
    migrateLegacyProviderConfigs(legacyDir, activeDir);

    const verifyDb = new Database(path.join(activeDir, 'tasks.db'), { readonly: true });
    const groq = verifyDb.prepare('SELECT * FROM provider_config WHERE provider = ?').get('groq');
    verifyDb.close();

    expect(groq.api_key_encrypted).toBe('existing-active-key');
  });

  it('does not disable providers that are already enabled', () => {
    const legacyDb = new Database(path.join(legacyDir, 'tasks.db'));
    createProviderConfigTable(legacyDb);
    seedProvider(legacyDb, 'groq', { enabled: false, key: 'some-key' });
    legacyDb.close();

    const activeDb = new Database(path.join(activeDir, 'tasks.db'));
    createProviderConfigTable(activeDb);
    seedProvider(activeDb, 'groq', { enabled: true });
    activeDb.close();

    const { migrateLegacyProviderConfigs } = require('../data-dir');
    migrateLegacyProviderConfigs(legacyDir, activeDir);

    const verifyDb = new Database(path.join(activeDir, 'tasks.db'), { readonly: true });
    const groq = verifyDb.prepare('SELECT * FROM provider_config WHERE provider = ?').get('groq');
    verifyDb.close();

    expect(groq.enabled).toBe(1);
  });

  it('copies secret.key from legacy to active if missing', () => {
    fs.writeFileSync(path.join(legacyDir, 'secret.key'), 'test-encryption-key-data');

    const legacyDb = new Database(path.join(legacyDir, 'tasks.db'));
    createProviderConfigTable(legacyDb);
    seedProvider(legacyDb, 'groq', { enabled: true, key: 'encrypted-data' });
    legacyDb.close();

    const activeDb = new Database(path.join(activeDir, 'tasks.db'));
    createProviderConfigTable(activeDb);
    seedProvider(activeDb, 'groq', { enabled: false });
    activeDb.close();

    const { migrateLegacyProviderConfigs } = require('../data-dir');
    migrateLegacyProviderConfigs(legacyDir, activeDir);

    expect(fs.existsSync(path.join(activeDir, 'secret.key'))).toBe(true);
    expect(fs.readFileSync(path.join(activeDir, 'secret.key'), 'utf8')).toBe('test-encryption-key-data');
  });

  it('does not overwrite existing secret.key', () => {
    fs.writeFileSync(path.join(legacyDir, 'secret.key'), 'old-key');
    fs.writeFileSync(path.join(activeDir, 'secret.key'), 'current-key');

    const legacyDb = new Database(path.join(legacyDir, 'tasks.db'));
    createProviderConfigTable(legacyDb);
    seedProvider(legacyDb, 'groq', { enabled: true, key: 'encrypted-data' });
    legacyDb.close();

    const activeDb = new Database(path.join(activeDir, 'tasks.db'));
    createProviderConfigTable(activeDb);
    seedProvider(activeDb, 'groq', { enabled: false });
    activeDb.close();

    const { migrateLegacyProviderConfigs } = require('../data-dir');
    migrateLegacyProviderConfigs(legacyDir, activeDir);

    expect(fs.readFileSync(path.join(activeDir, 'secret.key'), 'utf8')).toBe('current-key');
  });

  it('handles missing legacy DB gracefully', () => {
    const { migrateLegacyProviderConfigs } = require('../data-dir');
    migrateLegacyProviderConfigs(legacyDir, activeDir);
  });

  it('handles missing active DB gracefully (copies secret.key only)', () => {
    fs.writeFileSync(path.join(legacyDir, 'secret.key'), 'key-data');
    const legacyDb = new Database(path.join(legacyDir, 'tasks.db'));
    createProviderConfigTable(legacyDb);
    seedProvider(legacyDb, 'groq', { enabled: true, key: 'encrypted-data' });
    legacyDb.close();

    const { migrateLegacyProviderConfigs } = require('../data-dir');
    migrateLegacyProviderConfigs(legacyDir, activeDir);

    expect(fs.existsSync(path.join(activeDir, 'secret.key'))).toBe(true);
  });

  it('migrates default_model from legacy if active has none', () => {
    const legacyDb = new Database(path.join(legacyDir, 'tasks.db'));
    createProviderConfigTable(legacyDb);
    seedProvider(legacyDb, 'groq', { enabled: true, key: 'key-data', model: 'qwen/qwen3-32b' });
    legacyDb.close();

    const activeDb = new Database(path.join(activeDir, 'tasks.db'));
    createProviderConfigTable(activeDb);
    seedProvider(activeDb, 'groq', { enabled: false });
    activeDb.close();

    const { migrateLegacyProviderConfigs } = require('../data-dir');
    migrateLegacyProviderConfigs(legacyDir, activeDir);

    const verifyDb = new Database(path.join(activeDir, 'tasks.db'), { readonly: true });
    const groq = verifyDb.prepare('SELECT * FROM provider_config WHERE provider = ?').get('groq');
    verifyDb.close();

    expect(groq.default_model).toBe('qwen/qwen3-32b');
  });
});
