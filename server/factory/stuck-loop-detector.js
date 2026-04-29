'use strict';

const STALL_THRESHOLD_MS = 30 * 60 * 1000;
const TERMINAL_FACTORY_BATCH_TASK_STATUSES = Object.freeze([
  'completed',
  'shipped',
  'cancelled',
  'failed',
  'skipped',
]);

function escapeSqlLikeValue(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}

function hasNonTerminalBatchTasks(db, batchId) {
  if (!batchId) {
    return false;
  }

  const batchTag = `factory:batch_id=${batchId}`;
  const terminalPlaceholders = TERMINAL_FACTORY_BATCH_TASK_STATUSES.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks
    WHERE tags LIKE ? ESCAPE '\\'
      AND status NOT IN (${terminalPlaceholders})
  `).get(`%"${escapeSqlLikeValue(batchTag)}"%`, ...TERMINAL_FACTORY_BATCH_TASK_STATUSES);

  return Number(row?.count || 0) > 0;
}

function detectStuckLoops(db, thresholdMs = STALL_THRESHOLD_MS) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('detectStuckLoops requires a database handle');
  }

  const nowMs = Date.now();
  const rows = db.prepare(`
    SELECT
      id AS project_id,
      name AS project_name,
      loop_state,
      loop_batch_id AS batch_id,
      loop_last_action_at AS last_action_at
    FROM factory_projects
    WHERE loop_last_action_at IS NOT NULL
      AND COALESCE(LOWER(status), 'paused') = 'running'
      AND COALESCE(UPPER(loop_state), 'IDLE') NOT IN ('IDLE', 'PAUSED')
    ORDER BY loop_last_action_at ASC
  `).all();

  return rows.flatMap((row) => {
    const lastActionMs = Date.parse(row.last_action_at);
    if (!Number.isFinite(lastActionMs)) return [];

    const stalledMs = nowMs - lastActionMs;
    if (stalledMs <= thresholdMs) return [];
    if (hasNonTerminalBatchTasks(db, row.batch_id)) return [];

    return [{
      project_id: row.project_id,
      project_name: row.project_name,
      loop_state: row.loop_state,
      last_action_at: row.last_action_at,
      stalled_minutes: Math.floor(stalledMs / (60 * 1000)),
    }];
  });
}

module.exports = {
  STALL_THRESHOLD_MS,
  detectStuckLoops,
};
