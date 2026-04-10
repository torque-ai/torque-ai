'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger').child({ component: 'factory-health' });

const VALID_TRUST_LEVELS = new Set(['supervised', 'guided', 'autonomous', 'dark']);
const VALID_STATUSES = new Set(['paused', 'running', 'idle']);
const VALID_DIMENSIONS = new Set([
  'structural', 'test_coverage', 'security', 'user_facing',
  'api_completeness', 'documentation', 'dependency_health',
  'build_ci', 'performance', 'debt_ratio',
]);

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function registerProject({ name, path, brief, trust_level, config }) {
  const id = uuidv4();
  const level = trust_level || 'supervised';
  if (!VALID_TRUST_LEVELS.has(level)) {
    throw new Error(`Invalid trust_level: ${level}`);
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?)
  `).run(id, name, path, brief || null, level, config ? JSON.stringify(config) : null, now, now);

  return getProject(id);
}

function getProject(id) {
  const row = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(id);
  if (!row) return null;
  if (row.config_json) {
    try { row.config = JSON.parse(row.config_json); } catch { row.config = null; }
  }
  return row;
}

function getProjectByPath(projectPath) {
  const row = db.prepare('SELECT * FROM factory_projects WHERE path = ?').get(projectPath);
  if (!row) return null;
  if (row.config_json) {
    try { row.config = JSON.parse(row.config_json); } catch { row.config = null; }
  }
  return row;
}

function listProjects(filter) {
  let sql = 'SELECT * FROM factory_projects';
  const params = [];
  if (filter?.status) {
    sql += ' WHERE status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY updated_at DESC';
  return db.prepare(sql).all(...params);
}

function updateProject(id, updates) {
  const allowed = ['name', 'brief', 'trust_level', 'status', 'config_json'];
  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    if (key === 'trust_level' && !VALID_TRUST_LEVELS.has(value)) {
      throw new Error(`Invalid trust_level: ${value}`);
    }
    if (key === 'status' && !VALID_STATUSES.has(value)) {
      throw new Error(`Invalid status: ${value}`);
    }
    sets.push(`${key} = ?`);
    params.push(key === 'config_json' && typeof value === 'object' ? JSON.stringify(value) : value);
  }

  if (sets.length === 0) return getProject(id);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE factory_projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProject(id);
}

function recordSnapshot({ project_id, dimension, score, scan_type, details, batch_id }) {
  const info = db.prepare(`
    INSERT INTO factory_health_snapshots (project_id, dimension, score, details_json, scan_type, batch_id, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    project_id,
    dimension,
    score,
    details ? JSON.stringify(details) : null,
    scan_type || 'incremental',
    batch_id || null,
  );
  return { id: info.lastInsertRowid, project_id, dimension, score, scan_type: scan_type || 'incremental' };
}

function getLatestScores(projectId) {
  const rows = db.prepare(`
    SELECT dimension, score FROM factory_health_snapshots
    WHERE project_id = ? AND id IN (
      SELECT MAX(id) FROM factory_health_snapshots
      WHERE project_id = ?
      GROUP BY dimension
    )
  `).all(projectId, projectId);

  const scores = {};
  for (const row of rows) {
    scores[row.dimension] = row.score;
  }
  return scores;
}

function getScoreHistory(projectId, dimension, limit) {
  return db.prepare(`
    SELECT id, score, scan_type, batch_id, scanned_at, details_json
    FROM factory_health_snapshots
    WHERE project_id = ? AND dimension = ?
    ORDER BY scanned_at ASC
    LIMIT ?
  `).all(projectId, dimension, limit || 100);
}

function getBalanceScore(projectId) {
  const scores = getLatestScores(projectId);
  const values = Object.values(scores);
  if (values.length < 2) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

function recordFindings(snapshotId, findings) {
  const stmt = db.prepare(`
    INSERT INTO factory_health_findings (snapshot_id, severity, message, file_path, details_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insert = db.transaction((items) => {
    for (const f of items) {
      stmt.run(
        snapshotId,
        f.severity,
        f.message,
        f.file_path || null,
        f.details ? JSON.stringify(f.details) : null,
      );
    }
  });
  insert(findings);
}

function getFindings(snapshotId) {
  return db.prepare(
    'SELECT * FROM factory_health_findings WHERE snapshot_id = ? ORDER BY id'
  ).all(snapshotId);
}

function getProjectHealthSummary(projectId) {
  const project = getProject(projectId);
  if (!project) return null;

  const scores = getLatestScores(projectId);
  const balance = getBalanceScore(projectId);
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];

  return {
    project,
    scores,
    balance,
    weakest_dimension: weakest ? { dimension: weakest[0], score: weakest[1] } : null,
    dimension_count: Object.keys(scores).length,
  };
}

module.exports = {
  setDb,
  registerProject,
  getProject,
  getProjectByPath,
  listProjects,
  updateProject,
  recordSnapshot,
  getLatestScores,
  getScoreHistory,
  getBalanceScore,
  recordFindings,
  getFindings,
  getProjectHealthSummary,
  VALID_TRUST_LEVELS,
  VALID_STATUSES,
  VALID_DIMENSIONS,
};
