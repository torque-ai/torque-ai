'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger').child({ component: 'factory-intake' });

const VALID_SOURCES = new Set([
  'conversational', 'conversation',
  'github_issue', 'github',
  'scheduled_scan', 'scout',
  'self_generated', 'ci',
  'api', 'webhook', 'manual',
  'plan_file', 'architect',
]);
const VALID_STATUSES = new Set([
  'pending', 'triaged', 'in_progress', 'completed', 'rejected',
  'intake', 'prioritized', 'planned', 'executing', 'verifying', 'shipped',
  'shipped_stale', 'unactionable',
]);
const REJECT_REASONS = Object.freeze(new Set([
  'meta_task_no_code_output',
  'zero_diff_across_retries',
  'retry_off_scope',
  'branch_stale_vs_master',
]));
const CLOSED_STATUSES = new Set(['completed', 'rejected', 'shipped', 'unactionable']);
const PRIORITY_LEVELS = Object.freeze({
  low: 30,
  default: 50,
  medium: 70,
  architect_assigned: 80,
  high: 90,
  user_override: 100,
});
const VALID_PRIORITIES = new Set(Object.keys(PRIORITY_LEVELS));
const META_TASK_TITLE_PATTERNS = Object.freeze([
  /\b(?:create|add|write|open)\s+(?:an?\s+)?intake\b.*\b(?:re-?enable|restore|recover)\b.*\b(?:verification|test)\s+coverage\b/i,
  /\b(?:re-?enable|restore|recover)\b.*\b(?:verification|test)\s+coverage\b.*\bintake\b/i,
]);

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function isMetaTaskTitle(title) {
  if (typeof title !== 'string') return false;
  const normalized = title.trim();
  if (!normalized) return false;
  return META_TASK_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function createMetaTaskError(title) {
  const err = new Error(`Rejected meta intake item with no expected code output: ${title}`);
  err.code = 'FACTORY_META_TASK_NO_CODE_OUTPUT';
  err.reason = 'meta_task_no_code_output';
  return err;
}

function normalizePriority(priority, fallback = PRIORITY_LEVELS.default) {
  if (priority === undefined || priority === null || priority === '') {
    return fallback;
  }
  if (typeof priority === 'number' && Number.isFinite(priority)) {
    return Math.round(priority);
  }
  if (typeof priority === 'string' && Object.prototype.hasOwnProperty.call(PRIORITY_LEVELS, priority)) {
    return PRIORITY_LEVELS[priority];
  }
  throw new Error(`Invalid priority: ${priority}`);
}

function createWorkItem({
  project_id,
  source,
  origin,
  origin_json,
  title,
  description,
  priority,
  requestor,
  constraints,
  status,
}) {
  if (!project_id) throw new Error('project_id is required');
  if (!title || typeof title !== 'string') throw new Error('title is required');
  if (source && !VALID_SOURCES.has(source)) throw new Error(`Invalid source: ${source}`);
  if (status && !VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
  if (isMetaTaskTitle(title)) throw createMetaTaskError(title);

  // Table uses INTEGER AUTOINCREMENT id and INTEGER priority (from migration v14)
  const numericPriority = normalizePriority(priority);
  const now = new Date().toISOString();
  const serializedOrigin = origin_json != null
    ? (typeof origin_json === 'string' ? origin_json : JSON.stringify(origin_json))
    : (origin ? JSON.stringify(origin) : null);
  const info = db.prepare(`
    INSERT INTO factory_work_items (project_id, source, origin_json, title, description, priority, requestor, constraints_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project_id,
    source || 'conversation',
    serializedOrigin,
    title,
    description || null,
    numericPriority,
    requestor || null,
    constraints ? JSON.stringify(constraints) : null,
    status || 'pending',
    now,
    now,
  );

  return getWorkItem(info.lastInsertRowid);
}

function getWorkItem(id) {
  const row = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(id);
  if (!row) return null;
  return parseWorkItem(row);
}

function getWorkItemForProject(project_id, id, { includeClosed = false } = {}) {
  if (!project_id) throw new Error('project_id is required');

  const item = getWorkItem(id);
  if (!item || item.project_id !== project_id) {
    return null;
  }

  if (!includeClosed && CLOSED_STATUSES.has(item.status)) {
    return null;
  }

  return item;
}

function parseWorkItem(row) {
  if (row.origin_json) {
    try { row.origin = JSON.parse(row.origin_json); } catch { row.origin = null; }
  }
  if (row.constraints_json) {
    try { row.constraints = JSON.parse(row.constraints_json); } catch { row.constraints = null; }
  }
  return row;
}

function listWorkItems({ project_id, status, source, limit } = {}) {
  let sql = 'SELECT * FROM factory_work_items WHERE 1=1';
  const params = [];

  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (source) { sql += ' AND source = ?'; params.push(source); }

  sql += ' ORDER BY priority DESC, created_at DESC';
  sql += ' LIMIT ?';
  params.push(limit || 100);

  return db.prepare(sql).all(...params).map(parseWorkItem);
}

function listOpenWorkItems({ project_id, limit } = {}) {
  let sql = `
    SELECT * FROM factory_work_items
    WHERE 1=1
      AND status NOT IN ('completed', 'rejected', 'shipped', 'unactionable')
  `;
  const params = [];

  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }

  sql += ' ORDER BY priority DESC, created_at DESC';
  sql += ' LIMIT ?';
  params.push(limit || 100);

  return db.prepare(sql).all(...params).map(parseWorkItem);
}

function updateWorkItem(id, updates) {
  const allowed = ['title', 'description', 'priority', 'status', 'origin_json', 'constraints_json', 'batch_id', 'reject_reason', 'linked_item_id', 'claimed_by_instance_id'];
  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    if (key === 'status' && !VALID_STATUSES.has(value)) throw new Error(`Invalid status: ${value}`);
    sets.push(`${key} = ?`);
    if (key === 'priority') {
      params.push(normalizePriority(value));
      continue;
    }
    if ((key === 'origin_json' || key === 'constraints_json') && typeof value === 'object') {
      params.push(JSON.stringify(value));
      continue;
    }
    params.push(value);
  }

  if (sets.length === 0) return getWorkItem(id);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE factory_work_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getWorkItem(id);
}

function claimWorkItem(id, instanceId) {
  if (!instanceId) {
    throw new Error('instanceId is required');
  }

  const result = db.prepare(`
    UPDATE factory_work_items
    SET claimed_by_instance_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
      AND claimed_by_instance_id IS NULL
  `).run(instanceId, id);

  return result.changes > 0 ? getWorkItem(id) : null;
}

function releaseClaimForInstance(instanceId) {
  if (!instanceId) {
    throw new Error('instanceId is required');
  }

  return db.prepare(`
    UPDATE factory_work_items
    SET claimed_by_instance_id = NULL,
        updated_at = datetime('now')
    WHERE claimed_by_instance_id = ?
  `).run(instanceId).changes;
}

function rejectWorkItem(id, reason) {
  return updateWorkItem(id, { status: 'rejected', reject_reason: reason || 'Rejected by user' });
}

function rejectWorkItemUnactionable(id, reason) {
  if (!REJECT_REASONS.has(reason)) {
    throw new Error('Invalid reject reason: ' + reason);
  }
  return updateWorkItem(id, { status: 'unactionable', reject_reason: reason });
}

function findDuplicates(project_id, title) {
  const rows = db.prepare(`
    SELECT * FROM factory_work_items
    WHERE project_id = ? AND status NOT IN ('rejected', 'shipped', 'completed', 'unactionable')
    ORDER BY created_at DESC LIMIT 50
  `).all(project_id);

  const titleLower = title.toLowerCase();
  const matches = [];
  for (const row of rows) {
    const rowTitle = (row.title || '').toLowerCase();
    if (rowTitle === titleLower) {
      matches.push({ item: parseWorkItem(row), match_type: 'exact_title' });
    } else if (titleLower.includes(rowTitle) || rowTitle.includes(titleLower)) {
      matches.push({ item: parseWorkItem(row), match_type: 'partial_title' });
    }
  }
  return matches;
}

function linkItems(id, linkedId) {
  return updateWorkItem(id, { linked_item_id: linkedId });
}

function getIntakeStats(project_id) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM factory_work_items
    WHERE project_id = ?
    GROUP BY status
  `).all(project_id);

  const stats = {};
  for (const row of rows) stats[row.status] = row.count;
  return stats;
}

function createFromFindings(project_id, findings, source) {
  const created = [];
  const skipped = [];
  const insert = db.transaction((items) => {
    for (const f of items) {
      if (!f.title && !f.message) {
        skipped.push({ reason: 'missing_title', finding: f });
        continue;
      }
      const item = createWorkItem({
        project_id,
        source: source || 'scheduled_scan',
        title: f.title || f.message,
        description: f.description || `${f.severity || 'medium'} finding: ${f.title || f.message}`,
        priority: f.severity === 'critical'
          ? PRIORITY_LEVELS.high
          : f.severity === 'high'
            ? PRIORITY_LEVELS.medium
            : PRIORITY_LEVELS.default,
        requestor: 'scout',
        origin: { type: 'finding', severity: f.severity, file: f.file },
      });
      created.push(item);
    }
  });
  insert(findings);
  // Return as array for legacy callers; attach created/skipped for richer consumers.
  // `created.skipped` is a side-channel that keeps the array-shaped contract while
  // exposing skipped details to the MCP handler.
  Object.defineProperty(created, 'skipped', { value: skipped, enumerable: false });
  return created;
}

module.exports = {
  setDb,
  isMetaTaskTitle,
  normalizePriority,
  createWorkItem,
  getWorkItem,
  getWorkItemForProject,
  parseWorkItem,
  listWorkItems,
  listOpenWorkItems,
  updateWorkItem,
  claimWorkItem,
  releaseClaimForInstance,
  rejectWorkItem,
  rejectWorkItemUnactionable,
  findDuplicates,
  linkItems,
  getIntakeStats,
  createFromFindings,
  VALID_SOURCES,
  VALID_STATUSES,
  REJECT_REASONS,
  VALID_PRIORITIES,
  CLOSED_STATUSES,
};
