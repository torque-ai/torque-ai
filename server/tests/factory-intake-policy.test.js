'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../db/schema-tables');
const {
  getCodexFallbackPolicy,
  setCodexFallbackPolicy,
  CODEX_FALLBACK_POLICIES,
} = require('../db/factory-intake');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
const LOGGER_STUB = { debug() {}, info() {}, warn() {}, error() {} };

describe('codex_fallback_policy accessor', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db, LOGGER_STUB);
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running', '{}');
  });

  it('CODEX_FALLBACK_POLICIES enumerates valid values', () => {
    expect(CODEX_FALLBACK_POLICIES).toEqual(['auto', 'manual', 'wait_for_codex']);
  });

  it('returns "auto" by default when field absent', () => {
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('auto');
  });

  it('reads explicit policy from config_json', () => {
    db.prepare(`UPDATE factory_projects SET config_json = ? WHERE id = ?`)
      .run('{"codex_fallback_policy":"wait_for_codex"}', 'p1');
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('wait_for_codex');
  });

  it('returns "auto" when project does not exist', () => {
    expect(getCodexFallbackPolicy({ db, projectId: 'p_does_not_exist' })).toBe('auto');
  });

  it('returns "auto" when config_json is malformed', () => {
    db.prepare(`UPDATE factory_projects SET config_json = ? WHERE id = ?`).run('not json', 'p1');
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('auto');
  });

  it('returns "auto" when policy value is not in allowed set', () => {
    db.prepare(`UPDATE factory_projects SET config_json = ? WHERE id = ?`)
      .run('{"codex_fallback_policy":"bogus_value"}', 'p1');
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('auto');
  });

  it('setCodexFallbackPolicy persists value into config_json', () => {
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'manual' });
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('manual');
  });

  it('setCodexFallbackPolicy preserves other config_json fields', () => {
    db.prepare(`UPDATE factory_projects SET config_json = ? WHERE id = ?`)
      .run('{"verify_command":"npm test"}', 'p1');
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'manual' });
    const row = db.prepare(`SELECT config_json FROM factory_projects WHERE id = 'p1'`).get();
    const cfg = JSON.parse(row.config_json);
    expect(cfg.verify_command).toBe('npm test');
    expect(cfg.codex_fallback_policy).toBe('manual');
  });

  it('rejects invalid policy values', () => {
    expect(() => setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'bogus' }))
      .toThrow(/invalid policy/i);
  });

  it('throws when project does not exist', () => {
    expect(() => setCodexFallbackPolicy({ db, projectId: 'p_does_not_exist', policy: 'auto' }))
      .toThrow(/project not found/i);
  });

  it('setCodexFallbackPolicy succeeds when existing config_json is malformed', () => {
    db.prepare(`UPDATE factory_projects SET config_json = ? WHERE id = ?`).run('not json', 'p1');
    expect(() => setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'manual' })).not.toThrow();
    // After set, the policy is readable and the corrupt JSON is replaced with valid JSON.
    expect(getCodexFallbackPolicy({ db, projectId: 'p1' })).toBe('manual');
  });
});
