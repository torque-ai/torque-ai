'use strict';
const Database = require('better-sqlite3');
const autoRecovery = require('../factory/auto-recovery');
const { createPlugin } = require('../plugins/auto-recovery-core');

function seed(db) {
  db.prepare(`CREATE TABLE factory_projects (
    id TEXT PRIMARY KEY, name TEXT, status TEXT, path TEXT,
    loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
    auto_recovery_attempts INTEGER DEFAULT 0,
    auto_recovery_last_action_at TEXT,
    auto_recovery_exhausted INTEGER DEFAULT 0,
    auto_recovery_last_strategy TEXT
  )`).run();
  db.prepare(`CREATE TABLE factory_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, stage TEXT, actor TEXT, action TEXT,
    inputs_json TEXT,
    reasoning TEXT, outcome_json TEXT, confidence REAL,
    batch_id TEXT, created_at TEXT
  )`).run();
}

describe('E2E: SpudgetBooks sourcelink scenario', () => {
  it('classifies as transient, runs clean_and_retry, logs success', async () => {
    const db = new Database(':memory:');
    seed(db);
    db.prepare(`INSERT INTO factory_projects
                (id, name, status, path, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('sb', 'SpudgetBooks', 'running', '/fake/sb', 'PAUSED', 'VERIFY_FAIL',
                        '2026-04-21T03:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, reasoning, outcome_json, created_at, batch_id)
                VALUES ('sb', 'verify', 'verifier', 'worktree_verify_failed',
                        'paused at VERIFY_FAIL', ?, '2026-04-21T03:00:00Z', 'b514')`)
       .run(JSON.stringify({
         output_preview: `error : Error writing to source link file sourcelink.json ... being used by another process`,
         retry_attempts: 1,
       }));

    const plugin = createPlugin();
    let cleanupCalled = false, retryCalled = false;
    const engine = autoRecovery.createAutoRecoveryEngine({
      db, logger: { info: () => {}, warn: () => {}, error: () => {} },
      eventBus: { emit: () => {} },
      rules: plugin.classifierRules,
      strategies: plugin.recoveryStrategies,
      services: {
        cleanupWorktreeBuildArtifacts: async () => { cleanupCalled = true; return { deleted: ['/fake/sb/obj'], stacks: ['dotnet'] }; },
        retryFactoryVerify: async () => { retryCalled = true; return { ok: true }; },
        logger: { info: () => {}, warn: () => {} },
      },
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(summary.attempts).toBe(1);
    expect(cleanupCalled).toBe(true);
    expect(retryCalled).toBe(true);

    const actions = db.prepare(`SELECT action FROM factory_decisions
                                WHERE actor='auto-recovery' ORDER BY id`).all().map(d => d.action);
    expect(actions).toContain('auto_recovery_classified');
    expect(actions).toContain('auto_recovery_strategy_selected');
    expect(actions).toContain('auto_recovery_strategy_succeeded');

    const classified = db.prepare(`SELECT outcome_json FROM factory_decisions
                                   WHERE action='auto_recovery_classified'`).get();
    expect(classified.outcome_json).toContain('dotnet_sourcelink_file_lock');
  });
});
