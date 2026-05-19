'use strict';

const { isWithinCooldown } = require('./backoff');

const DEFAULT_GRACE_MS = 30_000;

function isPausedCandidate(project) {
  if (String(project.loop_state || '').toUpperCase() === 'PAUSED') return true;
  return String(project.status || '').toLowerCase() === 'paused' && !project.loop_last_action_at;
}

function isInsidePauseGrace(project, nowMs, graceMs) {
  if (!project.loop_last_action_at) return false;
  const lastMs = Date.parse(project.loop_last_action_at);
  if (!Number.isFinite(lastMs)) return false;
  return (nowMs - lastMs) < graceMs;
}

function getFactoryProjectColumns(db) {
  try {
    return new Set(
      db.prepare('PRAGMA table_info(factory_projects)')
        .all()
        .map((column) => column.name)
    );
  } catch {
    return new Set();
  }
}

function listRecoveryCandidates(db, { nowMs = Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  const columns = getFactoryProjectColumns(db);
  const optionalColumns = ['trust_level', 'config_json']
    .filter((column) => columns.has(column));
  const optionalSelect = optionalColumns.length > 0
    ? `, ${optionalColumns.join(', ')}`
    : '';
  const rows = db.prepare(`
    SELECT id, name, status, loop_state, loop_paused_at_stage, loop_last_action_at,
           auto_recovery_attempts, auto_recovery_last_action_at,
           auto_recovery_exhausted, auto_recovery_last_strategy${optionalSelect}
    FROM factory_projects
    WHERE COALESCE(auto_recovery_exhausted, 0) = 0
    ORDER BY COALESCE(loop_last_action_at, '1970-01-01T00:00:00Z') ASC, id ASC
  `).all();

  return rows.filter((project) => {
    if (!isPausedCandidate(project)) return false;
    if (isInsidePauseGrace(project, nowMs, graceMs)) return false;
    return !isWithinCooldown(
      project.auto_recovery_last_action_at,
      project.auto_recovery_attempts || 0,
      nowMs,
    );
  });
}

module.exports = { listRecoveryCandidates, DEFAULT_GRACE_MS };
