'use strict';

const { ErrorCodes, makeError } = require('./error-codes');
const logger = require('../logger').child({ component: 'audit-handlers' });

function normalizeAuditHandlerDeps({ auditStore, orchestrator } = {}) {
  return {
    auditStore: auditStore || null,
    orchestrator: orchestrator || null,
  };
}

function createAuditHandlers(initialDeps = {}) {
  const deps = normalizeAuditHandlerDeps(initialDeps);
  const state = {
    deps,
    autoInitDone: Boolean(deps.auditStore || deps.orchestrator),
  };

  function init(nextDeps = {}) {
    state.deps = normalizeAuditHandlerDeps(nextDeps);
    state.autoInitDone = true;
  }

  return {
    init,
    handleAuditCodebase: (args) => handleAuditCodebaseWithState(state, args),
    handleListAuditRuns: (args) => handleListAuditRunsWithState(state, args),
    handleGetAuditFindings: (args) => handleGetAuditFindingsWithState(state, args),
    handleUpdateAuditFinding: (args) => handleUpdateAuditFindingWithState(state, args),
    handleGetAuditRunSummary: (args) => handleGetAuditRunSummaryWithState(state, args),
  };
}

function ensureInitialized(state) {
  if (state.autoInitDone) return;
  state.autoInitDone = true;

  try {
    const auditStore = require('../db/audit-store');
    const orchestrator = require('../audit/orchestrator');
    const workflowHandlers = require('./workflow');
    const infraHandlers = require('./integration/infra');

    state.deps = normalizeAuditHandlerDeps({ auditStore, orchestrator });

    orchestrator.init({
      auditStore,
      createWorkflow: workflowHandlers.handleCreateWorkflow,
      runWorkflow: workflowHandlers.handleRunWorkflow,
      scanProject: infraHandlers.handleScanProject,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to auto-initialize audit handlers');
  }
}

async function handleAuditCodebaseWithState(state, args) {
  try {
    ensureInitialized(state);
    if (!args || typeof args.path !== 'string' || args.path.trim().length === 0) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'path is required and must be a non-empty string');
    }

    if (!state.deps.orchestrator) {
      return makeError(ErrorCodes.INTERNAL_ERROR, 'Audit orchestrator is not initialized');
    }

    const result = await state.deps.orchestrator.runAudit({
      path: args.path,
      categories: args.categories || null,
      subcategories: args.subcategories || null,
      provider: args.provider || null,
      model: args.model || null,
      source_dirs: args.source_dirs || null,
      ignore_dirs: args.ignore_dirs || null,
      ignore_patterns: args.ignore_patterns || null,
      dry_run: args.dry_run || false,
    });

    if (result.error) {
      return makeError(ErrorCodes.INVALID_PARAM, result.error);
    }

    if (result.dry_run) {
      const lines = [
        '## Audit Dry Run',
        '',
        `**Total files:** ${result.total_files}`,
        `**Review tasks:** ${result.task_count}`,
        `**Estimated duration:** ${result.estimated_duration} weighted units`,
        '',
        '### Files by tier',
        `- Small: ${result.files_by_tier.small}`,
        `- Medium: ${result.files_by_tier.medium}`,
        `- Large: ${result.files_by_tier.large}`,
        '',
        `**Categories:** ${result.categories.join(', ')}`,
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const lines = [
      '## Audit Started',
      '',
      `**Run ID:** ${result.audit_run_id}`,
      `**Workflow ID:** ${result.workflow_id}`,
      `**Total files:** ${result.total_files}`,
      `**Review tasks:** ${result.task_count}`,
      `**Categories:** ${result.categories.join(', ')}`,
      `**Status:** ${result.status}`,
      '',
      `Use \`get_audit_findings\` with audit_run_id="${result.audit_run_id}" to check results.`,
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    logger.error({ err }, 'handleAuditCodebase failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handleListAuditRunsWithState(state, args) {
  try {
    ensureInitialized(state);
    if (!state.deps.auditStore) {
      return makeError(ErrorCodes.INTERNAL_ERROR, 'Audit store is not initialized');
    }

    const filters = {};
    if (args.project_path) filters.project_path = args.project_path;
    if (args.status) filters.status = args.status;
    if (args.limit) filters.limit = args.limit;

    const runs = state.deps.auditStore.listAuditRuns(filters);
    const rows = Array.isArray(runs) ? runs : [];

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No audit runs found.' }] };
    }

    const header = '| Run ID | Status | Files | Findings | Created |';
    const sep = '|--------|--------|-------|----------|---------|';
    const lines = rows.map((run) => {
      const id = String(run.id || '').slice(0, 8);
      const status = run.status || 'unknown';
      const files = run.total_files ?? '-';
      const findings = run.total_findings ?? '-';
      const created = run.created_at ? new Date(run.created_at).toISOString().slice(0, 16) : '-';
      return `| ${id} | ${status} | ${files} | ${findings} | ${created} |`;
    });

    return { content: [{ type: 'text', text: [header, sep, ...lines].join('\n') }] };
  } catch (err) {
    logger.error({ err }, 'handleListAuditRuns failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handleGetAuditFindingsWithState(state, args) {
  try {
    ensureInitialized(state);
    if (!state.deps.auditStore) {
      return makeError(ErrorCodes.INTERNAL_ERROR, 'Audit store is not initialized');
    }

    if (!args || !args.audit_run_id) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'audit_run_id is required');
    }

    const filters = { audit_run_id: args.audit_run_id };
    if (args.category) filters.category = args.category;
    if (args.severity) filters.severity = args.severity;
    if (args.confidence) filters.confidence = args.confidence;
    if (args.verified !== undefined) filters.verified = args.verified;
    if (args.false_positive !== undefined) filters.false_positive = args.false_positive;
    if (args.file_path) filters.file_path = args.file_path;
    if (args.limit) filters.limit = args.limit;
    if (args.offset) filters.offset = args.offset;

    const result = state.deps.auditStore.getFindings(filters);
    const rows = result && Array.isArray(result.findings) ? result.findings
      : Array.isArray(result) ? result : [];

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No findings match the specified filters.' }] };
    }

    const lines = rows.map((f, i) => [
      `### ${i + 1}. ${f.title || 'Untitled'}`,
      `**Category:** ${f.category || '-'} > ${f.subcategory || '-'}`,
      `**Severity:** ${f.severity || '-'} | **Confidence:** ${f.confidence || '-'}`,
      `**File:** ${f.file_path || '-'} (lines ${f.line_start || '?'}-${f.line_end || '?'})`,
      f.description ? `\n${f.description}` : '',
      f.suggestion ? `\n**Suggestion:** ${f.suggestion}` : '',
      f.verified ? '\n*Verified*' : '',
      f.false_positive ? '\n*Marked as false positive*' : '',
      '',
    ].filter(Boolean).join('\n'));

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    logger.error({ err }, 'handleGetAuditFindings failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handleUpdateAuditFindingWithState(state, args) {
  try {
    ensureInitialized(state);
    if (!state.deps.auditStore) {
      return makeError(ErrorCodes.INTERNAL_ERROR, 'Audit store is not initialized');
    }

    if (!args || !args.finding_id) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'finding_id is required');
    }

    const updates = {};
    if (args.verified !== undefined) updates.verified = args.verified;
    if (args.false_positive !== undefined) updates.false_positive = args.false_positive;

    if (Object.keys(updates).length === 0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'At least one of verified or false_positive must be provided');
    }

    const changed = state.deps.auditStore.updateFinding(args.finding_id, updates);

    if (changed === 0) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Finding not found: ${args.finding_id}`);
    }

    const parts = [];
    if (updates.verified !== undefined) parts.push(`verified=${updates.verified}`);
    if (updates.false_positive !== undefined) parts.push(`false_positive=${updates.false_positive}`);

    return { content: [{ type: 'text', text: `Finding ${args.finding_id} updated: ${parts.join(', ')}` }] };
  } catch (err) {
    logger.error({ err }, 'handleUpdateAuditFinding failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handleGetAuditRunSummaryWithState(state, args) {
  try {
    ensureInitialized(state);
    if (!state.deps.auditStore) {
      return makeError(ErrorCodes.INTERNAL_ERROR, 'Audit store is not initialized');
    }

    if (!args || !args.audit_run_id) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'audit_run_id is required');
    }

    const summary = state.deps.auditStore.getAuditSummary(args.audit_run_id);

    if (!summary) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Audit run not found: ${args.audit_run_id}`);
    }

    const lines = [
      '## Audit Summary',
      '',
      `**Run ID:** ${summary.run_id || args.audit_run_id}`,
      `**Status:** ${summary.status || 'unknown'}`,
      `**Total files:** ${summary.total_files ?? '-'}`,
      `**Total findings:** ${summary.total_findings ?? 0}`,
      `**Parse failures:** ${summary.parse_failures ?? 0}`,
    ];

    if (summary.by_severity) {
      lines.push('', '### By Severity');
      for (const [sev, count] of Object.entries(summary.by_severity)) {
        lines.push(`- ${sev}: ${count}`);
      }
    }

    if (summary.by_category) {
      lines.push('', '### By Category');
      for (const [cat, count] of Object.entries(summary.by_category)) {
        lines.push(`- ${cat}: ${count}`);
      }
    }

    if (summary.verified_count !== undefined) {
      lines.push('', `**Verified:** ${summary.verified_count}`);
    }
    if (summary.false_positive_count !== undefined) {
      lines.push(`**False positives:** ${summary.false_positive_count}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    logger.error({ err }, 'handleGetAuditRunSummary failed');
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

const defaultAuditHandlers = createAuditHandlers();

const init = (deps) => defaultAuditHandlers.init(deps);
const handleAuditCodebase = (args) => defaultAuditHandlers.handleAuditCodebase(args);
const handleListAuditRuns = (args) => defaultAuditHandlers.handleListAuditRuns(args);
const handleGetAuditFindings = (args) => defaultAuditHandlers.handleGetAuditFindings(args);
const handleUpdateAuditFinding = (args) => defaultAuditHandlers.handleUpdateAuditFinding(args);
const handleGetAuditRunSummary = (args) => defaultAuditHandlers.handleGetAuditRunSummary(args);

module.exports = {
  createAuditHandlers,
  init,
  handleAuditCodebase,
  handleListAuditRuns,
  handleGetAuditFindings,
  handleUpdateAuditFinding,
  handleGetAuditRunSummary,
};
