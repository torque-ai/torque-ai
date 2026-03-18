/**
 * Advanced handlers — Scheduling & Resource Management
 *
 * 6 handlers for cron schedules and resource usage/limits/reporting.
 * Extracted from advanced-handlers.js during Phase 7 handler decomposition.
 */

const db = require('../../database');
const { ErrorCodes, makeError } = require('../shared');


/**
 * Create a cron-scheduled task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleCreateCronSchedule(args) {
  const {
    name,
    cron_expression,
    task,
    working_directory,
    auto_approve = false,
    timeout_minutes = 30,
    enabled = true,
    timezone
  } = args;

  try {
    const schedule = db.createCronScheduledTask({
      name,
      cron_expression,
      task_config: {
        task,
        working_directory,
        auto_approve,
        timeout_minutes
      },
      enabled,
      timezone: timezone || null
    });

    let output = `## Scheduled Task Created\n\n`;
    output += `**Name:** ${schedule.name}\n`;
    output += `**ID:** ${schedule.id}\n`;
    output += `**Cron:** \`${cron_expression}\`\n`;
    if (schedule.timezone) {
      output += `**Timezone:** ${schedule.timezone}\n`;
    }
    output += `**Status:** ${schedule.enabled ? 'Enabled' : 'Disabled'}\n`;
    output += `**Next Run:** ${schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : 'Not scheduled'}\n\n`;
    output += `**Task:** ${task}\n`;

    if (working_directory) {
      output += `**Working Directory:** ${working_directory}\n`;
    }

    return {
      content: [{ type: 'text', text: output }]
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to create scheduled task: ${err.message}`);
  }
}


/**
 * List scheduled tasks
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListSchedules(args) {
  const { enabled_only = false, limit = 50 } = args;

  const schedules = db.listScheduledTasks({ enabled_only, limit });

  if (schedules.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Scheduled Tasks\n\nNo scheduled tasks found${enabled_only ? ' (enabled only)' : ''}.`
      }]
    };
  }

  let output = `## Scheduled Tasks\n\n`;
  output += `| ID | Name | Cron | Status | Next Run | Run Count |\n`;
  output += `|----|------|------|--------|----------|----------|\n`;

  for (const s of schedules) {
    const status = s.enabled ? '✅ Enabled' : '❌ Disabled';
    const nextRun = s.next_run_at ? new Date(s.next_run_at).toLocaleString() : '-';
    output += `| ${s.id} | ${s.name} | \`${s.cron_expression}\` | ${status} | ${nextRun} | ${s.run_count} |\n`;
  }

  output += `\n**Total:** ${schedules.length} schedule(s)`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Toggle schedule enabled state
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleToggleSchedule(args) {
  const { schedule_id, enabled } = args;

  const schedule = db.toggleScheduledTask(schedule_id, enabled);

  if (!schedule) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Schedule not found: ${schedule_id}`);
  }

  const statusEmoji = schedule.enabled ? '✅' : '❌';
  const statusText = schedule.enabled ? 'enabled' : 'disabled';

  let output = `## Schedule ${statusText.charAt(0).toUpperCase() + statusText.slice(1)}\n\n`;
  output += `${statusEmoji} **${schedule.name}** is now ${statusText}.\n\n`;

  if (schedule.enabled && schedule.next_run_at) {
    output += `**Next Run:** ${new Date(schedule.next_run_at).toLocaleString()}`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get resource usage
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleGetResourceUsage(args) {
  const { task_id, project, start_time, end_time, limit = 100 } = args;

  if (project) {
    // Get project-level aggregated usage
    const usage = db.getResourceUsageByProject(project, { start_time, end_time });

    if (!usage || !usage.sample_count) {
      return {
        content: [{
          type: 'text',
          text: `## Resource Usage: ${project}\n\nNo resource usage data found for this project.`
        }]
      };
    }

    let output = `## Resource Usage: ${project}\n\n`;
    output += `| Metric | Value |\n`;
    output += `|--------|-------|\n`;
    output += `| Tasks | ${usage.task_count} |\n`;
    output += `| Samples | ${usage.sample_count} |\n`;
    output += `| Avg CPU | ${usage.avg_cpu != null ? usage.avg_cpu.toFixed(2) + '%' : 'N/A'} |\n`;
    output += `| Max CPU | ${usage.max_cpu != null ? usage.max_cpu.toFixed(2) + '%' : 'N/A'} |\n`;
    output += `| Avg Memory | ${usage.avg_memory != null ? usage.avg_memory.toFixed(2) + ' MB' : 'N/A'} |\n`;
    output += `| Max Memory | ${usage.max_memory != null ? usage.max_memory.toFixed(2) + ' MB' : 'N/A'} |\n`;
    output += `| Total Disk I/O | ${usage.total_disk_io != null ? usage.total_disk_io.toFixed(2) + ' MB' : 'N/A'} |\n`;

    return {
      content: [{ type: 'text', text: output }]
    };
  }

  if (task_id) {
    // Get task-level usage
    const usage = db.getResourceUsage(task_id, { limit, start_time, end_time });

    if (usage.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `## Resource Usage: Task ${task_id.substring(0, 8)}...\n\nNo resource usage data found for this task.`
        }]
      };
    }

    let output = `## Resource Usage: Task ${task_id.substring(0, 8)}...\n\n`;
    output += `| Timestamp | CPU % | Memory MB | Disk I/O MB |\n`;
    output += `|-----------|-------|-----------|-------------|\n`;

    for (const u of usage.slice(0, 20)) {
      const time = new Date(u.timestamp).toLocaleString();
      output += `| ${time} | ${u.cpu_percent || '-'} | ${u.memory_mb || '-'} | ${u.disk_io_mb || '-'} |\n`;
    }

    if (usage.length > 20) {
      output += `\n*Showing 20 of ${usage.length} samples*`;
    }

    return {
      content: [{ type: 'text', text: output }]
    };
  }

  return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Please specify either task_id or project to get resource usage.');
}


/**
 * Set resource limits
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleSetResourceLimits(args) {
  const { project, max_cpu_percent, max_memory_mb, max_concurrent } = args;

  const limits = db.setResourceLimits(project, {
    max_cpu_percent,
    max_memory_mb,
    max_concurrent
  });

  let output = `## Resource Limits: ${project}\n\n`;
  output += `| Limit | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Max CPU | ${limits.max_cpu_percent ? limits.max_cpu_percent + '%' : 'Unlimited'} |\n`;
  output += `| Max Memory | ${limits.max_memory_mb ? limits.max_memory_mb + ' MB' : 'Unlimited'} |\n`;
  output += `| Max Concurrent | ${limits.max_concurrent || 'Unlimited'} |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Generate resource report
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleResourceReport(args) {
  const { project, start_time, end_time, group_by = 'day' } = args;

  const report = db.getResourceReport({ project, start_time, end_time, group_by });

  if (report.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Resource Report\n\nNo resource usage data found for the specified criteria.`
      }]
    };
  }

  let output = `## Resource Report\n\n`;

  if (project) {
    output += `**Project:** ${project}\n`;
  }
  if (start_time || end_time) {
    output += `**Period:** ${start_time || 'beginning'} to ${end_time || 'now'}\n`;
  }
  output += `**Grouped by:** ${group_by}\n\n`;

  output += `| Period | Tasks | Samples | Avg CPU | Max CPU | Avg Memory | Max Memory |\n`;
  output += `|--------|-------|---------|---------|---------|------------|------------|\n`;

  for (const r of report) {
    output += `| ${r.period} | ${r.task_count} | ${r.sample_count} | ${r.avg_cpu || '-'}% | ${r.max_cpu || '-'}% | ${r.avg_memory || '-'} MB | ${r.max_memory || '-'} MB |\n`;
  }

  output += `\n**Total Periods:** ${report.length}`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


module.exports = {
  handleCreateCronSchedule,
  handleListSchedules,
  handleToggleSchedule,
  handleGetResourceUsage,
  handleSetResourceLimits,
  handleResourceReport,
};
