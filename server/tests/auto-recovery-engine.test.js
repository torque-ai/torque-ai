'use strict';
const Database = require('better-sqlite3');
const { createAutoRecoveryEngine } = require('../factory/auto-recovery');

function seedSchema(db) {
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
    reasoning TEXT, inputs_json TEXT, outcome_json TEXT,
    confidence REAL, batch_id TEXT, created_at TEXT
  )`).run();
}

function makeLogger() {
  const rows = [];
  const push = (lvl) => (...args) => rows.push({ lvl, args });
  return { warn: push('warn'), error: push('error'), info: push('info'), debug: push('debug'), rows };
}

describe('auto-recovery engine.tick', () => {
  let db, logger;
  beforeEach(() => { db = new Database(':memory:'); seedSchema(db); logger = makeLogger(); });

  it('classifies, picks, runs, and logs a successful recovery', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('p1', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, reasoning, created_at, outcome_json)
                VALUES ('p1', 'verify', 'verifier', 'worktree_verify_failed',
                        'flaky', '2026-04-21T03:00:00Z',
                        '{"output_preview":"being used by another process"}')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{
        name: 'file_lock', category: 'transient', priority: 100, confidence: 0.9,
        match: { stage: 'verify', action: 'worktree_verify_failed',
                 outcome_path: 'output_preview', outcome_regex: 'being used by another' },
        suggested_strategies: ['retry'],
      }],
      strategies: [{
        name: 'retry', applicable_categories: ['transient'],
        async run(ctx) { ran.push(ctx.project.id); return { success: true, next_action: 'retry', outcome: {} }; },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(ran).toEqual(['p1']);
    expect(summary.attempts).toBe(1);

    const actions = db.prepare(`SELECT action FROM factory_decisions
                                WHERE actor='auto-recovery' ORDER BY id`).all();
    expect(actions.map(a => a.action)).toEqual([
      'auto_recovery_classified',
      'auto_recovery_strategy_selected',
      'auto_recovery_strategy_succeeded',
    ]);
    const p = db.prepare('SELECT * FROM factory_projects WHERE id=?').get('p1');
    expect(p.auto_recovery_attempts).toBe(1);
    expect(p.auto_recovery_last_strategy).toBe('retry');
  });

  it('logs _failed when strategy throws', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('p2', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p2', 'verify', 'verifier', 'worktree_verify_failed', '2026-04-21T03:00:00Z')`).run();

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['boom'] }],
      strategies: [{
        name: 'boom', applicable_categories: ['unknown', 'any'],
        async run() { throw new Error('strategy exploded'); },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    await engine.tick();
    const failed = db.prepare(`SELECT COUNT(*) AS n FROM factory_decisions
                               WHERE actor='auto-recovery' AND action='auto_recovery_strategy_failed'`).get();
    expect(failed.n).toBe(1);
  });

  it('marks exhausted after MAX_ATTEMPTS and logs _exhausted', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, loop_last_action_at, auto_recovery_attempts)
                VALUES ('p3', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z', 4)`).run();
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p3', 'verify', 'verifier', 'worktree_verify_failed', '2026-04-21T03:00:00Z')`).run();

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['any'], run: async () => ({ success: true, next_action: 'retry' }) }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    await engine.tick();
    const p = db.prepare('SELECT auto_recovery_exhausted FROM factory_projects WHERE id=?').get('p3');
    expect(p.auto_recovery_exhausted).toBe(1);
    const exhausted = db.prepare(`SELECT COUNT(*) AS n FROM factory_decisions
                                  WHERE actor='auto-recovery' AND action='auto_recovery_exhausted'`).get();
    expect(exhausted.n).toBe(1);
  });

  it('skips candidates inside cooldown window', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, loop_last_action_at,
                 auto_recovery_attempts, auto_recovery_last_action_at)
                VALUES ('p4', 'running', 'PAUSED', 'VERIFY_FAIL',
                        '2026-04-21T12:59:00Z', 0, '2026-04-21T12:59:50Z')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['any'],
                     run: async (ctx) => { ran.push(ctx.project.id); return { success: true }; } }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });
    await engine.tick();
    expect(ran).toEqual([]);
  });

  it('handles never-started projects with no prior decisions', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state)
                VALUES ('p5', 'paused', 'IDLE')`).run();
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'ns', category: 'never_started', priority: 1,
                match_fn: (d) => d.action === 'never_started',
                suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['never_started'],
                     run: async () => ({ success: true, next_action: 'retry' }) }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });
    const summary = await engine.tick();
    expect(summary.attempts).toBe(1);
  });

  it('rearms exhausted projects after they resume active progress', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, auto_recovery_attempts,
                 auto_recovery_last_action_at, auto_recovery_exhausted, auto_recovery_last_strategy)
                VALUES ('p6', 'running', 'VERIFY', NULL, 5,
                        '2026-04-21T12:30:00Z', 1, 'retry')`).run();

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [],
      strategies: [],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(summary).toEqual(expect.objectContaining({ attempts: 0, rearmed: 1 }));

    const project = db.prepare(`
      SELECT auto_recovery_attempts, auto_recovery_exhausted, auto_recovery_last_action_at, auto_recovery_last_strategy
      FROM factory_projects
      WHERE id = 'p6'
    `).get();
    expect(project).toEqual({
      auto_recovery_attempts: 0,
      auto_recovery_exhausted: 0,
      auto_recovery_last_action_at: null,
      auto_recovery_last_strategy: null,
    });

    const rearmed = db.prepare(`
      SELECT action
      FROM factory_decisions
      WHERE actor = 'auto-recovery' AND action = 'auto_recovery_rearmed'
    `).get();
    expect(rearmed).toBeDefined();
  });
});
