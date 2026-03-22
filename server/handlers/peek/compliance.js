'use strict';

const crypto = require('crypto');
const database = require('../../database');
const { fireWebhookForEvent } = require('./webhook-outbound');
const { classifyActionRisk } = require('./rollback');
const logger = require('../../logger').child({ component: 'peek-compliance' });

const DEFAULT_REPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PROOF_AUDIT_LIMIT = 10000;

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getAuditPrevHash(entry) {
  return entry?.previous_hash ?? entry?.prev_hash ?? null;
}

function getAuditChainHash(entry) {
  return entry?.chain_hash ?? entry?.hash ?? null;
}

function getDatabaseHandle() {
  if (database && typeof database.prepare === 'function') {
    return database;
  }
  if (database && typeof database.getDbInstance === 'function') {
    return database.getDbInstance();
  }
  return null;
}

function tableHasColumn(handle, tableName, columnName) {
  if (!handle || typeof handle.prepare !== 'function') {
    return false;
  }

  try {
    return handle.prepare(`PRAGMA table_info(${tableName})`).all()
      .some((column) => column && column.name === columnName);
  } catch (error) {
    logger.warn(`Failed to inspect ${tableName} columns: ${error.message}`);
    return false;
  }
}

function buildStructuredAuditHash(entry) {
  const payload = {
    entityType: entry.entity_type ?? null,
    entityId: entry.entity_id ?? null,
    action: entry.action ?? null,
    actor: entry.actor ?? 'system',
    oldValue: entry.old_value ?? null,
    newValue: entry.new_value ?? null,
    metadata: entry.metadata ?? null,
    previousHash: getAuditPrevHash(entry),
    timestamp: entry.timestamp || entry.created_at || null,
  };
  return hashValue(JSON.stringify(payload));
}

function buildLegacyAuditHash(entry) {
  return hashValue(
    `${getAuditPrevHash(entry) || ''}${entry.id ?? ''}${entry.action || ''}${entry.timestamp || entry.created_at || ''}`,
  );
}

function getAuditHashCandidates(entry) {
  return new Set([
    buildStructuredAuditHash(entry),
    buildLegacyAuditHash(entry),
  ]);
}

