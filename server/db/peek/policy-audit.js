'use strict';

const crypto = require('crypto');

let db;

function setDb(dbInstance) {
  db = dbInstance;
}

function requireDb() {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('Policy proof audit database is not initialized');
  }

  return db;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) {
          acc[key] = canonicalize(value[key]);
        }
        return acc;
      }, {});
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value) ?? null);
}

function parseJson(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getNumericValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') {
      continue;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function buildProofHash(proof) {
  if (proof === null || proof === undefined) {
    return null;
  }

  return crypto.createHash('sha256').update(stableStringify(proof)).digest('hex');
}

function normalizeDecision(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'allow':
    case 'pass':
    case 'passed':
      return 'allow';
    case 'deny':
    case 'block':
    case 'blocked':
    case 'fail':
    case 'failed':
      return 'deny';
    case 'warn':
    case 'warning':
    case 'advisory':
    case 'shadow':
      return 'warn';
    default:
      return null;
  }
}

function deriveDecision({ decision, mode, proof }) {
  const explicitDecision = normalizeDecision(decision)
    || normalizeDecision(mode)
    || normalizeDecision(proof?.decision)
    || normalizeDecision(proof?.outcome)
    || normalizeDecision(proof?.mode);

  if (explicitDecision) {
    return explicitDecision;
  }

  if (getNumericValue(proof?.blocked, 0) > 0 || getNumericValue(proof?.failed, 0) > 0) {
    return 'deny';
  }
  if (getNumericValue(proof?.warned, 0) > 0) {
    return 'warn';
  }
  if (getNumericValue(proof?.passed, 0) > 0 || getNumericValue(proof?.policies_checked, 0) > 0) {
    return 'allow';
  }

  return null;
}

