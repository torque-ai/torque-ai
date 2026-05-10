'use strict';

const logger = require('../../logger').child({ component: 'factory-decisions' });

const VALID_STAGES = new Set(['sense', 'prioritize', 'plan', 'execute', 'verify', 'learn', 'ship']);
const VALID_ACTORS = new Set(['health_model', 'architect', 'planner', 'executor', 'verifier', 'human', 'auto-recovery']);
const DEFAULT_DECISION_RETENTION_DAYS = 14;
const DEFAULT_MAX_DECISIONS = 100000;
const DEFAULT_MAX_DECISIONS_PER_PROJECT = 25000;

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
      const { defaultContainer } = require('../../container');
      if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('db')) {
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
    throw new Error('Factory decisions requires an active database connection');
  }
  return instance;
}

function recordDecision({
  project_id,
  stage,
  actor,
  action,
  reasoning,
  inputs,
  outcome,
  confidence,
  batch_id,
}) {
  if (!project_id) throw new Error('project_id is required');
  if (!stage) throw new Error('stage is required');
  if (!actor) throw new Error('actor is required');
  if (!action) throw new Error('action is required');
  validateStage(stage);
  validateActor(actor);

  const instance = getDb();
  const info = instance.prepare(`
    INSERT INTO factory_decisions (
      project_id,
      stage,
      actor,
      action,
      reasoning,
      inputs_json,
      outcome_json,
      confidence,
      batch_id,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project_id,
    stage,
    actor,
    action,
    reasoning || null,
    serializeJson(inputs),
    serializeJson(outcome),
    normalizeConfidence(confidence),
    batch_id || null,
    new Date().toISOString(),
  );

  return getDecision(info.lastInsertRowid);
}

function listDecisions(project_id, { stage, actor, since, limit } = {}) {
  if (!project_id) throw new Error('project_id is required');
  if (stage) validateStage(stage);
  if (actor) validateActor(actor);
  if (since !== undefined && (typeof since !== 'string' || !since.trim())) {
    throw new Error('since must be a non-empty ISO date string');
  }

  const instance = getDb();
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 100;
  const params = [project_id];
  const where = ['project_id = ?'];

  if (stage) {
    where.push('stage = ?');
    params.push(stage);
  }

  if (actor) {
    where.push('actor = ?');
    params.push(actor);
  }

  if (since) {
    where.push('created_at >= ?');
    params.push(since);
  }

  const rows = instance.prepare(`
    SELECT * FROM factory_decisions
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, safeLimit);

  return rows.map(parseDecisionRow);
}

function getDecisionContext(project_id, batch_id) {
  if (!project_id) throw new Error('project_id is required');
  if (!batch_id) throw new Error('batch_id is required');

  const instance = getDb();
  const rows = instance.prepare(`
    SELECT * FROM factory_decisions
    WHERE project_id = ? AND batch_id = ?
    ORDER BY created_at ASC
  `).all(project_id, batch_id);

  return rows.map(parseDecisionRow);
}

function getDecisionStats(project_id) {
  if (!project_id) throw new Error('project_id is required');

  const instance = getDb();
  const summary = instance.prepare(`
    SELECT COUNT(*) AS total, AVG(confidence) AS avg_confidence
    FROM factory_decisions
    WHERE project_id = ?
  `).get(project_id);

  const by_stage = Object.fromEntries(Array.from(VALID_STAGES, (value) => [value, 0]));
  const by_actor = Object.fromEntries(Array.from(VALID_ACTORS, (value) => [value, 0]));

  const stageRows = instance.prepare(`
    SELECT stage, COUNT(*) AS count
    FROM factory_decisions
    WHERE project_id = ?
    GROUP BY stage
  `).all(project_id);

  for (const row of stageRows) {
    by_stage[row.stage] = row.count;
  }

  const actorRows = instance.prepare(`
    SELECT actor, COUNT(*) AS count
    FROM factory_decisions
    WHERE project_id = ?
    GROUP BY actor
  `).all(project_id);

  for (const row of actorRows) {
    by_actor[row.actor] = row.count;
  }

  return {
    total: summary?.total || 0,
    by_stage,
    by_actor,
    avg_confidence: summary?.avg_confidence === null || summary?.avg_confidence === undefined
      ? null
      : Number(summary.avg_confidence),
  };
}

function getDecision(id) {
  const instance = getDb();
  const row = instance.prepare('SELECT * FROM factory_decisions WHERE id = ?').get(id);
  return parseDecisionRow(row);
}

function cleanupFactoryDecisions(options = {}) {
  const instance = getDb();
  const retentionDays = normalizeNonNegativeInteger(
    options.daysToKeep,
    DEFAULT_DECISION_RETENTION_DAYS
  );
  const maxRows = normalizeNonNegativeInteger(
    options.maxRows,
    DEFAULT_MAX_DECISIONS
  );
  const maxRowsPerProject = normalizeNonNegativeInteger(
    options.maxRowsPerProject,
    DEFAULT_MAX_DECISIONS_PER_PROJECT
  );
  let agePruned = 0;
  let projectPruned = 0;
  let countPruned = 0;

  const before = instance.prepare('SELECT COUNT(*) AS count FROM factory_decisions').get().count || 0;

  const runCleanup = instance.transaction(() => {
    if (retentionDays > 0) {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      agePruned = instance.prepare(`
        DELETE FROM factory_decisions
        WHERE COALESCE(julianday(created_at), 0) < julianday(?)
      `).run(cutoff).changes;
    }

    if (maxRowsPerProject > 0) {
      projectPruned = instance.prepare(`
        DELETE FROM factory_decisions
        WHERE id IN (
          SELECT id
          FROM (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY project_id
                ORDER BY COALESCE(julianday(created_at), 0) DESC, id DESC
              ) AS project_rank
            FROM factory_decisions
          )
          WHERE project_rank > ?
        )
      `).run(maxRowsPerProject).changes;
    }

    if (maxRows > 0) {
      countPruned = instance.prepare(`
        DELETE FROM factory_decisions
        WHERE id IN (
          SELECT id
          FROM factory_decisions
          ORDER BY COALESCE(julianday(created_at), 0) DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `).run(maxRows).changes;
    }
  });

  runCleanup();
  const after = instance.prepare('SELECT COUNT(*) AS count FROM factory_decisions').get().count || 0;

  return {
    deleted: before - after,
    age_pruned: agePruned,
    project_pruned: projectPruned,
    count_pruned: countPruned,
    retained: after,
    retention_days: retentionDays,
    max_rows: maxRows,
    max_rows_per_project: maxRowsPerProject,
  };
}

function parseDecisionRow(row) {
  if (!row) return null;

  const fields = [
    ['inputs_json', 'inputs'],
    ['outcome_json', 'outcome'],
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
        { decision_id: row.id, field: jsonField, err: error.message },
        'Failed to parse factory decision JSON field'
      );
      row[parsedField] = null;
    }
  }

  return row;
}

function serializeJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error('confidence must be a finite number');
  }
  return numeric;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function validateStage(stage) {
  if (!VALID_STAGES.has(stage)) {
    throw new Error(`Invalid stage: ${stage}`);
  }
}

function validateActor(actor) {
  if (!VALID_ACTORS.has(actor)) {
    throw new Error(`Invalid actor: ${actor}`);
  }
}

module.exports = {
  setDb,
  getDb,
  recordDecision,
  listDecisions,
  getDecisionContext,
  getDecisionStats,
  getDecision,
  cleanupFactoryDecisions,
  parseDecisionRow,
  serializeJson,
  normalizeConfidence,
  normalizeNonNegativeInteger,
  validateStage,
  validateActor,
};
