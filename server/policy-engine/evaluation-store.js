'use strict';

const { randomUUID } = require('crypto');
const logger = require('../logger').child({ component: 'policy-evaluation-store' });

let db;

function setDb(dbInstance) {
  db = dbInstance;
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    logger.warn(`[Policy] Failed to parse JSON payload: ${error.message}`);
    return fallback;
  }
}

function safeJsonStringify(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function normalizeRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }

  return value.trim();
}

function normalizeOptionalString(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeWindowDays(windowDays) {
  const numeric = Number(windowDays);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 7;
  }

  return numeric;
}

function resolveWindowStart(windowDays = 7) {
  const normalizedWindowDays = normalizeWindowDays(windowDays);
  return new Date(Date.now() - normalizedWindowDays * 24 * 60 * 60 * 1000).toISOString();
}

function getLatestPolicyEvaluationForTask(policyId, taskId) {
  const taskEvaluation = db.prepare(`
    SELECT id
    FROM policy_evaluations
    WHERE policy_id = ?
      AND target_type = 'task'
      AND target_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(policyId, taskId);

  if (taskEvaluation) {
    return taskEvaluation;
  }

  return db.prepare(`
    SELECT id
    FROM policy_evaluations
    WHERE policy_id = ?
      AND target_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(policyId, taskId);
}

function hydratePolicyOverride(row) {
  if (!row) return null;
  return {
    ...row,
    task_id: row.task_id || null,
    reason: row.reason || row.notes || null,
    overridden_by: row.overridden_by || row.actor || 'operator',
  };
}

function hydratePolicyEvaluation(row, options = {}) {
  if (!row) return null;

  const evaluation = {
    ...row,
    override_allowed: Boolean(row.override_allowed),
    suppressed: Boolean(row.suppressed),
    evidence: safeJsonParse(row.evidence_json, null),
    evaluation: safeJsonParse(row.evaluation_json, null),
  };

  if (options.include_overrides) {
    const overrides = listPolicyOverrides({ evaluation_id: row.id });
    evaluation.overrides = overrides;
    evaluation.latest_override = overrides[0] || null;
  }

  return evaluation;
}

function getPolicyEvaluation(evaluationId, options = {}) {
  if (!db) throw new Error('Policy evaluation store is not initialized');
  return hydratePolicyEvaluation(
    db.prepare('SELECT * FROM policy_evaluations WHERE id = ?').get(evaluationId),
    options,
  );
}

function listPolicyEvaluations(options = {}) {
  if (!db) throw new Error('Policy evaluation store is not initialized');

  const clauses = [];
  const params = [];

  if (options.project || options.project_id) {
    clauses.push('project = ?');
    params.push(String(options.project || options.project_id).trim());
  }
  if (options.policy_id) {
    clauses.push('policy_id = ?');
    params.push(String(options.policy_id).trim());
  }
  if (options.profile_id) {
    clauses.push('profile_id = ?');
    params.push(String(options.profile_id).trim());
  }
  if (options.stage) {
    clauses.push('stage = ?');
    params.push(String(options.stage).trim());
  }
  if (options.outcome) {
    clauses.push('outcome = ?');
    params.push(String(options.outcome).trim());
  }
  if (options.suppressed !== undefined) {
    clauses.push('suppressed = ?');
    params.push(options.suppressed ? 1 : 0);
  }
  if (options.target_type) {
    clauses.push('target_type = ?');
    params.push(String(options.target_type).trim());
  }
  if (options.target_id) {
    clauses.push('target_id = ?');
    params.push(String(options.target_id).trim());
  }
  if (options.scope_fingerprint) {
    clauses.push('scope_fingerprint = ?');
    params.push(String(options.scope_fingerprint).trim());
  }

  let sql = 'SELECT * FROM policy_evaluations';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY created_at DESC, rowid DESC';

  let appliedLimit = false;
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(Math.max(1, Number(options.limit || 50)));
    appliedLimit = true;
  }
  if (options.offset !== undefined) {
    if (!appliedLimit) {
      sql += ' LIMIT ?';
      params.push(-1);
    }
    sql += ' OFFSET ?';
    params.push(Math.max(0, Number(options.offset || 0)));
  }

  return db.prepare(sql).all(...params).map((row) => hydratePolicyEvaluation(row, options));
}

