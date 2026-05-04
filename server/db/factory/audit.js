'use strict';

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function assertDb() {
  if (!db) throw new Error('factory-audit: DB not initialized');
}

function recordAuditEvent({ project_id, event_type, previous_status = null, reason = null, actor = null, source = null }) {
  assertDb();
  if (!project_id) throw new Error('project_id required');
  if (!event_type) throw new Error('event_type required');
  const stmt = db.prepare(
    'INSERT INTO factory_audit_events (project_id, event_type, previous_status, reason, actor, source) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(project_id, event_type, previous_status, reason, actor, source);
  return { id: result.lastInsertRowid, project_id, event_type, previous_status, reason, actor, source };
}

function listAuditEvents({ project_id = null, event_type = null, limit = 100 } = {}) {
  assertDb();
  const clauses = [];
  const params = [];
  if (project_id) { clauses.push('project_id = ?'); params.push(project_id); }
  if (event_type) { clauses.push('event_type = ?'); params.push(event_type); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = 'SELECT * FROM factory_audit_events ' + where + ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
  return db.prepare(sql).all(...params);
}

module.exports = { setDb, recordAuditEvent, listAuditEvents };
