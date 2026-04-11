'use strict';

const logger = require('../logger').child({ component: 'factory-architect' });

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function createCycle({ project_id, input_snapshot, reasoning, backlog, flags, trigger }) {
  if (!project_id) throw new Error('project_id is required');
  if (!reasoning) throw new Error('reasoning is required');

  const info = db.prepare(`
    INSERT INTO factory_architect_cycles (project_id, input_snapshot_json, reasoning, backlog_json, flags_json, status, trigger, created_at)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, datetime('now'))
  `).run(
    project_id,
    JSON.stringify(input_snapshot || {}),
    reasoning,
    JSON.stringify(backlog || []),
    flags ? JSON.stringify(flags) : null,
    trigger || 'manual',
  );

  return getCycle(info.lastInsertRowid);
}

function getCycle(id) {
  const row = db.prepare('SELECT * FROM factory_architect_cycles WHERE id = ?').get(id);
  if (!row) return null;
  return parseCycle(row);
}

function parseCycle(row) {
  try { row.input_snapshot = JSON.parse(row.input_snapshot_json); } catch { row.input_snapshot = {}; }
  try { row.backlog = JSON.parse(row.backlog_json); } catch { row.backlog = []; }
  try { row.flags = row.flags_json ? JSON.parse(row.flags_json) : []; } catch { row.flags = []; }
  return row;
}

function getLatestCycle(project_id) {
  const row = db.prepare(
    'SELECT * FROM factory_architect_cycles WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(project_id);
  if (!row) return null;
  return parseCycle(row);
}

function listCycles(project_id, limit) {
  const rows = db.prepare(
    'SELECT * FROM factory_architect_cycles WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(project_id, limit || 10);
  return rows.map(parseCycle);
}

function getBacklog(project_id) {
  const cycle = getLatestCycle(project_id);
  if (!cycle) return [];
  return cycle.backlog || [];
}

function getReasoningLog(project_id, limit) {
  const rows = db.prepare(
    'SELECT id, reasoning, trigger, created_at FROM factory_architect_cycles WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(project_id, limit || 10);
  return rows;
}

module.exports = {
  setDb,
  createCycle,
  getCycle,
  getLatestCycle,
  listCycles,
  getBacklog,
  getReasoningLog,
};
