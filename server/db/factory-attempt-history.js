'use strict';

let db = null;

function setDb(dbInstance) { db = dbInstance; }

function resolveDbHandle(candidate) {
  if (!candidate) return null;
  if (typeof candidate.prepare === 'function') return candidate;
  if (typeof candidate.getDbInstance === 'function') return candidate.getDbInstance();
  if (typeof candidate.getDb === 'function') return candidate.getDb();
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
    } catch { /* fall through */ }
  }
  if (!instance) {
    try {
      const database = require('../database');
      instance = resolveDbHandle(database);
    } catch { /* surface error below */ }
  }
  if (instance) db = instance;
  if (!instance || typeof instance.prepare !== 'function') {
    throw new Error('factory-attempt-history requires an active database connection');
  }
  return instance;
}

const VALID_KINDS = new Set(['execute', 'verify_retry']);
const VALID_SOURCES = new Set(['heuristic', 'llm', 'none']);

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function appendRow({
  batch_id, work_item_id, kind, task_id,
  files_touched = [], stdout_tail = null,
  zero_diff_reason = null, classifier_source = 'none', classifier_conf = null,
  verify_output_tail = null,
}) {
  requireText(batch_id, 'batch_id');
  requireText(work_item_id, 'work_item_id');
  requireText(task_id, 'task_id');
  if (!VALID_KINDS.has(kind)) throw new Error(`kind must be one of ${[...VALID_KINDS]}`);
  if (!VALID_SOURCES.has(classifier_source)) throw new Error(`classifier_source must be one of ${[...VALID_SOURCES]}`);

  const database = getDb();
  const nextAttempt = database.prepare(
    'SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM factory_attempt_history WHERE work_item_id = ?'
  ).get(work_item_id).next;

  const filesJson = JSON.stringify(files_touched || []);
  const fileCount = Array.isArray(files_touched) ? files_touched.length : 0;
  const now = new Date().toISOString();

  const info = database.prepare(`
    INSERT INTO factory_attempt_history
      (batch_id, work_item_id, attempt, kind, task_id, files_touched, file_count,
       stdout_tail, zero_diff_reason, classifier_source, classifier_conf,
       verify_output_tail, created_at)
    VALUES (@batch_id, @work_item_id, @attempt, @kind, @task_id, @files_touched, @file_count,
            @stdout_tail, @zero_diff_reason, @classifier_source, @classifier_conf,
            @verify_output_tail, @created_at)
  `).run({
    batch_id, work_item_id, attempt: nextAttempt, kind, task_id,
    files_touched: filesJson, file_count: fileCount,
    stdout_tail, zero_diff_reason, classifier_source,
    classifier_conf, verify_output_tail, created_at: now,
  });

  return {
    id: info.lastInsertRowid, batch_id, work_item_id, attempt: nextAttempt, kind, task_id,
    files_touched: files_touched || [], file_count: fileCount,
    stdout_tail, zero_diff_reason, classifier_source, classifier_conf,
    verify_output_tail, created_at: now,
  };
}

function decodeRow(row) {
  if (!row) return null;
  let files = [];
  try { files = row.files_touched ? JSON.parse(row.files_touched) : []; } catch { files = []; }
  return { ...row, files_touched: files };
}

// The loop-controller calls getLatestForBatch in the EXECUTE -> VERIFY
// transition. Environments that have not yet seen migration 30 do not
// have the table — in that case there is simply "no prior attempt" and
// the caller should treat it as such rather than propagating a SQLite
// error and halting the loop.
function isMissingTableError(err) {
  const msg = err && typeof err.message === 'string' ? err.message : '';
  return /no such table:\s*(main\.)?factory_attempt_history/i.test(msg);
}

function listByBatch(batch_id) {
  try {
    return getDb().prepare(
      'SELECT * FROM factory_attempt_history WHERE batch_id = ? ORDER BY attempt ASC'
    ).all(batch_id).map(decodeRow);
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

function listByWorkItem(work_item_id, { limit = 10 } = {}) {
  try {
    return getDb().prepare(
      'SELECT * FROM factory_attempt_history WHERE work_item_id = ? ORDER BY attempt DESC LIMIT ?'
    ).all(work_item_id, limit).map(decodeRow);
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

function getLatestForBatch(batch_id) {
  try {
    const row = getDb().prepare(
      'SELECT * FROM factory_attempt_history WHERE batch_id = ? ORDER BY attempt DESC LIMIT 1'
    ).get(batch_id);
    return decodeRow(row);
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

function updateVerifyOutputTail(rowId, tail) {
  try {
    getDb().prepare('UPDATE factory_attempt_history SET verify_output_tail = ? WHERE id = ?').run(tail, rowId);
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }
}

module.exports = { setDb, appendRow, listByBatch, listByWorkItem, getLatestForBatch, updateVerifyOutputTail };
