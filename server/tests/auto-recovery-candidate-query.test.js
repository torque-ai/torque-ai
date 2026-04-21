'use strict';
const Database = require('better-sqlite3');
const { listRecoveryCandidates } = require('../factory/auto-recovery/candidate-query');

const SCHEMA = `CREATE TABLE factory_projects (
  id TEXT PRIMARY KEY, name TEXT, status TEXT,
  loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
  auto_recovery_attempts INTEGER DEFAULT 0,
  auto_recovery_last_action_at TEXT,
  auto_recovery_exhausted INTEGER DEFAULT 0,
  auto_recovery_last_strategy TEXT
)`;

function seedProject(db, overrides) {
  const row = {
    id: 'p1', name: 'test', status: 'running',
    loop_state: null, loop_paused_at_stage: null, loop_last_action_at: null,
    auto_recovery_attempts: 0, auto_recovery_last_action_at: null,
    auto_recovery_exhausted: 0, auto_recovery_last_strategy: null,
    ...overrides,
  };
  db.prepare(`INSERT INTO factory_projects
    (id, name, status, loop_state, loop_paused_at_stage, loop_last_action_at,
     auto_recovery_attempts, auto_recovery_last_action_at,
     auto_recovery_exhausted, auto_recovery_last_strategy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.name, row.status, row.loop_state, row.loop_paused_at_stage,
         row.loop_last_action_at, row.auto_recovery_attempts,
         row.auto_recovery_last_action_at, row.auto_recovery_exhausted,
         row.auto_recovery_last_strategy);
}

describe('listRecoveryCandidates', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.prepare(SCHEMA).run();
  });

  it('matches VERIFY_FAIL-paused projects (SpudgetBooks bug)', () => {
    seedProject(db, {
      id: 'sb', loop_state: 'PAUSED', loop_paused_at_stage: 'VERIFY_FAIL',
      loop_last_action_at: '2026-04-21T03:00:00Z',
    });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).toContain('sb');
  });

  it('matches projects paused at any stage, not just VERIFY', () => {
    seedProject(db, {
      id: 'p1', loop_state: 'PAUSED', loop_paused_at_stage: 'EXECUTE_FAIL',
      loop_last_action_at: '2026-04-21T00:00:00Z',
    });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).toContain('p1');
  });

  it('matches never-started projects (status=paused, loop_last_action_at IS NULL)', () => {
    seedProject(db, { id: 'st', status: 'paused', loop_state: 'IDLE' });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).toContain('st');
  });

  it('excludes exhausted projects', () => {
    seedProject(db, {
      id: 'ex', loop_state: 'PAUSED', loop_paused_at_stage: 'VERIFY_FAIL',
      loop_last_action_at: '2026-04-21T03:00:00Z', auto_recovery_exhausted: 1,
    });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).not.toContain('ex');
  });

  it('excludes projects inside their cooldown window', () => {
    seedProject(db, {
      id: 'cd', loop_state: 'PAUSED', loop_paused_at_stage: 'VERIFY_FAIL',
      loop_last_action_at: '2026-04-21T12:59:00Z',
      auto_recovery_last_action_at: '2026-04-21T12:59:50Z',
    });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).not.toContain('cd');
  });

  it('excludes fresh paused projects (inside pause-grace period)', () => {
    seedProject(db, {
      id: 'fresh', loop_state: 'PAUSED', loop_paused_at_stage: 'VERIFY_FAIL',
      loop_last_action_at: '2026-04-21T12:59:50Z',
    });
    const c = listRecoveryCandidates(db, {
      nowMs: Date.parse('2026-04-21T13:00:00Z'),
      graceMs: 60_000,
    });
    expect(c.map(r => r.id)).not.toContain('fresh');
  });

  it('ignores running projects without a pause signal', () => {
    seedProject(db, { id: 'run', status: 'running', loop_state: 'EXECUTE' });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).not.toContain('run');
  });
});
