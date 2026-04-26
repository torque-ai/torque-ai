'use strict';

const nodePath = require('path');
const { v4: uuidv4 } = require('uuid');
const { validatePolicy, mergeWithDefaults } = require('../factory/policy-engine');

const VALID_TRUST_LEVELS = new Set(['supervised', 'guided', 'autonomous', 'dark']);
const VALID_STATUSES = new Set(['paused', 'running', 'idle']);

function normalizeProjectPath(p) {
  if (!p || typeof p !== 'string') return p;
  return nodePath.resolve(p).replace(/\\/g, '/');
}
const VALID_DIMENSIONS = new Set([
  'structural', 'test_coverage', 'security', 'user_facing',
  'api_completeness', 'documentation', 'dependency_health',
  'build_ci', 'performance', 'debt_ratio',
]);

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function resolveDbHandle(candidate) {
  if (!candidate) {
    return null;
  }
  if (typeof candidate.prepare === 'function') {
    return candidate;
  }
  if (typeof candidate.getDbInstance === 'function') {
    return candidate.getDbInstance();
  }
  if (typeof candidate.getDb === 'function') {
    return candidate.getDb();
  }
  return null;
}

function getDb() {
  let instance = resolveDbHandle(db);
  if (!instance) {
    try {
      const { defaultContainer } = require('../container');
      if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('db')) {
        instance = resolveDbHandle(defaultContainer.get('db'));
      }
    } catch {
      // Fall through to database.js below.
    }
  }
  if (!instance) {
    try {
      const database = require('../database');
      instance = resolveDbHandle(database);
    } catch {
      // Let the explicit error below surface if no active DB is available.
    }
  }

  if (instance) {
    db = instance;
  }
  if (!instance || typeof instance.prepare !== 'function') {
    throw new Error('Factory health requires an active database connection');
  }
  return instance;
}

function registerProject({ name, path, brief, trust_level, config }) {
  const id = uuidv4();
  const level = trust_level || 'supervised';
  if (!VALID_TRUST_LEVELS.has(level)) {
    throw new Error(`Invalid trust_level: ${level}`);
  }
  const normalizedPath = normalizeProjectPath(path);
  const now = new Date().toISOString();
  const database = getDb();
  database.prepare(`
    INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?)
  `).run(id, name, normalizedPath, brief || null, level, config ? JSON.stringify(config) : null, now, now);

  return getProject(id);
}

function getProject(id) {
  const row = getDb().prepare('SELECT * FROM factory_projects WHERE id = ?').get(id);
  if (!row) return null;
  if (row.config_json) {
    try { row.config = JSON.parse(row.config_json); } catch { row.config = null; }
  }
  return row;
}

function getProjectByPath(projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  const database = getDb();
  // Exact match first (fast path for already-normalized rows)
  let row = database.prepare('SELECT * FROM factory_projects WHERE path = ?').get(normalized);
  if (!row) {
    // Fall back to in-memory normalized comparison to catch legacy rows that
    // were stored with backslashes or non-canonical paths
    const rows = database.prepare('SELECT * FROM factory_projects').all();
    row = rows.find(r => normalizeProjectPath(r.path) === normalized) || null;
  }
  if (!row) return null;
  if (row.config_json) {
    try { row.config = JSON.parse(row.config_json); } catch { row.config = null; }
  }
  return row;
}