function normalizeDateInput(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be a valid date or ISO timestamp`);
  }
  return date.toISOString();
}

function normalizeReportOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const until = options.until
    ? normalizeDateInput(options.until, 'until')
    : new Date().toISOString();
  const since = options.since
    ? normalizeDateInput(options.since, 'since')
    : new Date(Date.parse(until) - DEFAULT_REPORT_WINDOW_MS).toISOString();

  if (Date.parse(since) > Date.parse(until)) {
    throw new RangeError('since must be less than or equal to until');
  }

  const project = typeof options.project === 'string' && options.project.trim()
    ? options.project.trim()
    : null;

  return { since, until, project };
}

function sortAuditEntries(entries) {
  return [...entries].filter(Boolean).sort((left, right) => {
    const leftTime = left.timestamp || left.created_at || '';
    const rightTime = right.timestamp || right.created_at || '';
    if (leftTime !== rightTime) {
      return leftTime.localeCompare(rightTime);
    }

    const leftId = Number(left.id);
    const rightId = Number(right.id);
    if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
      return leftId - rightId;
    }

    return String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
}

function normalizeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeOptionalString(value))
    .filter(Boolean);
}

function isTruthyInteger(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return value.trim() === '1' || value.trim().toLowerCase() === 'true';
  }
  return false;
}

function rowMatchesProject(row, project) {
  if (!project) return true;
  if (row && typeof row.project === 'string' && row.project.trim()) {
    return row.project.trim() === project;
  }
  if (row && row.proof && typeof row.proof === 'object') {
    const proofProject = row.proof.project || row.proof.project_id || row.proof?.context?.project;
    if (typeof proofProject === 'string' && proofProject.trim()) {
      return proofProject.trim() === project;
    }
  }
  return true;
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

function getProofDecision(row) {
  const explicitDecision = normalizeDecision(
    row?.decision
      ?? row?.outcome
      ?? row?.result
      ?? row?.proof?.decision
      ?? row?.proof?.outcome
      ?? row?.proof?.result
      ?? null,
  );
  if (explicitDecision) {
    return explicitDecision;
  }

  if (normalizeInteger(row?.blocked ?? row?.proof?.blocked) > 0 || normalizeInteger(row?.failed ?? row?.proof?.failed) > 0) {
    return 'deny';
  }
  if (normalizeInteger(row?.warned ?? row?.proof?.warned) > 0) {
    return 'warn';
  }

  const modeDecision = normalizeDecision(row?.mode ?? row?.proof?.mode);
  if (modeDecision) {
    return modeDecision;
  }

  if (normalizeInteger(row?.passed ?? row?.proof?.passed) > 0 || normalizeInteger(row?.policies_checked ?? row?.proof?.policies_checked) > 0) {
    return 'allow';
  }

  return null;
}

function normalizeRiskLevel(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return null;
}

function toCamelCase(field) {
  return typeof field === 'string'
    ? field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    : field;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveEvidenceValue(source, field) {
  if (!isPlainObject(source) || typeof field !== 'string') {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(source, field)) {
    return source[field];
  }

  const camelCaseField = toCamelCase(field);
  if (Object.prototype.hasOwnProperty.call(source, camelCaseField)) {
    return source[camelCaseField];
  }

  return undefined;
}

function hasSufficientEvidenceValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (isPlainObject(value)) {
    return Object.keys(value).length > 0;
  }

  return true;
}

function getRequiredEvidence(row, classification) {
  const candidates = [
    row?.required_evidence,
    row?.requiredEvidence,
    row?.context?.required_evidence,
    row?.context?.requiredEvidence,
    row?.proof?.required_evidence,
    row?.proof?.requiredEvidence,
    classification?.requiredEvidence,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeStringList(candidate);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

function buildEvidenceCompleteness(row, classification) {
  const required = getRequiredEvidence(row, classification);
  const sources = [
    row,
    row?.context,
    row?.context?.evidence,
    row?.proof,
    row?.proof?.evidence,
  ].filter(Boolean);

  const provided = required.filter((field) => sources.some((source) => hasSufficientEvidenceValue(resolveEvidenceValue(source, field))));
  const missing = required.filter((field) => !provided.includes(field));
  const coveragePercent = required.length > 0
    ? Math.round((provided.length / required.length) * 100)
    : 100;

  return {
    complete: missing.length === 0,
    required,
    provided,
    missing,
    coverage_percent: coveragePercent,
  };
}

function getProofRiskLevel(row) {
  const explicitRiskLevel = normalizeRiskLevel(
    row?.risk_level
      ?? row?.context?.risk_level
      ?? row?.context?.riskLevel
      ?? row?.proof?.risk_level
      ?? row?.proof?.riskLevel
      ?? null,
  );
  if (explicitRiskLevel) {
    return explicitRiskLevel;
  }

  const action = normalizeOptionalString(row?.action);
  if (!action) {
    return 'unknown';
  }

  return normalizeRiskLevel(classifyActionRisk(action)?.level) || 'unknown';
}

function getPolicyCoveragePercent(policySummary) {
  const totalEvaluations = normalizeInteger(policySummary?.total_evaluations);
  const allowedEvaluations = normalizeInteger(policySummary?.allow ?? policySummary?.passed);
  return totalEvaluations > 0 ? Math.round((allowedEvaluations / totalEvaluations) * 100) : 0;
}

function parseProofJson(row) {
  if (!row) return null;

  if (row.proof_json) {
    try {
      return JSON.parse(row.proof_json);
    } catch (error) {
      logger.warn(`Failed to parse policy proof audit payload for ${row.id}: ${error.message}`);
      return null;
    }
  }

  if (!row.context_json) {
    return null;
  }

  try {
    const context = JSON.parse(row.context_json);
    if (context && typeof context === 'object' && !Array.isArray(context) && context.proof && typeof context.proof === 'object') {
      return context.proof;
    }
  } catch (error) {
    logger.warn(`Failed to parse policy proof audit context for ${row.id}: ${error.message}`);
  }

  return null;
}

function parseAuditContext(row) {
  if (!row || !row.context_json) return null;
  try {
    const context = JSON.parse(row.context_json);
    return context && typeof context === 'object' && !Array.isArray(context) ? context : null;
  } catch (error) {
    logger.warn(`Failed to parse policy proof audit context for ${row.id}: ${error.message}`);
    return null;
  }
}

function safeAll(handle, sql, params, label) {
  if (!handle || typeof handle.prepare !== 'function') {
    logger.warn(`Failed to read ${label}: database is not initialized`);
    return [];
  }

  try {
    return handle.prepare(sql).all(...params);
  } catch (error) {
    logger.warn(`Failed to read ${label}: ${error.message}`);
    return [];
  }
}

function readAuditEntries(handle, since, until) {
  const timeColumn = tableHasColumn(handle, 'audit_log', 'timestamp')
    ? 'timestamp'
    : (tableHasColumn(handle, 'audit_log', 'created_at') ? 'created_at' : null);

  if (!timeColumn) {
    logger.warn('Failed to read audit_log: no timestamp column available');
    return [];
  }

  return safeAll(
    handle,
    `SELECT * FROM audit_log WHERE ${timeColumn} >= ? AND ${timeColumn} <= ? ORDER BY ${timeColumn} ASC, id ASC`,
    [since, until],
    'audit_log',
  );
}

function readPolicyEvaluations(handle, since, until, project) {
  const params = [since, until];
  let sql = 'SELECT * FROM policy_evaluations WHERE created_at >= ? AND created_at <= ?';

  if (project && tableHasColumn(handle, 'policy_evaluations', 'project')) {
    sql += ' AND project = ?';
    params.push(project);
  }

  sql += ' ORDER BY created_at ASC, rowid ASC';
  return safeAll(handle, sql, params, 'policy_evaluations');
}

function normalizeProofAuditRow(row) {
  const context = row?.context || parseAuditContext(row);
  const proof = row?.proof || parseProofJson(row);
  return {
    ...row,
    context,
    proof,
    proof_hash: row?.proof_hash ?? context?.proof_hash ?? proof?.proof_hash ?? null,
    policy_family: row?.policy_family ?? context?.policy_family ?? context?.policyFamily ?? proof?.policy_family ?? proof?.policyFamily ?? null,
    decision: row?.decision ?? context?.decision ?? proof?.decision ?? proof?.outcome ?? null,
    risk_level: row?.risk_level ?? context?.risk_level ?? context?.riskLevel ?? proof?.risk_level ?? proof?.riskLevel ?? null,
    required_evidence: row?.required_evidence ?? context?.required_evidence ?? context?.requiredEvidence ?? proof?.required_evidence ?? proof?.requiredEvidence ?? null,
    task_id: row?.task_id ?? context?.task_id ?? context?.taskId ?? null,
    workflow_id: row?.workflow_id ?? context?.workflow_id ?? context?.workflowId ?? null,
    action: row?.action ?? context?.action ?? null,
    mode: row?.mode ?? context?.mode ?? proof?.mode ?? null,
    policies_checked: row?.policies_checked ?? proof?.policies_checked ?? null,
    passed: row?.passed ?? proof?.passed ?? null,
    warned: row?.warned ?? proof?.warned ?? null,
    failed: row?.failed ?? proof?.failed ?? null,
    blocked: row?.blocked ?? proof?.blocked ?? null,
  };
}

function readPolicyProofAudits(handle, since, until, project) {
  if (database && typeof database.listPolicyProofAudits === 'function') {
    try {
      return (database.listPolicyProofAudits({ since, limit: DEFAULT_PROOF_AUDIT_LIMIT }) || [])
        .map(normalizeProofAuditRow)
        .filter((row) => (row.created_at || '') <= until)
        .filter((row) => rowMatchesProject(row, project))
        .sort((left, right) => {
          const leftTime = left.created_at || '';
          const rightTime = right.created_at || '';
          if (leftTime !== rightTime) {
            return leftTime.localeCompare(rightTime);
          }
          return String(left.id ?? '').localeCompare(String(right.id ?? ''));
        });
    } catch (error) {
      logger.warn(`Failed to read proof audits via helper: ${error.message}`);
    }
  }

  const rows = safeAll(
    handle,
    'SELECT * FROM policy_proof_audit WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC, id ASC LIMIT ?',
    [since, until, DEFAULT_PROOF_AUDIT_LIMIT],
    'policy_proof_audit',
  );

  return rows
    .map(normalizeProofAuditRow)
    .filter((row) => rowMatchesProject(row, project));
}

/**
 * Verify chain integrity of audit_log entries.
 * Accepts the current structured TORQUE chain format and the legacy concatenated format.
 * Returns { verified: boolean, valid: boolean, entries_checked: number, gaps: object[], broken_at: string|number|null }
 */
function verifyAuditChain(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('entries must be an array');
  }

  const sortedEntries = sortAuditEntries(entries);
  if (sortedEntries.length === 0) {
    return {
      verified: true,
      valid: true,
      entries_checked: 0,
      gaps: [],
      broken_at: null,
    };
  }

  const gaps = [];
  for (let index = 0; index < sortedEntries.length; index += 1) {
    const entry = sortedEntries[index];
    const entryHash = getAuditChainHash(entry);
    const entryPrevHash = getAuditPrevHash(entry);

    if (!entry || !entryHash) {
      if (index > 0) {
        gaps.push({
          issue: 'missing_hash',
          entry_id: entry?.id ?? null,
          previous_entry_id: sortedEntries[index - 1]?.id ?? null,
          expected_prev_hash: getAuditChainHash(sortedEntries[index - 1]),
          actual_prev_hash: entryPrevHash ?? null,
        });
      }
      continue;
    }

    const candidates = getAuditHashCandidates(entry);
    if (!candidates.has(entryHash)) {
      gaps.push({
        issue: 'hash_mismatch',
        entry_id: entry.id ?? null,
        actual_hash: entryHash,
      });
      continue;
    }

    if (index > 0) {
      const previousEntry = sortedEntries[index - 1];
      const previousHash = getAuditChainHash(previousEntry);
      if (previousEntry && previousHash && entryPrevHash !== previousHash) {
        gaps.push({
          issue: 'prev_hash_mismatch',
          entry_id: entry.id ?? null,
          previous_entry_id: previousEntry.id ?? null,
          expected_prev_hash: previousHash,
          actual_prev_hash: entryPrevHash ?? null,
        });
      }
    }
  }

  return {
    verified: gaps.length === 0,
    valid: gaps.length === 0,
    entries_checked: sortedEntries.length,
    gaps,
    broken_at: gaps[0]?.entry_id ?? null,
  };
}

function buildPolicySummary(policyEvaluations) {
  const allow = policyEvaluations.filter((entry) => normalizeDecision(entry?.outcome ?? entry?.result ?? entry?.decision ?? entry?.mode) === 'allow').length;
  const warn = policyEvaluations.filter((entry) => normalizeDecision(entry?.outcome ?? entry?.result ?? entry?.decision ?? entry?.mode) === 'warn').length;
  const failed = policyEvaluations.filter((entry) => entry.outcome === 'fail' || entry.result === 'fail').length;
  const blocked = policyEvaluations.filter((entry) => isTruthyInteger(entry.blocked) || entry.outcome === 'block' || entry.result === 'block').length;
  const deny = policyEvaluations.filter((entry) => normalizeDecision(entry?.outcome ?? entry?.result ?? entry?.decision ?? entry?.mode) === 'deny').length;

  return {
    total_evaluations: policyEvaluations.length,
    allow,
    deny,
    warn,
    passed: allow,
    warned: warn,
    failed,
    blocked,
  };
}

function buildRiskAuditTrail(proofAudits) {
  return proofAudits.map((entry) => {
    const action = normalizeOptionalString(entry?.action);
    const classification = action ? classifyActionRisk(action) : null;
    const evidenceCompleteness = buildEvidenceCompleteness(entry, classification);

    return {
      id: entry.id,
      surface: entry.surface,
      action,
      mode: entry.mode,
      decision: getProofDecision(entry),
      risk_level: getProofRiskLevel(entry),
      policy_family: entry.policy_family ?? null,
      proof_hash: entry.proof_hash ?? null,
      evidence_complete: evidenceCompleteness.complete,
      evidence_completeness: evidenceCompleteness,
      policies_checked: normalizeInteger(entry.policies_checked ?? entry.proof?.policies_checked),
      passed: normalizeInteger(entry.passed ?? entry.proof?.passed),
      warned: normalizeInteger(entry.warned ?? entry.proof?.warned),
      failed: normalizeInteger(entry.failed ?? entry.proof?.failed),
      blocked: normalizeInteger(entry.blocked ?? entry.proof?.blocked),
      created_at: entry.created_at,
    };
  });
}

function buildRiskCounts(riskAuditTrail) {
  const counts = {
    total: 0,
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0,
  };

  if (!Array.isArray(riskAuditTrail)) {
    return counts;
  }

  for (const entry of riskAuditTrail) {
    counts.total += 1;
    const riskLevel = normalizeRiskLevel(entry?.risk_level) || 'unknown';
    counts[riskLevel] += 1;
  }

  return counts;
}

function createDefaultChainIntegrity() {
  return {
    verified: false,
    valid: false,
    entries_checked: 0,
    gaps: [],
    broken_at: null,
  };
}

function looksLikeComplianceReport(value) {
  return isPlainObject(value) && (
    normalizeOptionalString(value.report_id) !== null
    || Object.prototype.hasOwnProperty.call(value, 'chain_integrity')
    || Object.prototype.hasOwnProperty.call(value, 'policy_summary')
    || Object.prototype.hasOwnProperty.call(value, 'risk_audit_trail')
    || Object.prototype.hasOwnProperty.call(value, 'attestation_block')
  );
}

function withReportId(reportData, reportId) {
  if (!isPlainObject(reportData)) {
    return reportData;
  }

  const normalizedReportId = normalizeOptionalString(reportId) || normalizeOptionalString(reportData.report_id);

  return {
    ...reportData,
    ...(normalizedReportId ? { report_id: normalizedReportId } : {}),
    attestation_block: isPlainObject(reportData.attestation_block)
      ? {
        ...reportData.attestation_block,
        ...(normalizedReportId ? { report_id: normalizedReportId } : {}),
      }
      : reportData.attestation_block,
    attestation: isPlainObject(reportData.attestation)
      ? {
        ...reportData.attestation,
        ...(normalizedReportId ? { report_id: normalizedReportId } : {}),
      }
      : reportData.attestation,
  };
}

function resolveReportDataForAttestation(reportOrId, reportDataOrOptions) {
  if (looksLikeComplianceReport(reportOrId)) {
    return withReportId(reportOrId);
  }

  const reportId = normalizeOptionalString(reportOrId);
  if (!reportId) {
    return null;
  }

  if (looksLikeComplianceReport(reportDataOrOptions)) {
    return withReportId(reportDataOrOptions, reportId);
  }

  const generatedReport = generateComplianceReport(isPlainObject(reportDataOrOptions) ? reportDataOrOptions : {});
  return withReportId(generatedReport, reportId);
}

function getAttestationPolicyCoveragePercent(reportData) {
  const attestationCoverage = Number(reportData?.attestation_block?.policy_coverage_percent);
  if (Number.isFinite(attestationCoverage)) {
    return attestationCoverage;
  }

  return getPolicyCoveragePercent(reportData?.policy_summary);
}

/**
 * Generate a compliance report covering a date range.
 * @param {object} options - { since, until, project }
 * @returns {{ report_id, generated_at, period, chain_integrity, policy_summary, risk_audit_trail, attestation_block }}
 */
function generateComplianceReport(options = {}) {
  const { since, until, project } = normalizeReportOptions(options);
  const handle = getDatabaseHandle();
  const reportId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const generatedAt = new Date().toISOString();

  const auditEntries = readAuditEntries(handle, since, until);
  const policyEvaluations = readPolicyEvaluations(handle, since, until, project);
  const proofAudits = readPolicyProofAudits(handle, since, until, project);
  const chainIntegrity = verifyAuditChain(auditEntries);
  const policySummary = buildPolicySummary(policyEvaluations);
  const riskAuditTrail = buildRiskAuditTrail(proofAudits);
  const reportPayload = {
    report_id: reportId,
    generated_at: generatedAt,
    period: { since, until },
    chain_integrity: chainIntegrity,
    policy_summary: policySummary,
    risk_audit_trail: riskAuditTrail,
  };
  const attestationBlock = {
    report_hash: hashValue(JSON.stringify(reportPayload)),
    generated_at: generatedAt,
    chain_verified: chainIntegrity.verified,
    policy_coverage_percent: getPolicyCoveragePercent(policySummary),
    report_id: reportId,
    audit_entries_count: auditEntries.length,
    policy_evaluations_count: policyEvaluations.length,
    proof_surfaces_count: proofAudits.length,
    coverage_period: { since, until },
  };
  const report = {
    ...reportPayload,
    attestation_block: attestationBlock,
    attestation: {
      ...attestationBlock,
      chain_integrity_verified: attestationBlock.chain_verified,
      status: 'generated',
      review_status: 'pending_review',
    },
  };

  fireWebhookForEvent('peek.compliance.generated', {
    report_id: report.report_id,
  }).catch(() => {});

  return report;
}

/**
 * Export a standalone attestation from a previously generated compliance report.
 * Accepts either a report object or a report id plus report options/report data.
 * @param {object|string} reportOrId - report data or a report id
 * @param {object} reportDataOrOptions - existing report data or generateComplianceReport options
 * @returns {{ report_id: string, report_hash: string, chain_integrity: object, policy_coverage_percent: number, risk_counts: object, review_workflow: object }}
 */
function exportAttestation(reportOrId, reportDataOrOptions) {
  const reportData = resolveReportDataForAttestation(reportOrId, reportDataOrOptions);
  if (!reportData || !reportData.report_id) {
    throw new Error('Valid report data with report_id is required');
  }

  return {
    report_id: reportData.report_id,
    report_hash: hashValue(JSON.stringify(reportData)),
    chain_integrity: isPlainObject(reportData.chain_integrity)
      ? reportData.chain_integrity
      : createDefaultChainIntegrity(),
    policy_coverage_percent: getAttestationPolicyCoveragePercent(reportData),
    risk_counts: buildRiskCounts(reportData.risk_audit_trail),
    review_workflow: {
      reviewer: null,
      reviewed_at: null,
      approved: null,
    },
  };
}

function createPeekComplianceHandlers() {
  return {
    exportAttestation,
    generateComplianceReport,
    verifyAuditChain,
  };
}

module.exports = {
  exportAttestation,
  generateComplianceReport,
  verifyAuditChain,
  createPeekComplianceHandlers,
};
