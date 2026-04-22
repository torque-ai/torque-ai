'use strict';
const Database = require('better-sqlite3');
const {
  listRecoveryStrategies, getRecoveryHistory, clearAutoRecovery, triggerAutoRecovery,
} = require('../handlers/auto-recovery-handlers');
const { routeMap } = require('../tools');

function seedDb() {
  const db = new Database(':memory:');
  db.prepare(`CREATE TABLE factory_projects (
    id TEXT PRIMARY KEY, name TEXT, status TEXT,
    loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
    auto_recovery_attempts INTEGER DEFAULT 0,
    auto_recovery_last_action_at TEXT,
    auto_recovery_exhausted INTEGER DEFAULT 0,
    auto_recovery_last_strategy TEXT
  )`).run();
  db.prepare(`CREATE TABLE factory_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, stage TEXT, actor TEXT, action TEXT,
    reasoning TEXT, outcome_json TEXT, confidence REAL,
    batch_id TEXT, created_at TEXT
  )`).run();
  return db;
}

describe('auto-recovery MCP handlers', () => {
  let db;
  beforeEach(() => { db = seedDb(); });

  it('registers auto-recovery tools in the REST tool routeMap', () => {
    expect(routeMap.get('list_recovery_strategies')).toBeInstanceOf(Function);
    expect(routeMap.get('get_recovery_history')).toBeInstanceOf(Function);
    expect(routeMap.get('clear_auto_recovery')).toBeInstanceOf(Function);
    expect(routeMap.get('trigger_auto_recovery')).toBeInstanceOf(Function);
  });

  it('list_recovery_strategies returns rules + strategies', () => {
    const engine = {
      _registry: {
        getRules: () => [{ name: 'r1', category: 'transient', priority: 1 }],
        getStrategies: () => [{ name: 's1', applicable_categories: ['transient'] }],
      },
    };
    const res = listRecoveryStrategies({ engine });
    expect(res.rules).toHaveLength(1);
    expect(res.strategies).toHaveLength(1);
  });

  it('get_recovery_history returns only auto-recovery decisions', () => {
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p1', 'verify', 'auto-recovery', 'auto_recovery_classified', '2026-04-21T12:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p1', 'verify', 'verifier', 'worktree_verify_failed', '2026-04-21T11:00:00Z')`).run();
    const res = getRecoveryHistory({ db, project_id: 'p1' });
    expect(res.decisions).toHaveLength(1);
    expect(res.decisions[0].action).toBe('auto_recovery_classified');
  });

  it('clear_auto_recovery resets counter + logs', () => {
    db.prepare(`INSERT INTO factory_projects (id, auto_recovery_attempts, auto_recovery_exhausted)
                VALUES ('p1', 4, 1)`).run();
    const res = clearAutoRecovery({ db, project_id: 'p1' });
    const p = db.prepare('SELECT * FROM factory_projects WHERE id=?').get('p1');
    expect(p.auto_recovery_attempts).toBe(0);
    expect(p.auto_recovery_exhausted).toBe(0);
    expect(res.cleared).toBe(true);
    const logged = db.prepare(`SELECT * FROM factory_decisions WHERE action=?`)
                     .get('auto_recovery_operator_cleared');
    expect(logged).toBeTruthy();
  });

  it('trigger_auto_recovery bypasses cooldown and calls engine.recoverOne', async () => {
    db.prepare(`INSERT INTO factory_projects (id, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('p1', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T12:00:00Z')`).run();
    let called = false;
    const engine = { recoverOne: async () => { called = true; return { attempted: true, strategy: 'retry' }; } };
    const res = await triggerAutoRecovery({ db, engine, project_id: 'p1' });
    expect(called).toBe(true);
    expect(res.attempted).toBe(true);
  });

  it('trigger_auto_recovery returns makeError when project_id is missing', async () => {
    const engine = { recoverOne: async () => ({ attempted: true }) };
    const res = await triggerAutoRecovery({ db, engine });
    expect(res.isError).toBe(true);
    expect(res.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(JSON.stringify(res.content)).toMatch(/project_id/);
  });
});
