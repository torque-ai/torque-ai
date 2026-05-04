'use strict';

const logger = require('../logger').child({ component: 'factory-guardrails' });

const VALID_STATUSES = new Set(['pass', 'warn', 'fail']);
const GUARDRAIL_CATEGORIES = ['scope', 'quality', 'resource', 'silent_failure', 'security', 'conflict', 'control'];
const VALID_CATEGORIES = new Set(GUARDRAIL_CATEGORIES);

let db = null;

function setDb(dbInstance) {
  db = resolveDbHandle(dbInstance);
}

// Container-friendly handle resolver: accept a raw better-sqlite3 instance,
// the database.js module (which exposes getDbInstance), or a generic getter
// object (getDb()). Mirrors factory-worktrees.js. Required because
// container.js registers `db` as the whole database module, not the raw
// prepared-statement handle — guardrails used to see the module, miss the
// .prepare method, and throw "Factory guardrails requires an active
// database connection" even though the DB was fully initialized.
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
      if (defaultContainer && defaultContainer.has && defaultContainer.has('db')) {
        instance = resolveDbHandle(defaultContainer.get('db'));
      }
    } catch {
      // Let the explicit error below surface if no active DB is available.
    }
  }
  if (instance) {
    db = instance;
  }

  if (!instance || typeof instance.prepare !== 'function') {
    throw new Error('Factory guardrails requires an active database connection');
  }

  return instance;
}

function recordEvent({ project_id, category, check_name, status, details, batch_id }) {
  if (!project_id) throw new Error('project_id is required');
  if (!VALID_CATEGORIES.has(category)) throw new Error(`Invalid category: ${category}`);
  if (!check_name || typeof check_name !== 'string') throw new Error('check_name is required');
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
  if (details !== undefined && details !== null && (typeof details !== 'object' || Array.isArray(details))) {
    throw new Error('details must be an object');
  }

  const info = getDb().prepare(`
    INSERT INTO factory_guardrail_events (project_id, category, check_name, status, details_json, batch_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    project_id,
    category,
    check_name,
    status,
    details ? JSON.stringify(details) : null,
    batch_id || null,
  );

  return getEvent(info.lastInsertRowid);
}

function getEvents(project_id, { category, status, batch_id, limit, offset } = {}) {
  if (!project_id) throw new Error('project_id is required');
  if (category && !VALID_CATEGORIES.has(category)) throw new Error(`Invalid category: ${category}`);
  if (status && !VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const params = [project_id];
  const instance = getDb();
  let sql = `
    SELECT * FROM factory_guardrail_events
    WHERE project_id = ?
  `;

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (batch_id !== undefined) {
    sql += ' AND batch_id = ?';
    params.push(batch_id ?? null);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(safeLimit, safeOffset);

  return instance.prepare(sql).all(...params).map(parseEvent);
}

function getLatestByCategory(project_id) {
  if (!project_id) throw new Error('project_id is required');

  const rows = getDb().prepare(`
    SELECT * FROM factory_guardrail_events
    WHERE id IN (
      SELECT MAX(id) FROM factory_guardrail_events
      WHERE project_id = ?
      GROUP BY category
    )
    ORDER BY created_at DESC
  `).all(project_id);

  return rows.map(parseEvent);
}

function getGuardrailStatus(project_id) {
  if (!project_id) throw new Error('project_id is required');

  const status = Object.fromEntries(GUARDRAIL_CATEGORIES.map(category => [category, 'green']));
  for (const event of getLatestByCategory(project_id)) {
    if (event.status === 'fail') status[event.category] = 'red';
    else if (event.status === 'warn') status[event.category] = 'yellow';
    else status[event.category] = 'green';
  }

  return status;
}

function clearEvents(project_id) {
  if (!project_id) throw new Error('project_id is required');
  const info = getDb().prepare('DELETE FROM factory_guardrail_events WHERE project_id = ?').run(project_id);
  return info.changes;
}

function getEvent(id) {
  const row = getDb().prepare('SELECT * FROM factory_guardrail_events WHERE id = ?').get(id);
  return parseEvent(row);
}

function parseEvent(row) {
  if (!row) return null;
  if (row.details_json) {
    try {
      row.details = JSON.parse(row.details_json);
    } catch (error) {
      logger.warn({ event_id: row.id, err: error.message }, 'Failed to parse guardrail event details');
      row.details = null;
    }
  } else {
    row.details = null;
  }
  return row;
}

module.exports = {
  setDb,
  recordEvent,
  getEvents,
  getLatestByCategory,
  getGuardrailStatus,
  clearEvents,
};
