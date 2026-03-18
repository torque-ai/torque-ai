'use strict';

const logger = require('../logger').child({ component: 'v2-audit-handlers' });
const {
  sendSuccess,
  sendError,
  resolveRequestId,
} = require('./v2-control-plane');
const { parseBody } = require('./middleware');

let _auditStore = null;
let _orchestrator = null;

function init({ auditStore, orchestrator }) {
  _auditStore = auditStore || null;
  _orchestrator = orchestrator || null;
}

async function handleStartAudit(req, res) {
  const requestId = resolveRequestId(req);

  if (!_orchestrator) {
    return sendError(res, requestId, 'internal_error', 'Audit orchestrator not initialized', 500, {}, req);
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return sendError(res, requestId, 'invalid_body', err.message, 400, {}, req);
  }

  if (!body || typeof body.path !== 'string' || body.path.trim().length === 0) {
    return sendError(res, requestId, 'validation_error', 'path is required', 400, {}, req);
  }

  try {
    const result = await _orchestrator.runAudit({
      path: body.path,
      categories: body.categories || null,
      subcategories: body.subcategories || null,
      provider: body.provider || null,
      model: body.model || null,
      source_dirs: body.source_dirs || null,
      ignore_dirs: body.ignore_dirs || null,
      ignore_patterns: body.ignore_patterns || null,
      dry_run: body.dry_run ?? false,
    });

    if (result.error) {
      return sendError(res, requestId, 'audit_error', result.error, 400, {}, req);
    }

    sendSuccess(res, requestId, result, 201, req);
  } catch (err) {
    logger.error({ err }, 'handleStartAudit failed');
    sendError(res, requestId, 'internal_error', err.message, 500, {}, req);
  }
}

async function handleListRuns(req, res) {
  const requestId = resolveRequestId(req);

  if (!_auditStore) {
    return sendError(res, requestId, 'internal_error', 'Audit store not initialized', 500, {}, req);
  }

  try {
    const filters = {};
    if (req.query?.project_path) filters.project_path = req.query.project_path;
    if (req.query?.status) filters.status = req.query.status;
    if (req.query?.limit) filters.limit = Number(req.query.limit);

    const runs = _auditStore.listAuditRuns(filters);
    sendSuccess(res, requestId, { runs: Array.isArray(runs) ? runs : [] }, 200, req);
  } catch (err) {
    logger.error({ err }, 'handleListRuns failed');
    sendError(res, requestId, 'internal_error', err.message, 500, {}, req);
  }
}

async function handleGetRunFindings(req, res) {
  const requestId = resolveRequestId(req);

  if (!_auditStore) {
    return sendError(res, requestId, 'internal_error', 'Audit store not initialized', 500, {}, req);
  }

  const auditRunId = req.params?.id;
  if (!auditRunId) {
    return sendError(res, requestId, 'validation_error', 'Run ID is required', 400, {}, req);
  }

  try {
    const filters = { audit_run_id: auditRunId };
    if (req.query?.category) filters.category = req.query.category;
    if (req.query?.severity) filters.severity = req.query.severity;
    if (req.query?.confidence) filters.confidence = req.query.confidence;
    if (req.query?.file_path) filters.file_path = req.query.file_path;
    if (req.query?.limit) filters.limit = Number(req.query.limit);
    if (req.query?.offset) filters.offset = Number(req.query.offset);

    const findings = _auditStore.getFindings(filters);
    sendSuccess(res, requestId, { findings: Array.isArray(findings) ? findings : [] }, 200, req);
  } catch (err) {
    logger.error({ err }, 'handleGetRunFindings failed');
    sendError(res, requestId, 'internal_error', err.message, 500, {}, req);
  }
}

async function handleGetAllFindings(req, res) {
  const requestId = resolveRequestId(req);

  if (!_auditStore) {
    return sendError(res, requestId, 'internal_error', 'Audit store not initialized', 500, {}, req);
  }

  try {
    const filters = {};
    if (req.query?.audit_run_id) filters.audit_run_id = req.query.audit_run_id;
    if (req.query?.category) filters.category = req.query.category;
    if (req.query?.severity) filters.severity = req.query.severity;
    if (req.query?.confidence) filters.confidence = req.query.confidence;
    if (req.query?.file_path) filters.file_path = req.query.file_path;
    if (req.query?.verified) filters.verified = req.query.verified === 'true';
    if (req.query?.false_positive) filters.false_positive = req.query.false_positive === 'true';
    if (req.query?.limit) filters.limit = Number(req.query.limit);
    if (req.query?.offset) filters.offset = Number(req.query.offset);

    const findings = _auditStore.getFindings(filters);
    sendSuccess(res, requestId, { findings: Array.isArray(findings) ? findings : [] }, 200, req);
  } catch (err) {
    logger.error({ err }, 'handleGetAllFindings failed');
    sendError(res, requestId, 'internal_error', err.message, 500, {}, req);
  }
}

async function handlePatchFinding(req, res) {
  const requestId = resolveRequestId(req);

  if (!_auditStore) {
    return sendError(res, requestId, 'internal_error', 'Audit store not initialized', 500, {}, req);
  }

  const findingId = req.params?.id;
  if (!findingId) {
    return sendError(res, requestId, 'validation_error', 'Finding ID is required', 400, {}, req);
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return sendError(res, requestId, 'invalid_body', err.message, 400, {}, req);
  }

  const updates = {};
  if (body.verified !== undefined) updates.verified = body.verified;
  if (body.false_positive !== undefined) updates.false_positive = body.false_positive;

  if (Object.keys(updates).length === 0) {
    return sendError(res, requestId, 'validation_error', 'At least one of verified or false_positive is required', 400, {}, req);
  }

  try {
    const changed = _auditStore.updateFinding(findingId, updates);
    if (changed === 0) {
      return sendError(res, requestId, 'not_found', `Finding not found: ${findingId}`, 404, {}, req);
    }
    sendSuccess(res, requestId, { finding_id: findingId, ...updates }, 200, req);
  } catch (err) {
    logger.error({ err }, 'handlePatchFinding failed');
    sendError(res, requestId, 'internal_error', err.message, 500, {}, req);
  }
}

async function handleGetRunSummary(req, res) {
  const requestId = resolveRequestId(req);

  if (!_auditStore) {
    return sendError(res, requestId, 'internal_error', 'Audit store not initialized', 500, {}, req);
  }

  const auditRunId = req.params?.id;
  if (!auditRunId) {
    return sendError(res, requestId, 'validation_error', 'Run ID is required', 400, {}, req);
  }

  try {
    const summary = _auditStore.getAuditSummary(auditRunId);
    if (!summary) {
      return sendError(res, requestId, 'not_found', `Audit run not found: ${auditRunId}`, 404, {}, req);
    }
    sendSuccess(res, requestId, summary, 200, req);
  } catch (err) {
    logger.error({ err }, 'handleGetRunSummary failed');
    sendError(res, requestId, 'internal_error', err.message, 500, {}, req);
  }
}

module.exports = {
  init,
  handleStartAudit,
  handleListRuns,
  handleGetRunFindings,
  handleGetAllFindings,
  handlePatchFinding,
  handleGetRunSummary,
};
