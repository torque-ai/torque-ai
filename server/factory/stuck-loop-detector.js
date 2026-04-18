'use strict';

const STALL_THRESHOLD_MS = 30 * 60 * 1000;

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
      loop_last_action_at AS last_action_at
    FROM factory_projects
    WHERE loop_last_action_at IS NOT NULL
      AND COALESCE(UPPER(loop_state), 'IDLE') NOT IN ('IDLE', 'PAUSED')
    ORDER BY loop_last_action_at ASC
  `).all();

  return rows.flatMap((row) => {
    const lastActionMs = Date.parse(row.last_action_at);
    if (!Number.isFinite(lastActionMs)) return [];

    const stalledMs = nowMs - lastActionMs;
    if (stalledMs <= thresholdMs) return [];

    return [{
      ...row,
      stalled_minutes: Math.floor(stalledMs / (60 * 1000)),
    }];
  });
}

module.exports = {
  STALL_THRESHOLD_MS,
  detectStuckLoops,
};
