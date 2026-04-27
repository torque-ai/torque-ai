'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../db/schema-tables');
const { setCodexFallbackPolicy } = require('../db/factory-intake');
const { decideCodexFallbackAction } = require('../factory/loop-controller');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;
const LOGGER_STUB = { debug() {}, info() {}, warn() {}, error() {} };

describe('decideCodexFallbackAction', () => {
  let db;
  let breaker;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db, LOGGER_STUB);
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running', '{}');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'A');
    breaker = {
      _open: false,
      isOpen(provider) { return provider === 'codex' && this._open; },
      _trip() { this._open = true; },
    };
  });

  it('breaker untripped returns "proceed"', () => {
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed');
  });

  it('breaker tripped + policy=auto returns "proceed_with_fallback"', () => {
    breaker._trip();
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed_with_fallback');
  });

  it('breaker tripped + policy=wait_for_codex returns "park"', () => {
    breaker._trip();
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'wait_for_codex' });
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('park');
    expect(decision.reason).toMatch(/wait_for_codex/);
  });

  it('breaker tripped + policy=manual returns "proceed"', () => {
    breaker._trip();
    setCodexFallbackPolicy({ db, projectId: 'p1', policy: 'manual' });
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker });
    expect(decision.action).toBe('proceed');
  });

  it('null breaker returns "proceed"', () => {
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker: null });
    expect(decision.action).toBe('proceed');
  });

  it('breaker with allowRequest only (no isOpen) — works via fallback', () => {
    const oldStyleBreaker = {
      _open: false,
      allowRequest(provider) { return provider === 'codex' ? !this._open : true; },
    };
    oldStyleBreaker._open = true;
    const decision = decideCodexFallbackAction({ db, projectId: 'p1', workItemId: 1, breaker: oldStyleBreaker });
    expect(decision.action).toBe('proceed_with_fallback');
  });
});