function updatePolicyEvaluation(evaluationId, updates = {}) {
  if (!db) throw new Error('Policy evaluation store is not initialized');

  const fields = [];
  const values = [];
  const allowed = [
    'mode',
    'outcome',
    'severity',
    'message',
    'project',
    'scope_fingerprint',
    'replay_of_evaluation_id',
    'suppression_reason',
  ];

  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    fields.push(`${key} = ?`);
    values.push(updates[key]);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'evidence')) {
    fields.push('evidence_json = ?');
    values.push(safeJsonStringify(updates.evidence));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'evaluation')) {
    fields.push('evaluation_json = ?');
    values.push(safeJsonStringify(updates.evaluation));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'override_allowed')) {
    fields.push('override_allowed = ?');
    values.push(updates.override_allowed ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'suppressed')) {
    fields.push('suppressed = ?');
    values.push(updates.suppressed ? 1 : 0);
  }

  if (fields.length === 0) {
    return getPolicyEvaluation(evaluationId);
  }

  values.push(evaluationId);
  db.prepare(`UPDATE policy_evaluations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getPolicyEvaluation(evaluationId, { include_overrides: true });
}

function createPolicyEvaluation(record) {
  if (!db) throw new Error('Policy evaluation store is not initialized');
  if (!record || typeof record !== 'object') {
    throw new Error('policy evaluation record must be an object');
  }

  const evaluationId = record.id || randomUUID();
  const createdAt = record.created_at || new Date().toISOString();

  db.prepare(`
    INSERT INTO policy_evaluations (
      id, policy_id, profile_id, stage, target_type, target_id, project,
      mode, outcome, severity, message, evidence_json, evaluation_json, override_allowed,
      scope_fingerprint, replay_of_evaluation_id, suppressed, suppression_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evaluationId,
    record.policy_id,
    record.profile_id || null,
    record.stage,
    record.target_type,
    record.target_id,
    record.project || null,
    record.mode,
    record.outcome,
    record.severity || null,
    record.message || null,
    safeJsonStringify(record.evidence),
    safeJsonStringify(record.evaluation),
    record.override_allowed ? 1 : 0,
    record.scope_fingerprint || null,
    record.replay_of_evaluation_id || null,
    record.suppressed ? 1 : 0,
    record.suppression_reason || null,
    createdAt,
  );

  return getPolicyEvaluation(evaluationId, { include_overrides: true });
}

function getLatestPolicyEvaluationForScope(options = {}) {
  if (!db) throw new Error('Policy evaluation store is not initialized');

  const policyId = String(options.policy_id || '').trim();
  const stage = String(options.stage || '').trim();
  const targetType = String(options.target_type || '').trim();
  const targetId = String(options.target_id || '').trim();
  const scopeFingerprint = String(options.scope_fingerprint || '').trim();

  if (!policyId || !stage || !targetType || !targetId || !scopeFingerprint) {
    return null;
  }

  const clauses = [
    'policy_id = ?',
    'stage = ?',
    'target_type = ?',
    'target_id = ?',
    'scope_fingerprint = ?',
  ];
  const params = [policyId, stage, targetType, targetId, scopeFingerprint];

  if (options.exclude_evaluation_id) {
    clauses.push('id != ?');
    params.push(String(options.exclude_evaluation_id).trim());
  }

  const sql = `
    SELECT * FROM policy_evaluations
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `;
  return hydratePolicyEvaluation(db.prepare(sql).get(...params), options);
}

function getPolicyOverride(overrideId) {
  if (!db) throw new Error('Policy evaluation store is not initialized');
  return hydratePolicyOverride(
    db.prepare('SELECT * FROM policy_overrides WHERE id = ?').get(overrideId),
  );
}

function listPolicyOverrides(options = {}) {
  if (!db) throw new Error('Policy evaluation store is not initialized');

  const clauses = [];
  const params = [];

  if (options.evaluation_id) {
    clauses.push('evaluation_id = ?');
    params.push(String(options.evaluation_id).trim());
  }
  if (options.policy_id) {
    clauses.push('policy_id = ?');
    params.push(String(options.policy_id).trim());
  }
  if (options.task_id) {
    clauses.push('task_id = ?');
    params.push(String(options.task_id).trim());
  }

  let sql = 'SELECT * FROM policy_overrides';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY created_at DESC, rowid DESC';

  return db.prepare(sql).all(...params).map(hydratePolicyOverride);
}

function recordOverride(policyId, taskId, reason, overriddenBy = 'operator') {
  if (!db) throw new Error('Policy evaluation store is not initialized');

  const normalizedPolicyId = normalizeRequiredString(policyId, 'policyId');
  const normalizedTaskId = normalizeRequiredString(taskId, 'taskId');
  const normalizedReason = normalizeRequiredString(reason, 'reason');
  const normalizedOverriddenBy = normalizeOptionalString(overriddenBy, 'overriddenBy') || 'operator';
  const evaluation = getLatestPolicyEvaluationForTask(normalizedPolicyId, normalizedTaskId);

  if (!evaluation) {
    throw new Error(`Policy evaluation not found for policy ${normalizedPolicyId} and task ${normalizedTaskId}`);
  }

  const overrideId = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO policy_overrides (
      id, evaluation_id, policy_id, task_id, reason, overridden_by,
      decision, reason_code, notes, actor, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrideId,
    evaluation.id,
    normalizedPolicyId,
    normalizedTaskId,
    normalizedReason,
    normalizedOverriddenBy,
    'override',
    'manual_override',
    normalizedReason,
    normalizedOverriddenBy,
    createdAt,
  );

  return getPolicyOverride(overrideId);
}

