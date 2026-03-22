'use strict';

const crypto = require('crypto');

let db;

function setDb(dbInstance) {
  db = dbInstance;
}

function recordRecoveryMetric({
  action,
  app_type,
  risk_level,
  mode,
  success,
  duration_ms,
  attempts,
  error,
  host,
  policy_blocked,
  approval_required,
  approval_granted,
  evidence_quality_score,
}) {
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO recovery_metrics (
      id, action, app_type, risk_level, mode, success, duration_ms, attempts,
      error, host, policy_blocked, approval_required, approval_granted,
      evidence_quality_score, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    action,
    app_type || null,
    risk_level || null,
    mode,
    success ? 1 : 0,
    duration_ms == null ? 0 : duration_ms,
    attempts == null ? 1 : attempts,
    error || null,
    host || null,
    policy_blocked ? 1 : 0,
    approval_required ? 1 : 0,
    approval_granted ? 1 : 0,
    evidence_quality_score == null ? null : evidence_quality_score,
  );

  return id;
}

function getActionStats(action) {
  const row = db.prepare(`
    SELECT action,
      COUNT(*) as total_executions,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms,
      ROUND(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) * 100, 1) as success_rate_pct,
      MIN(created_at) as first_execution,
      MAX(created_at) as last_execution
    FROM recovery_metrics
    WHERE action = ?
  `).get(action);

  return row;
}

function getOverallStats() {
  return db.prepare(`
    SELECT
      COUNT(*) as total_executions,
      COUNT(DISTINCT action) as unique_actions,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
      ROUND(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) * 100, 1) as success_rate_pct,
      SUM(CASE WHEN policy_blocked = 1 THEN 1 ELSE 0 END) as policy_blocks,
      SUM(CASE WHEN approval_required = 1 THEN 1 ELSE 0 END) as approvals_required,
      ROUND(AVG(evidence_quality_score), 1) as avg_evidence_quality
    FROM recovery_metrics
  `).get();
}

function getStatsByRiskLevel() {
  return db.prepare(`
    SELECT risk_level,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
      ROUND(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) * 100, 1) as success_rate_pct,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM recovery_metrics
    GROUP BY risk_level
    ORDER BY risk_level
  `).all();
}

function getRecentMetrics(limit = 50) {
  return db.prepare('SELECT * FROM recovery_metrics ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map((row) => ({
      ...row,
      success: !!row.success,
      policy_blocked: !!row.policy_blocked,
      approval_required: !!row.approval_required,
      approval_granted: !!row.approval_granted,
    }));
}

function getExecutionCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM recovery_metrics').get();
  return row ? row.count : 0;
}

function isReadyForClosedLoop(threshold = 50) {
  const count = getExecutionCount();
  return { ready: count >= threshold, current: count, threshold };
}

function createRecoveryMetrics({ db: dbInst }) {
  setDb(dbInst);
  return {
    recordRecoveryMetric,
    getActionStats,
    getOverallStats,
    getStatsByRiskLevel,
    getRecentMetrics,
    getExecutionCount,
    isReadyForClosedLoop,
  };
}

module.exports = {
  setDb,
  createRecoveryMetrics,
  recordRecoveryMetric,
  getActionStats,
  getOverallStats,
  getStatsByRiskLevel,
  getRecentMetrics,
  getExecutionCount,
  isReadyForClosedLoop,
};
