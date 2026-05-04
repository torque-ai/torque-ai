import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('verify-stall-recovery decision log entries', () => {
  let db;
  let factoryDecisions;
  let recoverStalledVerifyLoops;

  beforeEach(() => {
    ({ db } = setupTestDbOnly('verify-stall-recovery-decisions'));
    factoryDecisions = require('../db/factory/decisions');
    ({ recoverStalledVerifyLoops } = require('../factory/verify-stall-recovery'));
  });
  afterEach(() => { teardownTestDb(); vi.restoreAllMocks(); });

  function insertStalled(pid, attempts) {
    const rawDb = db.getDbInstance();
    // Use ISO UTC with Z so Date.parse on the JS side agrees with SQLite.
    // SQLite's datetime() default output omits the Z and Date.parse interprets
    // it as local time — causing timezone-dependent skew.
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    rawDb.prepare(`
      INSERT INTO factory_projects (id, name, path, status, trust_level, loop_state, loop_paused_at_stage, loop_last_action_at, verify_recovery_attempts)
      VALUES (?, ?, ?, 'running', 'dark', 'PAUSED', 'VERIFY', ?, ?)
    `).run(pid, pid, `/tmp/${pid}`, ninetyMinAgo, attempts);
  }

  test('writes factory_verify_auto_retry decision when auto-retry fires', async () => {
    const pid = 'p-auto-retry';
    insertStalled(pid, 0);

    const retryCalls = [];
    await recoverStalledVerifyLoops({
      db: db.getDbInstance(),
      logger: { warn: vi.fn(), error: vi.fn() },
      eventBus: { emitFactoryVerifyAutoRetry: vi.fn(), emitFactoryVerifyUnrecoverable: vi.fn() },
      retryFactoryVerify: (args) => { retryCalls.push(args); return Promise.resolve({}); },
    });

    expect(retryCalls.length).toBe(1);
    const decs = factoryDecisions.listDecisions(pid, { limit: 10 });
    const match = decs.find(d => d.action === 'factory_verify_auto_retry');
    expect(match).toBeTruthy();
    expect(match.stage).toBe('verify');
    expect(match.actor).toBe('verifier');
  });

  test('writes factory_verify_unrecoverable decision when attempts maxed', async () => {
    const pid = 'p-unrecoverable';
    insertStalled(pid, 2); // MAX_RECOVERY_ATTEMPTS = 2

    const retryCalls = [];
    await recoverStalledVerifyLoops({
      db: db.getDbInstance(),
      logger: { warn: vi.fn(), error: vi.fn() },
      eventBus: { emitFactoryVerifyAutoRetry: vi.fn(), emitFactoryVerifyUnrecoverable: vi.fn() },
      retryFactoryVerify: (args) => { retryCalls.push(args); return Promise.resolve({}); },
    });

    expect(retryCalls.length).toBe(0);
    const decs = factoryDecisions.listDecisions(pid, { limit: 10 });
    const match = decs.find(d => d.action === 'factory_verify_unrecoverable');
    expect(match).toBeTruthy();
    expect(match.stage).toBe('verify');
  });
});