function getOverrideRate(policyId, windowDays = 7) {
  if (!db) throw new Error('Policy evaluation store is not initialized');

  const normalizedPolicyId = normalizeRequiredString(policyId, 'policyId');
  const windowStart = resolveWindowStart(windowDays);

  const totalEvaluations = db.prepare(`
    SELECT COUNT(*) AS count
    FROM policy_evaluations
    WHERE policy_id = ?
      AND datetime(created_at) >= datetime(?)
  `).get(normalizedPolicyId, windowStart).count;

  const overrides = db.prepare(`
    SELECT COUNT(*) AS count
    FROM policy_overrides
    WHERE policy_id = ?
      AND COALESCE(decision, 'override') = 'override'
      AND datetime(created_at) >= datetime(?)
  `).get(normalizedPolicyId, windowStart).count;

  return {
    total_evaluations: totalEvaluations,
    overrides,
    rate: totalEvaluations === 0 ? 0 : overrides / totalEvaluations,
  };
}

function createPolicyOverride(override) {
  if (!db) throw new Error('Policy evaluation store is not initialized');
  if (!override || typeof override !== 'object') {
    throw new Error('policy override must be an object');
  }
  if (!override.evaluation_id || typeof override.evaluation_id !== 'string') {
    throw new Error('override.evaluation_id is required');
  }
  if (!override.reason_code || typeof override.reason_code !== 'string') {
    throw new Error('override.reason_code is required');
  }

  const evaluation = getPolicyEvaluation(override.evaluation_id, { include_overrides: false });
  if (!evaluation) {
    throw new Error(`Policy evaluation not found: ${override.evaluation_id}`);
  }
  if (!evaluation.override_allowed) {
    throw new Error(`Policy evaluation ${override.evaluation_id} does not allow overrides`);
  }

  const overrideId = override.id || randomUUID();
  const createdAt = override.created_at || new Date().toISOString();
  const policyId = override.policy_id || evaluation.policy_id;
  if (policyId !== evaluation.policy_id) {
    throw new Error(`Override policy_id ${policyId} does not match evaluation policy_id ${evaluation.policy_id}`);
  }
  const allowedReasonCodes = Array.isArray(evaluation.evaluation?.override_policy?.reason_codes)
    ? evaluation.evaluation.override_policy.reason_codes.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  if (allowedReasonCodes.length > 0 && !allowedReasonCodes.includes(override.reason_code)) {
    throw new Error(
      `Override reason_code ${override.reason_code} is not allowed for policy ${evaluation.policy_id}`,
    );
  }

  db.prepare(`
    INSERT INTO policy_overrides (
      id, evaluation_id, policy_id, decision, reason_code, notes, actor, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrideId,
    override.evaluation_id,
    policyId,
    override.decision || 'override',
    override.reason_code,
    override.notes || null,
    override.actor || null,
    override.expires_at || null,
    createdAt,
  );

  const nextEvaluationPayload = {
    ...(evaluation.evaluation || {}),
    override: {
      override_id: overrideId,
      decision: override.decision || 'override',
      reason_code: override.reason_code,
      notes: override.notes || null,
      actor: override.actor || null,
      expires_at: override.expires_at || null,
      created_at: createdAt,
    },
  };

  if ((override.decision || 'override') === 'override') {
    updatePolicyEvaluation(override.evaluation_id, {
      outcome: 'overridden',
      evaluation: nextEvaluationPayload,
    });
  } else {
    updatePolicyEvaluation(override.evaluation_id, {
      evaluation: nextEvaluationPayload,
    });
  }

  return {
    override: getPolicyOverride(overrideId),
    evaluation: getPolicyEvaluation(override.evaluation_id, { include_overrides: true }),
  };
}

module.exports = {
  setDb,
  createPolicyEvaluation,
  updatePolicyEvaluation,
  getPolicyEvaluation,
  getLatestPolicyEvaluationForScope,
  listPolicyEvaluations,
  recordOverride,
  getOverrideRate,
  createPolicyOverride,
  getPolicyOverride,
  listPolicyOverrides,
};
