'use strict';

/**
 * server/db/retrospectives.js — CRUD module for factory retrospectives.
 *
 * Follows the same DI-factory pattern as server/db/adversarial-reviews.js:
 * receives `{ db }` from the container, returns an object with query methods.
 *
 * Each retrospective summarises what happened during a single factory workflow
 * execution: cost, duration, retries, verify pass/fail counts, flaky-test
 * counts, a smoothness rating, a narrative, learnings, friction points, and
 * open items. `raw_stats` is a JSON blob for future extensibility.
 */

function createRetrospectivesCrud({ db }) {
  /**
   * Create the `retrospectives` table and its project_id index if they
   * do not already exist. Safe to call multiple times (IF NOT EXISTS).
   */
  function ensureTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retrospectives (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id        TEXT NOT NULL UNIQUE,
        project_id         TEXT,
        created_at         TEXT DEFAULT (datetime('now')),
        duration_seconds   INTEGER,
        total_cost         REAL,
        files_changed      INTEGER,
        retry_count        INTEGER,
        verify_pass_count  INTEGER,
        verify_fail_count  INTEGER,
        flaky_count        INTEGER,
        smoothness_rating  TEXT,
        narrative          TEXT,
        learnings          TEXT,
        friction_points    TEXT,
        open_items         TEXT,
        raw_stats          TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_retrospectives_project ON retrospectives(project_id)');
  }

  /**
   * Insert a retrospective row.
   *
   * JSON-typed fields (learnings, friction_points, open_items, raw_stats) are
   * accepted as either pre-serialised strings or plain JS values; the latter
   * are JSON.stringify'd automatically.
   *
   * @param {object} retro
   * @returns {number} The inserted row id.
   */
  function insertRetrospective(retro) {
    const toJson = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));

    const stmt = db.prepare(`
      INSERT INTO retrospectives (
        workflow_id, project_id, created_at,
        duration_seconds, total_cost, files_changed,
        retry_count, verify_pass_count, verify_fail_count, flaky_count,
        smoothness_rating, narrative,
        learnings, friction_points, open_items, raw_stats
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      retro.workflow_id,
      retro.project_id || null,
      retro.created_at || new Date().toISOString(),
      retro.duration_seconds ?? null,
      retro.total_cost ?? null,
      retro.files_changed ?? null,
      retro.retry_count ?? null,
      retro.verify_pass_count ?? null,
      retro.verify_fail_count ?? null,
      retro.flaky_count ?? null,
      retro.smoothness_rating || null,
      retro.narrative || null,
      toJson(retro.learnings),
      toJson(retro.friction_points),
      toJson(retro.open_items),
      toJson(retro.raw_stats),
    );

    return info.lastInsertRowid;
  }

  /**
   * Retrieve a single retrospective by its workflow id.
   *
   * @param {string} workflowId
   * @returns {object|null}
   */
  function getByWorkflowId(workflowId) {
    return db.prepare('SELECT * FROM retrospectives WHERE workflow_id = ?').get(workflowId) || null;
  }

  /**
   * List retrospectives for a project, paginated, newest first.
   *
   * @param {string} projectId
   * @param {{ limit?: number, offset?: number }} [opts]
   * @returns {object[]}
   */
  function listByProject(projectId, opts = {}) {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    return db.prepare(
      'SELECT * FROM retrospectives WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(projectId, limit, offset);
  }

  /**
   * Delete a retrospective by workflow id.
   *
   * @param {string} workflowId
   * @returns {{ changes: number }}
   */
  function deleteByWorkflowId(workflowId) {
    const info = db.prepare('DELETE FROM retrospectives WHERE workflow_id = ?').run(workflowId);
    return { changes: info.changes };
  }

  return {
    ensureTable,
    insertRetrospective,
    getByWorkflowId,
    listByProject,
    deleteByWorkflowId,
  };
}

module.exports = { createRetrospectivesCrud };
