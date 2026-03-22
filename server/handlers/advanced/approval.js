/**
 * Advanced handlers — Approval Gates & Audit
 *
 * 7 handlers for approval rules, audit log, and audit configuration.
 * Extracted from advanced-handlers.js during Phase 7 handler decomposition.
 */

const { saveApprovalRule, getApprovalRules, decideApproval, getPendingApprovals } = require('../../db/validation-rules');
const { getAuditLog, getAuditLogCount, getAuditStats, setAuditConfig, getAllAuditConfig } = require('../../db/scheduling-automation');
const { ErrorCodes, makeError } = require('../shared');


/**
 * Add an approval rule
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleAddApprovalRule(args) {
  const { name, description, rule_type, condition, auto_reject = false } = args;

  // Validate rule_type first (for specific error message)
  const validRuleTypes = ['auto_approve', 'directory', 'keyword', 'priority', 'all', 'size_change', 'file_count', 'validation_failure'];
  if (rule_type && !validRuleTypes.includes(rule_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, `rule_type must be one of: ${validRuleTypes.join(', ')}`);
  }

  if (!name || !description || !rule_type) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name, description, and rule_type are required');
  }

  const id = `apr-${Date.now()}`;
  saveApprovalRule({
    id,
    name,
    description,
    rule_type,
    condition: condition || null,
    auto_reject
  });

  return {
    content: [{
      type: 'text',
      text: `## Approval Rule Added\n\n- **ID:** ${id}\n- **Name:** ${name}\n- **Type:** ${rule_type}\n- **Auto-Reject:** ${auto_reject ? 'Yes' : 'No'}`
    }]
  };
}


/**
 * List approval rules
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListApprovalRules(args) {
  const { enabled_only = true } = args;
  const rules = getApprovalRules(enabled_only);

  if (rules.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Approval Rules\n\nNo approval rules found.`
      }]
    };
  }

  let output = `## Approval Rules\n\n`;
  output += `| Name | Type | Auto-Reject | Enabled |\n`;
  output += `|------|------|-------------|----------|\n`;

  rules.forEach(rule => {
    output += `| ${rule.name} | ${rule.rule_type} | ${rule.auto_reject ? '✓' : '-'} | ${rule.enabled ? '✓' : '✗'} |\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Approve a task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleApproveTask(args) {
  const { approval_id, notes } = args;

  if (!approval_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'approval_id is required');
  }

  const result = decideApproval(approval_id, true, 'user', notes || null);
  if (result && result.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Approval failed: ${result.error}`);
  }

  return {
    content: [{
      type: 'text',
      text: `## Approved ✓\n\nApproval ${approval_id} has been approved.${notes ? `\n\nNotes: ${notes}` : ''}`
    }]
  };
}


/**
 * List pending approvals
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListPendingApprovals(args) {
  const { task_id } = args;
  const approvals = getPendingApprovals(task_id);

  if (approvals.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Pending Approvals\n\nNo pending approvals${task_id ? ` for task ${task_id}` : ''}.`
      }]
    };
  }

  let output = `## Pending Approvals\n\n`;
  approvals.forEach(a => {
    output += `### ${a.id}\n`;
    output += `- **Task:** ${a.task_id}\n`;
    output += `- **Rule:** ${a.rule_name}\n`;
    output += `- **Reason:** ${a.reason}\n`;
    output += `- **Created:** ${a.created_at}\n\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Query audit log
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleGetAuditLog(args) {
  const {
    entity_type,
    entity_id,
    action,
    actor,
    start_date,
    end_date,
    limit = 100,
    offset = 0
  } = args;

  const logs = getAuditLog({
    entityType: entity_type,
    entityId: entity_id,
    action,
    actor,
    since: start_date,
    until: end_date,
    limit,
    offset
  });

  const total = getAuditLogCount({
    entityType: entity_type,
    entityId: entity_id,
    action,
    actor,
    since: start_date,
    until: end_date
  });

  if (logs.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Audit Log\n\nNo audit entries found matching the criteria.`
      }]
    };
  }

  let output = `## Audit Log\n\n`;
  output += `| Timestamp | Entity | Action | Actor | Details |\n`;
  output += `|-----------|--------|--------|-------|--------|\n`;

  for (const log of logs) {
    const time = new Date(log.timestamp).toLocaleString();
    const entity = `${log.entity_type || '?'}:${(log.entity_id || '').substring(0, 8)}`;
    const details = log.new_value ? String(log.new_value).substring(0, 30) + '...' : '-';
    output += `| ${time} | ${entity} | ${log.action} | ${log.actor} | ${details} |\n`;
  }

  output += `\n**Showing:** ${logs.length} of ${total} entries`;
  if (offset > 0) {
    output += ` (offset: ${offset})`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Export audit report
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleExportAuditReport(args) {
  const { format = 'json', start_date, end_date, entity_type } = args;

  // Get raw rows instead of formatted export — the handler does its own rendering
  const data = getAuditLog({ since: start_date, until: end_date, entityType: entity_type, limit: 10000 });

  if (!data || data.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No audit entries found for the specified criteria.`
      }]
    };
  }

  // Get stats (DB expects {since, until} keys)
  const stats = getAuditStats({ since: start_date, until: end_date });

  let output = '';

  if (format === 'csv') {
    // CSV format
    output = `## Audit Report (CSV)\n\n`;
    output += `**Period:** ${start_date || 'all time'} to ${end_date || 'now'}\n`;
    output += `**Total Entries:** ${data.length}\n\n`;
    output += '```csv\n';
    output += 'id,timestamp,entity_type,entity_id,action,actor,old_value,new_value\n';

    for (const row of data) {
      const oldVal = row.old_value ? `"${row.old_value.replace(/"/g, '""')}"` : '';
      const newVal = row.new_value ? `"${row.new_value.replace(/"/g, '""')}"` : '';
      output += `${row.id},${row.timestamp},${row.entity_type},${row.entity_id},${row.action},${row.actor},${oldVal},${newVal}\n`;
    }

    output += '```\n';
  } else {
    // JSON format
    output = `## Audit Report (JSON)\n\n`;
    output += `**Period:** ${start_date || 'all time'} to ${end_date || 'now'}\n`;
    output += `**Total Entries:** ${data.length}\n\n`;

    output += `### Statistics\n\n`;
    output += `| Metric | Value |\n`;
    output += `|--------|-------|\n`;
    output += `| Total Actions | ${stats.total || 0} |\n`;
    output += `| Unique Entities | ${(stats.byEntity || []).length} |\n`;
    output += `| Unique Actors | ${(stats.byActor || []).length} |\n\n`;

    if (stats.byAction && stats.byAction.length > 0) {
      output += `### Actions Breakdown\n\n`;
      for (const a of stats.byAction) {
        output += `- **${a.action}:** ${a.count}\n`;
      }
      output += '\n';
    }

    output += `### Data\n\n`;
    output += '```json\n';
    output += JSON.stringify(data.slice(0, 50), null, 2);
    if (data.length > 50) {
      output += `\n// ... ${data.length - 50} more entries`;
    }
    output += '\n```\n';
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Configure audit settings
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleConfigureAudit(args) {
  const {
    retention_days,
    track_reads,
    track_config_changes,
    track_task_operations
  } = args;

  const updates = [];

  if (retention_days !== undefined) {
    setAuditConfig('retention_days', retention_days.toString());
    updates.push(`retention_days = ${retention_days}`);
  }

  if (track_reads !== undefined) {
    setAuditConfig('track_reads', track_reads.toString());
    updates.push(`track_reads = ${track_reads}`);
  }

  if (track_config_changes !== undefined) {
    setAuditConfig('track_config_changes', track_config_changes.toString());
    updates.push(`track_config_changes = ${track_config_changes}`);
  }

  if (track_task_operations !== undefined) {
    setAuditConfig('track_task_operations', track_task_operations.toString());
    updates.push(`track_task_operations = ${track_task_operations}`);
  }

  // Get current config
  const config = getAllAuditConfig();

  let output = `## Audit Configuration\n\n`;

  if (updates.length > 0) {
    output += `**Updated:**\n`;
    for (const u of updates) {
      output += `- ${u}\n`;
    }
    output += '\n';
  }

  output += `### Current Settings\n\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;

  for (const [key, value] of Object.entries(config)) {
    output += `| ${key} | ${value} |\n`;
  }

  // Show audit stats
  const stats = getAuditStats({});
  output += `\n### Audit Statistics\n\n`;
  output += `- **Total logged actions:** ${stats.total || 0}\n`;
  output += `- **Unique entities tracked:** ${(stats.byEntity || []).length}\n`;
  output += `- **Unique actors:** ${(stats.byActor || []).length}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


function createApprovalHandlers() {
  return {
    handleAddApprovalRule,
    handleListApprovalRules,
    handleApproveTask,
    handleListPendingApprovals,
    handleGetAuditLog,
    handleExportAuditReport,
    handleConfigureAudit,
  };
}

module.exports = {
  handleAddApprovalRule,
  handleListApprovalRules,
  handleApproveTask,
  handleListPendingApprovals,
  handleGetAuditLog,
  handleExportAuditReport,
  handleConfigureAudit,
  createApprovalHandlers,
};
