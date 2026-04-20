import { describe, test, expect, beforeEach, afterEach } from 'vitest';
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('verify_recovery_attempts column persistence', () => {
  let db;
  beforeEach(() => {
    ({ db } = setupTestDbOnly('verify-stall-recovery-persistence'));
  });
  afterEach(() => teardownTestDb());

  test('factory_projects has verify_recovery_attempts column after migration', () => {
    const rawDb = db.getDbInstance();
    const cols = rawDb.prepare('PRAGMA table_info(factory_projects)').all();
    const names = cols.map(c => c.name);
    expect(names).toContain('verify_recovery_attempts');
    const col = cols.find(c => c.name === 'verify_recovery_attempts');
    expect(col.type.toUpperCase()).toBe('INTEGER');
    // Default value comparison is lenient — sqlite stores it as a string
    expect(String(col.dflt_value)).toBe('0');
  });

  test('listStalledVerifyLoops reads attempts from the DB column when present', () => {
    const rawDb = db.getDbInstance();
    const pid = 'proj-' + Date.now();
    rawDb.prepare(`
      INSERT INTO factory_projects (id, name, path, status, trust_level, loop_state, loop_paused_at_stage, loop_last_action_at, verify_recovery_attempts)
      VALUES (?, ?, ?, 'running', 'dark', 'VERIFY', 'VERIFY', datetime('now','-90 minutes'), 1)
    `).run(pid, 'test-project', '/tmp/test-project');

    const { listStalledVerifyLoops } = require('../factory/verify-stall-recovery');
    const stalled = listStalledVerifyLoops(rawDb);
    const match = stalled.find(s => s.project_id === pid);
    expect(match).toBeTruthy();
    expect(match.attempts).toBe(1);
  });
});
