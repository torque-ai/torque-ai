'use strict';

const database = require('../../database');
const { safeJsonParse } = require('../../utils/json');

function getDbHandle() {
  return typeof database.getDbInstance === 'function' ? database.getDbInstance() : null;
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}


function serializeGateRow(row) {
  return {
    id: row.id,
    project: row.project,
    release_id: row.release_id,
    name: row.name,
    gate_type: row.gate_type,
    threshold: safeJsonParse(row.threshold, {}),
    status: row.status,
    evaluated_at: row.evaluated_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function updateGateStatus(db, gateId, status) {
  const evaluatedAt = new Date().toISOString();
  db.prepare(`
    UPDATE release_gates
    SET status = ?, evaluated_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, evaluatedAt, gateId);
  return evaluatedAt;
}

function selectPolicyEvaluations(db, project, threshold) {
  const clauses = ['project = ?'];
  const params = [project];

  const stage = normalizeString(threshold.stage);
  if (stage) {
    clauses.push('stage = ?');
    params.push(stage);
  }

  const policyIds = normalizeStringArray(threshold.policy_ids || threshold.policyIds);
  if (policyIds.length > 0) {
    clauses.push(`policy_id IN (${policyIds.map(() => '?').join(', ')})`);
    params.push(...policyIds);
  }

  const includeSuppressed = threshold.include_suppressed === true || threshold.includeSuppressed === true;
  if (!includeSuppressed) {
    clauses.push('suppressed = 0');
  }

  const windowDays = normalizeNumber(threshold.window_days || threshold.windowDays, null);
  if (windowDays && windowDays > 0) {
    const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    clauses.push('datetime(created_at) >= datetime(?)');
    params.push(windowStart);
  }

  const sql = `
    SELECT policy_id, outcome, stage, created_at
    FROM policy_evaluations
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, rowid DESC
  `;
  return db.prepare(sql).all(...params);
}

function evaluatePolicyAggregateGate(db, row, requestedProject) {
  const gate = serializeGateRow(row);
  const project = normalizeString(requestedProject) || normalizeString(row.project);
  if (!project) {
    return {
      ...gate,
      checked: false,
      passed: false,
      blocking: true,
      reason: 'project is unavailable for policy aggregate evaluation',
      metrics: {
        total_evaluations: 0,
        passing_evaluations: 0,
        pass_rate: 0,
      },
    };
  }

  const acceptedOutcomes = normalizeStringArray(
    gate.threshold.accepted_outcomes || gate.threshold.acceptedOutcomes,
  ).map((outcome) => outcome.toLowerCase());
  const normalizedAcceptedOutcomes = acceptedOutcomes.length > 0 ? acceptedOutcomes : ['pass'];
  const minimumPassRate = Math.max(
    0,
    Math.min(
      1,
      normalizeNumber(
        gate.threshold.minimum_pass_rate
          || gate.threshold.min_pass_rate
          || gate.threshold.pass_rate_min
          || gate.threshold.required_pass_rate,
        1,
      ),
    ),
  );
  const minimumEvaluations = Math.max(
    1,
    Math.floor(
      normalizeNumber(
        gate.threshold.minimum_evaluations || gate.threshold.min_evaluations,
        1,
      ),
    ),
  );

  const evaluations = selectPolicyEvaluations(db, project, gate.threshold);
  const passingEvaluations = evaluations.filter((evaluation) => (
    normalizedAcceptedOutcomes.includes(String(evaluation.outcome || '').trim().toLowerCase())
  )).length;
  const totalEvaluations = evaluations.length;
  const passRate = totalEvaluations === 0 ? 0 : passingEvaluations / totalEvaluations;
  const passed = totalEvaluations >= minimumEvaluations && passRate >= minimumPassRate;
  const evaluatedAt = updateGateStatus(db, gate.id, passed ? 'passed' : 'failed');

  return {
    ...gate,
    status: passed ? 'passed' : 'failed',
    evaluated_at: evaluatedAt,
    checked: true,
    passed,
    blocking: !passed,
    reason: passed
      ? null
      : totalEvaluations < minimumEvaluations
        ? `policy aggregate has ${totalEvaluations} evaluations; requires at least ${minimumEvaluations}`
        : `policy aggregate pass rate ${passRate.toFixed(2)} is below required ${minimumPassRate.toFixed(2)}`,
    metrics: {
      total_evaluations: totalEvaluations,
      passing_evaluations: passingEvaluations,
      pass_rate: passRate,
      minimum_pass_rate: minimumPassRate,
      minimum_evaluations: minimumEvaluations,
      accepted_outcomes: normalizedAcceptedOutcomes,
    },
  };
}

function evaluateManualSignOffGate(row) {
  const gate = serializeGateRow(row);
  const passed = gate.status === 'passed' || gate.status === 'bypassed';
  return {
    ...gate,
    checked: true,
    passed,
    blocking: !passed,
    reason: passed ? null : 'manual sign-off has not been marked as passed',
    metrics: {
      manually_signed_off: gate.status === 'passed',
    },
  };
}

function evaluatePlaceholderGate(row, reason) {
  const gate = serializeGateRow(row);
  const passed = gate.status === 'passed' || gate.status === 'bypassed';
  return {
    ...gate,
    checked: false,
    passed,
    blocking: !passed,
    reason,
    metrics: null,
  };
}

function evaluateSingleGate(db, row, project) {
  if (row.status === 'bypassed') {
    const gate = serializeGateRow(row);
    return {
      ...gate,
      checked: true,
      passed: true,
      blocking: false,
      reason: 'gate was bypassed',
      metrics: null,
    };
  }

  switch (row.gate_type) {
    case 'policy_aggregate':
      return evaluatePolicyAggregateGate(db, row, project);
    case 'manual_sign_off':
      return evaluateManualSignOffGate(row);
    case 'test_coverage':
      return evaluatePlaceholderGate(row, 'not implemented');
    case 'approval_count':
      return evaluatePlaceholderGate(row, 'not implemented');
    default:
      return evaluatePlaceholderGate(row, 'unknown gate type');
  }
}

function evaluateGates(releaseId, project) {
  const normalizedReleaseId = normalizeString(releaseId);
  const db = getDbHandle();

  if (!db || !normalizedReleaseId) {
    return {
      gates: [],
      all_passed: false,
      blocking_gates: [],
    };
  }

  const gates = db.prepare(`
    SELECT *
    FROM release_gates
    WHERE release_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(normalizedReleaseId);

  if (gates.length === 0) {
    return {
      gates: [],
      all_passed: true,
      blocking_gates: [],
    };
  }

  const evaluatedGates = gates.map((gate) => evaluateSingleGate(db, gate, project));
  const blockingGates = evaluatedGates.filter((gate) => gate.blocking);

  return {
    gates: evaluatedGates,
    all_passed: blockingGates.length === 0,
    blocking_gates: blockingGates,
  };
}

function createReleaseGateAdapter() {
  return { evaluateGates };
}

module.exports = {
  evaluateGates,
  createReleaseGateAdapter,
};
