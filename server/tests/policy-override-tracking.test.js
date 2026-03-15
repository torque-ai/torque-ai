const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { applySchema } = require('../db/schema');
const evaluationStore = require('../policy-engine/evaluation-store');

function buildHelpers(db, dataDir) {
  return {
    safeAddColumn: (table, columnDef) => {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
      } catch {}
    },
    getConfig: (key) => {
      try {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
        return row ? row.value : null;
      } catch {
        return null;
      }
    },
    setConfig: (key, value) => {
      try {
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
      } catch {}
    },
    setConfigDefault: (key, value) => {
      try {
        db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
      } catch {}
    },
    DATA_DIR: dataDir,
  };
}

describe('policy override tracking', () => {
  let db;
  let testDir;

  function ensurePolicyRule(policyId, stage = 'task_complete') {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO policy_rules (
        id, name, category, stage, mode, priority, enabled,
        matcher_json, required_evidence_json, actions_json,
        override_policy_json, tags_json, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      policyId,
      policyId,
      'test',
      stage,
      'warn',
      100,
      1,
      '{}',
      '[]',
      '[]',
      JSON.stringify({ allowed: true, reason_codes: ['manual_override'] }),
      '[]',
      'test',
      now,
      now,
    );
  }

  function createEvaluation(policyId, taskId, overrides = {}) {
    ensurePolicyRule(policyId, overrides.stage || 'task_complete');
    return evaluationStore.createPolicyEvaluation({
      policy_id: policyId,
      profile_id: null,
      stage: 'task_complete',
      target_type: 'task',
      target_id: taskId,
      project: 'Torque',
      mode: 'warn',
      outcome: 'fail',
      severity: 'warning',
      message: 'policy failed',
      override_allowed: true,
      evaluation: {
        override_policy: {
          allowed: true,
          reason_codes: ['manual_override'],
        },
      },
      ...overrides,
    });
  }

  function setOverrideCreatedAt(overrideId, createdAt) {
    db.prepare('UPDATE policy_overrides SET created_at = ? WHERE id = ?').run(createdAt, overrideId);
  }

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `torque-policy-override-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, buildHelpers(db, testDir));
    evaluationStore.setDb(db);
  });

  afterEach(() => {
    evaluationStore.setDb(null);
    if (db) {
      db.close();
      db = null;
    }
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true });
      testDir = null;
    }
  });

  it('recordOverride stores an override record', () => {
    const evaluation = createEvaluation('policy-store', 'task-1');

    const override = evaluationStore.recordOverride(
      'policy-store',
      'task-1',
      'Operator approved manual exception',
      'operator-1',
    );

    const stored = db.prepare(`
      SELECT evaluation_id, policy_id, task_id, reason, overridden_by, reason_code, actor
      FROM policy_overrides
      WHERE id = ?
    `).get(override.id);

    expect(stored).toMatchObject({
      evaluation_id: evaluation.id,
      policy_id: 'policy-store',
      task_id: 'task-1',
      reason: 'Operator approved manual exception',
      overridden_by: 'operator-1',
      reason_code: 'manual_override',
      actor: 'operator-1',
    });
  });

  it('getOverrideRate returns correct rate for a policy', () => {
    createEvaluation('policy-rate', 'task-1');
    createEvaluation('policy-rate', 'task-2');
    createEvaluation('policy-rate', 'task-3');
    createEvaluation('policy-rate', 'task-4');
    evaluationStore.recordOverride('policy-rate', 'task-2', 'Manual approval', 'operator-2');

    expect(evaluationStore.getOverrideRate('policy-rate')).toEqual({
      total_evaluations: 4,
      overrides: 1,
      rate: 0.25,
    });
  });

  it('getOverrideRate respects the windowDays parameter', () => {
    const oldCreatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const oldEvaluation = createEvaluation('policy-window', 'task-old', { created_at: oldCreatedAt });
    const oldOverride = evaluationStore.recordOverride('policy-window', 'task-old', 'Older override', 'operator-old');
    setOverrideCreatedAt(oldOverride.id, oldCreatedAt);

    createEvaluation('policy-window', 'task-recent');
    evaluationStore.recordOverride('policy-window', 'task-recent', 'Recent override', 'operator-recent');

    expect(oldEvaluation.policy_id).toBe('policy-window');
    expect(evaluationStore.getOverrideRate('policy-window', 7)).toEqual({
      total_evaluations: 1,
      overrides: 1,
      rate: 1,
    });
    expect(evaluationStore.getOverrideRate('policy-window', 30)).toEqual({
      total_evaluations: 2,
      overrides: 2,
      rate: 1,
    });
  });

  it('getOverrideRate returns 0 rate when no overrides exist', () => {
    createEvaluation('policy-none', 'task-1');
    createEvaluation('policy-none', 'task-2');
    createEvaluation('policy-none', 'task-3');

    expect(evaluationStore.getOverrideRate('policy-none')).toEqual({
      total_evaluations: 3,
      overrides: 0,
      rate: 0,
    });
  });

  it('multiple overrides for same policy accumulate correctly', () => {
    createEvaluation('policy-accumulate', 'task-1');
    createEvaluation('policy-accumulate', 'task-2');
    createEvaluation('policy-accumulate', 'task-3');
    createEvaluation('policy-accumulate', 'task-4');
    createEvaluation('policy-accumulate', 'task-5');

    evaluationStore.recordOverride('policy-accumulate', 'task-1', 'Escalation approved', 'operator-a');
    evaluationStore.recordOverride('policy-accumulate', 'task-3', 'Risk accepted', 'operator-b');
    evaluationStore.recordOverride('policy-accumulate', 'task-5', 'Temporary exception', 'operator-c');

    const rate = evaluationStore.getOverrideRate('policy-accumulate');

    expect(rate.total_evaluations).toBe(5);
    expect(rate.overrides).toBe(3);
    expect(rate.rate).toBeCloseTo(0.6, 5);
  });
});
