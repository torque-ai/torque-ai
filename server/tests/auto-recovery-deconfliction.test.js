'use strict';
const Database = require('better-sqlite3');
const { listStalledVerifyLoops } = require('../factory/verify-stall-recovery');

describe('deconfliction — verify-stall-recovery yields to engine', () => {
  it('skips projects the engine touched within cooldown', () => {
    const db = new Database(':memory:');
    db.prepare(`CREATE TABLE factory_projects (
      id TEXT PRIMARY KEY, loop_state TEXT, loop_paused_at_stage TEXT,
      loop_batch_id TEXT, loop_last_action_at TEXT, verify_recovery_attempts INTEGER DEFAULT 0,
      auto_recovery_attempts INTEGER DEFAULT 0,
      auto_recovery_last_action_at TEXT,
      auto_recovery_exhausted INTEGER DEFAULT 0,
      auto_recovery_last_strategy TEXT
    )`).run();

    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();

    db.prepare(`INSERT INTO factory_projects
                (id, loop_state, loop_paused_at_stage, loop_last_action_at,
                 auto_recovery_attempts, auto_recovery_last_action_at)
                VALUES ('engine-held', 'VERIFY', NULL, ?, 1, ?)`)
      .run(twoHoursAgo, tenSecondsAgo);

    const stalled = listStalledVerifyLoops(db);
    expect(stalled.map(r => r.project_id)).not.toContain('engine-held');
  });
});