function listProjects(filter) {
  const database = getDb();
  let sql = 'SELECT * FROM factory_projects';
  const params = [];
  if (filter?.status) {
    sql += ' WHERE status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY updated_at DESC';
  const rows = database.prepare(sql).all(...params);
  for (const row of rows) {
    if (row.config_json) {
      try { row.config = JSON.parse(row.config_json); } catch { row.config = null; }
    }
  }
  return rows;
}

function updateProject(id, updates) {
  const database = getDb();
  const allowed = [
    'name',
    'brief',
    'trust_level',
    'status',
    'config_json',
    'loop_state',
    'loop_batch_id',
    'loop_last_action_at',
    'loop_paused_at_stage',
    'consecutive_empty_cycles',
  ];
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

  database.prepare(`UPDATE factory_projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProject(id);
}

function recordSnapshot({ project_id, dimension, score, scan_type, details, batch_id }) {
  const info = getDb().prepare(`
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
  const rows = getDb().prepare(`
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

function getScoreHistory(projectId, dimension, limit, options = {}) {
  const order = options && options.order === 'DESC' ? 'DESC' : 'ASC';
  return getDb().prepare(`
    SELECT id, score, scan_type, batch_id, scanned_at, details_json
    FROM factory_health_snapshots
    WHERE project_id = ? AND dimension = ?
    ORDER BY scanned_at ${order}
    LIMIT ?
  `).all(projectId, dimension, limit || 100);
}

function getLatestScoresBatch(projectIds) {
  if (!projectIds || projectIds.length === 0) return new Map();

  const placeholders = projectIds.map(() => '?').join(', ');
  const rows = getDb().prepare(
    'SELECT s.project_id, s.dimension, s.score' +
    ' FROM factory_health_snapshots s' +
    ' INNER JOIN (' +
    '   SELECT project_id, dimension, MAX(id) AS max_id' +
    '   FROM factory_health_snapshots' +
    '   WHERE project_id IN (' + placeholders + ')' +
    '   GROUP BY project_id, dimension' +
    ' ) latest ON s.id = latest.max_id'
  ).all(...projectIds);

  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.project_id)) result.set(row.project_id, {});
    result.get(row.project_id)[row.dimension] = row.score;
  }
  return result;
}

function getScoreHistoryBatch(projectId, dimensions, limit) {
  const maxRows = limit || 20;
  if (!dimensions || dimensions.length === 0) return {};

  const placeholders = dimensions.map(() => '?').join(', ');
  const rows = getDb().prepare(
    'SELECT dimension, score, created_at' +
    ' FROM factory_health_snapshots' +
    ' WHERE project_id = ?' +
    ' AND dimension IN (' + placeholders + ')' +
    ' ORDER BY id DESC'
  ).all(projectId, ...dimensions);

  // Partition by dimension; enforce limit per dimension in JS
  const result = Object.fromEntries(dimensions.map((d) => [d, []]));
  for (const row of rows) {
    if (result[row.dimension] && result[row.dimension].length < maxRows) {
      result[row.dimension].push(row);
    }
  }
  return result;
}

function getLatestSnapshotIds(projectId) {
  const rows = getDb().prepare(`
    SELECT dimension, MAX(id) AS snapshot_id
    FROM factory_health_snapshots
    WHERE project_id = ?
    GROUP BY dimension
  `).all(projectId);

  const snapshotIds = {};
  for (const row of rows) {
    snapshotIds[row.dimension] = row.snapshot_id;
  }
  return snapshotIds;
}

function getBalanceScore(projectId, latestScores) {
  const scores = latestScores || getLatestScores(projectId);
  const values = Object.values(scores);
  if (values.length < 2) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

function recordFindings(snapshotId, findings) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO factory_health_findings (snapshot_id, severity, message, file_path, details_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insert = database.transaction((items) => {
    for (const f of items) {
      if (!f.message && !f.title) continue; // skip findings with no message
      stmt.run(
        snapshotId,
        f.severity || 'medium',
        f.message || f.title || 'No description',
        f.file_path || f.file || null,
        f.details ? JSON.stringify(f.details) : null,
      );
    }
  });
  insert(findings);
}

function getFindings(snapshotId) {
  return getDb().prepare(
    'SELECT * FROM factory_health_findings WHERE snapshot_id = ? ORDER BY id'
  ).all(snapshotId);
}

function getFindingsForSnapshots(snapshotIds) {
  const ids = [...new Set((snapshotIds || []).filter(Boolean))];
  if (ids.length === 0) return {};

  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT * FROM factory_health_findings
    WHERE snapshot_id IN (${placeholders})
    ORDER BY snapshot_id, id
  `).all(...ids);

  const findingsBySnapshot = {};
  for (const id of ids) {
    findingsBySnapshot[id] = [];
  }
  for (const row of rows) {
    if (!findingsBySnapshot[row.snapshot_id]) {
      findingsBySnapshot[row.snapshot_id] = [];
    }
    findingsBySnapshot[row.snapshot_id].push(row);
  }
  return findingsBySnapshot;
}

function getProjectHealthSummary(projectId) {
  const project = getProject(projectId);
  if (!project) return null;

  const scores = getLatestScores(projectId);
  const balance = getBalanceScore(projectId, scores);
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];

  return {
    project,
    scores,
    balance,
    weakest_dimension: weakest ? { dimension: weakest[0], score: weakest[1] } : null,
    dimension_count: Object.keys(scores).length,
  };
}

function getProjectPolicy(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const config = project.config_json ? JSON.parse(project.config_json) : {};
  return mergeWithDefaults(config.policy || {});
}

function setProjectPolicy(projectId, policy) {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const validation = validatePolicy(policy);
  if (!validation.valid) {
    throw new Error(`Invalid policy: ${validation.errors.join(', ')}`);
  }

  const merged = mergeWithDefaults(policy);
  const config = project.config_json ? JSON.parse(project.config_json) : {};
  config.policy = merged;

  getDb().prepare(`UPDATE factory_projects SET config_json = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(config), projectId);

  return merged;
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
  getLatestScoresBatch,
  getScoreHistory,
  getScoreHistoryBatch,
  getLatestSnapshotIds,
  getBalanceScore,
  recordFindings,
  getFindings,
  getFindingsForSnapshots,
  getProjectHealthSummary,
  getProjectPolicy,
  setProjectPolicy,
  VALID_TRUST_LEVELS,
  VALID_STATUSES,
  VALID_DIMENSIONS,
};
