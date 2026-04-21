import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const loopController = require('../factory/loop-controller');
const instances = require('../db/factory-loop-instances');
const factoryHealth = require('../db/factory-health');
const factoryDecisions = require('../db/factory-decisions');

describe('loop-controller — verify silent-rerun', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE factory_projects (id TEXT PRIMARY KEY, name TEXT, trust_level TEXT, config_json TEXT);
      CREATE TABLE factory_work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT);
      CREATE TABLE factory_loop_instances (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id INTEGER,
        batch_id TEXT, loop_state TEXT NOT NULL DEFAULT 'IDLE',
        paused_at_stage TEXT, last_action_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        terminated_at TEXT
      );
      CREATE TABLE factory_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, batch_id TEXT,
        stage TEXT, action TEXT, reasoning TEXT, outcome_json TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO factory_projects (id, name, trust_level, config_json) VALUES ('proj-1', 't', 'dark', '{"feature_flags":{"verify_silent_rerun_enabled":true}}');
      INSERT INTO factory_loop_instances (id, project_id, batch_id, loop_state) VALUES ('inst-1', 'proj-1', 'batch-r1', 'VERIFY');
    `);
    runMigrations(db);
    instances.setDb(db);
    factoryHealth.setDb(db);
    factoryDecisions.setDb(db);
  });

  afterEach(() => { db.close(); });

  it('returns passed when silent rerun exits 0', async () => {
    const runVerify = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('passed');
    const deco = db.prepare("SELECT action FROM factory_decisions WHERE batch_id='batch-r1' AND action='verify_passed_on_silent_rerun'").get();
    expect(deco).toBeDefined();
    expect(runVerify).toHaveBeenCalledOnce();
  });

  it('returns same_failure when rerun fails with identical signature', async () => {
    const output = ' FAIL foo > A\n';
    const runVerify = vi.fn().mockResolvedValue({ exitCode: 1, output });
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: output, runVerify,
    });
    expect(result.kind).toBe('same_failure');
  });

  it('returns different_failure when rerun exits non-zero with different signature', async () => {
    const runVerify = vi.fn().mockResolvedValue({ exitCode: 1, output: ' FAIL foo > B\n' });
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('different_failure');
    expect(result.combinedOutput).toContain('foo > A');
    expect(result.combinedOutput).toContain('foo > B');
  });

  it('returns rerun_failed when runVerify throws', async () => {
    const runVerify = vi.fn().mockRejectedValue(new Error('remote unreachable'));
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('rerun_failed');
    const deco = db.prepare("SELECT action FROM factory_decisions WHERE batch_id='batch-r1' AND action='verify_silent_rerun_failed'").get();
    expect(deco).toBeDefined();
  });

  it('does not rerun when budget already consumed this batch', async () => {
    db.prepare("UPDATE factory_loop_instances SET verify_silent_reruns=1 WHERE id='inst-1'").run();
    const runVerify = vi.fn();
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('budget_exhausted');
    expect(runVerify).not.toHaveBeenCalled();
  });

  it('does not rerun when flag is off', async () => {
    db.prepare("UPDATE factory_projects SET config_json='{}' WHERE id='proj-1'").run();
    const runVerify = vi.fn();
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('flag_off');
    expect(runVerify).not.toHaveBeenCalled();
  });

  it('bumps verify_silent_reruns atomically on each invocation that reaches the run', async () => {
    const runVerify = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });
    await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    const row = db.prepare("SELECT verify_silent_reruns FROM factory_loop_instances WHERE id='inst-1'").get();
    expect(row.verify_silent_reruns).toBe(1);
  });
});
