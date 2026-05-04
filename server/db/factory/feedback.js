'use strict';

const logger = require('../../logger').child({ component: 'factory-feedback' });

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function recordFeedback({
  project_id,
  batch_id,
  health_delta,
  execution_metrics,
  guardrail_activity,
  human_corrections,
}) {
  if (!project_id) throw new Error('project_id is required');

  const info = db.prepare(`
    INSERT INTO factory_feedback (
      project_id,
      batch_id,
      health_delta_json,
      execution_metrics_json,
      guardrail_activity_json,
      human_corrections_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    project_id,
    batch_id || null,
    serializeJson(health_delta),
    serializeJson(execution_metrics),
    serializeJson(guardrail_activity),
    serializeJson(human_corrections),
  );

  return getFeedback(info.lastInsertRowid);
}

function getFeedback(id) {
  const row = db.prepare('SELECT * FROM factory_feedback WHERE id = ?').get(id);
  return parseFeedbackRow(row);
}

function getProjectFeedback(project_id, { limit, offset } = {}) {
  if (!project_id) throw new Error('project_id is required');

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const rows = db.prepare(`
    SELECT * FROM factory_feedback
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(project_id, safeLimit, safeOffset);

  return rows.map(parseFeedbackRow);
}

function getBatchFeedback(batch_id) {
  if (!batch_id) throw new Error('batch_id is required');

  const rows = db.prepare(`
    SELECT * FROM factory_feedback
    WHERE batch_id = ?
    ORDER BY created_at DESC
  `).all(batch_id);

  return rows.map(parseFeedbackRow);
}

function getPatterns(project_id, { limit } = {}) {
  if (!project_id) throw new Error('project_id is required');

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const rows = db.prepare(`
    SELECT * FROM factory_feedback
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(project_id, safeLimit);

  return rows.map(parseFeedbackRow);
}

function deleteFeedback(project_id) {
  if (!project_id) throw new Error('project_id is required');

  const info = db.prepare('DELETE FROM factory_feedback WHERE project_id = ?').run(project_id);
  return info.changes;
}

function parseFeedbackRow(row) {
  if (!row) return null;

  const fields = [
    ['health_delta_json', 'health_delta'],
    ['execution_metrics_json', 'execution_metrics'],
    ['guardrail_activity_json', 'guardrail_activity'],
    ['human_corrections_json', 'human_corrections'],
  ];

  for (const [jsonField, parsedField] of fields) {
    if (!row[jsonField]) {
      row[parsedField] = null;
      continue;
    }

    try {
      row[parsedField] = JSON.parse(row[jsonField]);
    } catch (error) {
      logger.warn(
        { feedback_id: row.id, field: jsonField, err: error.message },
        'Failed to parse factory feedback JSON field'
      );
      row[parsedField] = null;
    }
  }

  return row;
}

function serializeJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

module.exports = {
  setDb,
  recordFeedback,
  getFeedback,
  getProjectFeedback,
  getBatchFeedback,
  getPatterns,
  deleteFeedback,
};
