'use strict';

const Database = require('better-sqlite3');

const { createTables } = require('../db/schema-tables');
const recoveryMetrics = require('../db/recovery-metrics');

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function insertMetric(overrides = {}) {
  return recoveryMetrics.recordRecoveryMetric({
    action: 'restart_process',
    app_type: 'desktop',
    risk_level: 'medium',
    mode: 'live',
    success: true,
    duration_ms: 250,
    attempts: 1,
    error: null,
    host: 'snap-host',
    policy_blocked: false,
    approval_required: false,
    approval_granted: false,
    evidence_quality_score: 80,
    ...overrides,
  });
}

describe('recovery metrics db module', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db, createLogger());
    recoveryMetrics.setDb(db);
  });

  afterEach(() => {
    recoveryMetrics.setDb(null);
    if (db) {
      db.close();
      db = null;
    }
  });

  it('recordRecoveryMetric inserts and returns id', () => {
    const id = insertMetric();

    expect(id).toEqual(expect.any(String));
    const stored = db.prepare('SELECT * FROM recovery_metrics WHERE id = ?').get(id);
    expect(stored).toMatchObject({
      id,
      action: 'restart_process',
      app_type: 'desktop',
      risk_level: 'medium',
      mode: 'live',
      success: 1,
      duration_ms: 250,
      attempts: 1,
      host: 'snap-host',
      policy_blocked: 0,
      approval_required: 0,
      approval_granted: 0,
      evidence_quality_score: 80,
    });
  });

  it('getActionStats returns correct stats for an action', () => {
    const firstId = insertMetric({
      action: 'restart_process',
      success: true,
      duration_ms: 200,
    });
    const secondId = insertMetric({
      action: 'restart_process',
      success: false,
      duration_ms: 400,
      error: 'failed restart',
    });
    insertMetric({
      action: 'close_dialog',
      risk_level: 'low',
      duration_ms: 50,
    });

    db.prepare('UPDATE recovery_metrics SET created_at = ? WHERE id = ?').run('2026-03-10 10:00:00', firstId);
    db.prepare('UPDATE recovery_metrics SET created_at = ? WHERE id = ?').run('2026-03-10 11:00:00', secondId);

    expect(recoveryMetrics.getActionStats('restart_process')).toEqual({
      action: 'restart_process',
      total_executions: 2,
      successes: 1,
      failures: 1,
      avg_duration_ms: 300,
      success_rate_pct: 50,
      first_execution: '2026-03-10 10:00:00',
      last_execution: '2026-03-10 11:00:00',
    });
  });

  it('getOverallStats returns aggregate across all actions', () => {
    insertMetric({
      action: 'restart_process',
      success: true,
      evidence_quality_score: 80,
    });
    insertMetric({
      action: 'close_dialog',
      risk_level: 'low',
      success: false,
      policy_blocked: true,
      approval_required: true,
      approval_granted: false,
      evidence_quality_score: 60,
    });
    insertMetric({
      action: 'clear_temp_cache',
      risk_level: 'low',
      success: true,
      approval_required: true,
      approval_granted: true,
      evidence_quality_score: 90,
    });

    expect(recoveryMetrics.getOverallStats()).toEqual({
      total_executions: 3,
      unique_actions: 3,
      successes: 2,
      failures: 1,
      success_rate_pct: 66.7,
      policy_blocks: 1,
      approvals_required: 2,
      avg_evidence_quality: 76.7,
    });
  });

  it('getStatsByRiskLevel groups correctly', () => {
    insertMetric({
      action: 'close_dialog',
      risk_level: 'low',
      success: true,
      duration_ms: 100,
    });
    insertMetric({
      action: 'clear_temp_cache',
      risk_level: 'low',
      success: false,
      duration_ms: 300,
    });
    insertMetric({
      action: 'restart_process',
      risk_level: 'medium',
      success: true,
      duration_ms: 200,
    });

    expect(recoveryMetrics.getStatsByRiskLevel()).toEqual([
      {
        risk_level: 'low',
        total: 2,
        successes: 1,
        success_rate_pct: 50,
        avg_duration_ms: 200,
      },
      {
        risk_level: 'medium',
        total: 1,
        successes: 1,
        success_rate_pct: 100,
        avg_duration_ms: 200,
      },
    ]);
  });

  it('getRecentMetrics returns most recent N', () => {
    const firstId = insertMetric({ action: 'first_action' });
    const secondId = insertMetric({ action: 'second_action' });
    const thirdId = insertMetric({ action: 'third_action' });

    db.prepare('UPDATE recovery_metrics SET created_at = ? WHERE id = ?').run('2026-03-10 09:00:00', firstId);
    db.prepare('UPDATE recovery_metrics SET created_at = ? WHERE id = ?').run('2026-03-10 10:00:00', secondId);
    db.prepare('UPDATE recovery_metrics SET created_at = ? WHERE id = ?').run('2026-03-10 11:00:00', thirdId);

    const rows = recoveryMetrics.getRecentMetrics(2);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.action)).toEqual(['third_action', 'second_action']);
  });

  it('getExecutionCount returns correct count', () => {
    insertMetric();
    insertMetric({ action: 'close_dialog' });
    insertMetric({ action: 'clear_temp_cache' });

    expect(recoveryMetrics.getExecutionCount()).toBe(3);
  });

  it('isReadyForClosedLoop returns ready=false when count is below threshold', () => {
    insertMetric();
    insertMetric({ action: 'close_dialog' });

    expect(recoveryMetrics.isReadyForClosedLoop(3)).toEqual({
      ready: false,
      current: 2,
      threshold: 3,
    });
  });

  it('isReadyForClosedLoop returns ready=true when count meets threshold', () => {
    insertMetric();
    insertMetric({ action: 'close_dialog' });
    insertMetric({ action: 'clear_temp_cache' });

    expect(recoveryMetrics.isReadyForClosedLoop(3)).toEqual({
      ready: true,
      current: 3,
      threshold: 3,
    });
  });

  it('calculates success rates with one decimal place', () => {
    insertMetric({ action: 'restart_process', success: true });
    insertMetric({ action: 'restart_process', success: true });
    insertMetric({ action: 'restart_process', success: false });

    expect(recoveryMetrics.getActionStats('restart_process').success_rate_pct).toBe(66.7);
    expect(recoveryMetrics.getOverallStats().success_rate_pct).toBe(66.7);
  });

  it('converts boolean fields in getRecentMetrics', () => {
    insertMetric({
      action: 'close_dialog',
      success: false,
      policy_blocked: true,
      approval_required: true,
      approval_granted: true,
    });

    const [row] = recoveryMetrics.getRecentMetrics(1);

    expect(row.success).toBe(false);
    expect(row.policy_blocked).toBe(true);
    expect(row.approval_required).toBe(true);
    expect(row.approval_granted).toBe(true);
  });
});
