'use strict';
const Database = require('better-sqlite3');
const autoRecovery = require('../factory/auto-recovery');
const { createPlugin } = require('../plugins/auto-recovery-core');

describe('E2E: StateTrace never-started', () => {
  it('classifies as never_started, runs retry_plan_generation', async () => {
    const db = new Database(':memory:');
    db.prepare(`CREATE TABLE factory_projects (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, path TEXT,
      loop_state TEXT, loop_batch_id TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
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
    db.prepare(`INSERT INTO factory_projects (id, name, status, path, loop_state)
                VALUES ('st', 'StateTrace', 'paused', '/fake/st', 'IDLE')`).run();

    const plugin = createPlugin();
    let retryPlanCalled = false;
    const engine = autoRecovery.createAutoRecoveryEngine({
      db, logger: { info: () => {}, warn: () => {}, error: () => {} },
      eventBus: { emit: () => {} },
      rules: plugin.classifierRules,
      strategies: plugin.recoveryStrategies,
      services: {
        retryPlanGeneration: async () => { retryPlanCalled = true; return { ok: true }; },
        retryFactoryVerify: async () => ({ ok: true }),
        logger: { info: () => {}, warn: () => {} },
      },
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(summary.attempts).toBe(1);
    expect(retryPlanCalled).toBe(true);
  });
});