function derivePolicyFamily({ policy_family, policyFamily, proof, context }) {
  const candidates = [
    policy_family,
    policyFamily,
    proof?.policy_family,
    proof?.policyFamily,
    context?.policy_family,
    context?.policyFamily,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function buildAuditContext(options = {}) {
  const context = isPlainObject(options.context) ? { ...options.context } : {};

  if (options.task_id !== undefined && !Object.prototype.hasOwnProperty.call(context, 'task_id')) {
    context.task_id = options.task_id;
  }
  if (options.workflow_id !== undefined && !Object.prototype.hasOwnProperty.call(context, 'workflow_id')) {
    context.workflow_id = options.workflow_id;
  }
  if (options.action !== undefined && !Object.prototype.hasOwnProperty.call(context, 'action')) {
    context.action = options.action;
  }
  if (options.mode !== undefined && !Object.prototype.hasOwnProperty.call(context, 'mode')) {
    context.mode = options.mode;
  }
  if (options.proof !== undefined && !Object.prototype.hasOwnProperty.call(context, 'proof')) {
    context.proof = options.proof;
  }

  return Object.keys(context).length > 0 ? context : null;
}

function getTableColumns(handle) {
  try {
    return handle.prepare('PRAGMA table_info(policy_proof_audit)').all();
  } catch {
    return [];
  }
}

function tableUsesIntegerPrimaryKey(columns) {
  const idColumn = columns.find((column) => column && column.name === 'id');
  return !!idColumn && idColumn.pk === 1 && /int/i.test(idColumn.type || '');
}

function insertModernAuditRow(handle, row) {
  const columns = getTableColumns(handle);
  const contextJson = row.context ? stableStringify(row.context) : null;

  if (tableUsesIntegerPrimaryKey(columns)) {
    const result = handle.prepare(`
      INSERT INTO policy_proof_audit (
        surface,
        proof_hash,
        policy_family,
        decision,
        context_json
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(
      row.surface,
      row.proof_hash,
      row.policy_family,
      row.decision,
      contextJson,
    );
    return Number(result.lastInsertRowid);
  }

  const id = crypto.randomUUID();
  handle.prepare(`
    INSERT INTO policy_proof_audit (
      id,
      surface,
      proof_hash,
      policy_family,
      decision,
      context_json
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    row.surface,
    row.proof_hash,
    row.policy_family,
    row.decision,
    contextJson,
  );
  return id;
}

function insertLegacyAuditRow(handle, row) {
  const id = crypto.randomUUID();
  const proof = row.context?.proof;

  handle.prepare(`
    INSERT INTO policy_proof_audit (
      id,
      surface,
      task_id,
      workflow_id,
      action,
      mode,
      policies_checked,
      passed,
      warned,
      failed,
      blocked,
      proof_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    row.surface,
    row.context?.task_id || null,
    row.context?.workflow_id || null,
    row.context?.action || null,
    row.context?.mode || null,
    getNumericValue(proof?.policies_checked, 0),
    getNumericValue(proof?.passed, 0),
    getNumericValue(proof?.warned, 0),
    getNumericValue(proof?.failed, 0),
    getNumericValue(proof?.blocked, 0),
    proof ? stableStringify(proof) : null,
  );

  return id;
}

function normalizeAuditRow(row) {
  if (!row) {
    return null;
  }

  const context = isPlainObject(row.context)
    ? row.context
    : parseJson(row.context_json);
  const proof = isPlainObject(row.proof)
    ? row.proof
    : (
      (context && Object.prototype.hasOwnProperty.call(context, 'proof') ? context.proof : null)
      || parseJson(row.proof_json)
    );

  return {
    ...row,
    proof_hash: row.proof_hash || buildProofHash(proof),
    policy_family: row.policy_family || derivePolicyFamily({ proof, context }),
    decision: normalizeDecision(row.decision) || deriveDecision({
      decision: context?.decision,
      mode: row.mode || context?.mode,
      proof,
    }),
    context_json: typeof row.context_json === 'string'
      ? row.context_json
      : (context ? stableStringify(context) : null),
    context,
    proof,
    task_id: row.task_id ?? context?.task_id ?? context?.taskId ?? null,
    workflow_id: row.workflow_id ?? context?.workflow_id ?? context?.workflowId ?? null,
    action: row.action ?? context?.action ?? null,
    mode: row.mode ?? context?.mode ?? proof?.mode ?? null,
    policies_checked: getNumericValue(row.policies_checked, proof?.policies_checked),
    passed: getNumericValue(row.passed, proof?.passed),
    warned: getNumericValue(row.warned, proof?.warned),
    failed: getNumericValue(row.failed, proof?.failed),
    blocked: getNumericValue(row.blocked, proof?.blocked),
  };
}

function formatPolicyProof(options = {}) {
  const handle = requireDb();
  const surface = typeof options.surface === 'string' ? options.surface.trim() : '';
  if (!surface) {
    throw new Error('surface is required');
  }

  const context = buildAuditContext(options);
  const row = {
    surface,
    proof_hash: buildProofHash(options.proof),
    policy_family: derivePolicyFamily({
      policy_family: options.policy_family,
      policyFamily: options.policyFamily,
      proof: options.proof,
      context,
    }),
    decision: deriveDecision({
      decision: options.decision,
      mode: options.mode,
      proof: options.proof,
    }),
    context,
  };

  const availableColumns = new Set(getTableColumns(handle).map((column) => column.name));
  const hasModernShape = availableColumns.has('proof_hash')
    && availableColumns.has('policy_family')
    && availableColumns.has('decision')
    && availableColumns.has('context_json');
  const id = hasModernShape
    ? insertModernAuditRow(handle, row)
    : insertLegacyAuditRow(handle, row);

  return getPolicyProofAudit(id) || { id, surface: row.surface };
}

function recordPolicyProofAudit(options = {}) {
  return formatPolicyProof(options);
}

function listPolicyProofAudits(options = {}) {
  const handle = requireDb();
  let query = 'SELECT * FROM policy_proof_audit WHERE 1=1';
  const values = [];

  if (options.surface) {
    query += ' AND surface = ?';
    values.push(options.surface);
  }
  if (options.since) {
    query += ' AND created_at >= ?';
    values.push(options.since);
  }

  query += ' ORDER BY created_at DESC, id DESC';

  let rows = handle.prepare(query).all(...values).map((row) => normalizeAuditRow(row));

  const taskId = typeof options.task_id === 'string' && options.task_id.trim()
    ? options.task_id.trim()
    : (typeof options.taskId === 'string' && options.taskId.trim() ? options.taskId.trim() : null);
  if (taskId) {
    rows = rows.filter((row) => row?.task_id === taskId);
  }

  if (options.limit) {
    rows = rows.slice(0, options.limit);
  }

  return rows;
}

function getPolicyProofAudit(id) {
  const row = requireDb().prepare('SELECT * FROM policy_proof_audit WHERE id = ?').get(id);
  return normalizeAuditRow(row);
}

function createPeekPolicyAudit({ db: dbInst }) {
  setDb(dbInst);
  return {
    formatPolicyProof,
    recordPolicyProofAudit,
    listPolicyProofAudits,
    getPolicyProofAudit,
  };
}

module.exports = {
  formatPolicyProof,
  setDb,
  createPeekPolicyAudit,
  recordPolicyProofAudit,
  listPolicyProofAudits,
  getPolicyProofAudit,
};
