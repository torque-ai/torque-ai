'use strict';

const path = require('path');

const taskCore = require('../db/task-core');
const schedulingAutomation = require('../db/scheduling-automation');
const baseLogger = require('../logger').child({ component: 'codebase-study-handlers' });
const { ErrorCodes, makeError } = require('./shared');
const { createCodebaseStudy } = require('../integrations/codebase-study');

const DEFAULT_CRON = '*/15 * * * *';

function buildStudyService() {
  let db;
  try {
    const { defaultContainer } = require('../container');
    db = defaultContainer.get('db');
  } catch {
    db = require('../database');
  }

  return createCodebaseStudy({
    db,
    taskCore,
    logger: baseLogger,
  });
}

function resolveWorkingDirectoryArg(args) {
  const workingDirectory = typeof args?.working_directory === 'string' ? args.working_directory.trim() : '';
  if (!workingDirectory) {
    return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required') };
  }
  return { workingDirectory: path.resolve(workingDirectory) };
}

function formatStudyStatus(title, payload) {
  let text = `## ${title}\n\n`;
  text += `**Working Directory:** ${payload.working_directory}\n`;
  if (payload.reason) {
    text += `**Reason:** ${payload.reason}\n`;
  }
  if (payload.task_id) {
    text += `**Task ID:** ${payload.task_id}\n`;
  }
  if (payload.task_status) {
    text += `**Task Status:** ${payload.task_status}\n`;
  }
  text += `**Run Count:** ${payload.run_count ?? 0}\n`;
  text += `**Tracked Files:** ${payload.tracked_count ?? 0}\n`;
  text += `**Pending Files:** ${payload.pending_count ?? 0}\n`;
  text += `**Up To Date Files:** ${payload.up_to_date_count ?? 0}\n`;
  if (payload.last_sha) {
    text += `**Last SHA:** ${payload.last_sha}\n`;
  }
  if (payload.current_sha) {
    text += `**Current SHA:** ${payload.current_sha}\n`;
  }
  if (payload.last_run_at) {
    text += `**Last Run:** ${payload.last_run_at}\n`;
  }
  if (payload.last_completed_at) {
    text += `**Last Completed:** ${payload.last_completed_at}\n`;
  }
  if (payload.last_result) {
    text += `**Last Result:** ${payload.last_result}\n`;
  }
  if (payload.last_error) {
    text += `\n### Last Error\n${payload.last_error}\n`;
  }
  if (Array.isArray(payload.batch_files) && payload.batch_files.length > 0) {
    text += `\n### Batch Files\n`;
    payload.batch_files.forEach(file => {
      text += `- ${file}\n`;
    });
  }
  if (Array.isArray(payload.pending_files) && payload.pending_files.length > 0) {
    text += `\n### Pending Files\n`;
    payload.pending_files.slice(0, 10).forEach(file => {
      text += `- ${file}\n`;
    });
    if (payload.pending_files.length > 10) {
      text += `- ... and ${payload.pending_files.length - 10} more\n`;
    }
  }
  return text.trim();
}

async function handleRunCodebaseStudy(args) {
  const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
  if (error) {
    return error;
  }

  try {
    const result = await buildStudyService().runStudyCycle(workingDirectory);
    return {
      content: [{ type: 'text', text: formatStudyStatus(result.skipped ? 'Codebase Study Skipped' : 'Codebase Study Run', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleGetStudyStatus(args) {
  const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
  if (error) {
    return error;
  }

  try {
    const result = await buildStudyService().getStudyStatus(workingDirectory);
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Status', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleResetCodebaseStudy(args) {
  const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
  if (error) {
    return error;
  }

  try {
    const result = await buildStudyService().resetStudy(workingDirectory);
    return {
      content: [{ type: 'text', text: formatStudyStatus('Codebase Study Reset', result) }],
      structuredData: result,
    };
  } catch (studyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, studyError.message || String(studyError));
  }
}

async function handleConfigureStudySchedule(args) {
  const { workingDirectory, error } = resolveWorkingDirectoryArg(args);
  if (error) {
    return error;
  }

  const cronExpression = typeof args?.cron_expression === 'string' && args.cron_expression.trim()
    ? args.cron_expression.trim()
    : DEFAULT_CRON;
  const scheduleName = typeof args?.name === 'string' && args.name.trim()
    ? args.name.trim()
    : `codebase-study:${path.basename(workingDirectory)}`;
  const enabled = args?.enabled !== false;
  const timezone = typeof args?.timezone === 'string' && args.timezone.trim()
    ? args.timezone.trim()
    : null;

  try {
    const existing = schedulingAutomation
      .listScheduledTasks({ enabled_only: false, limit: 1000 })
      .find(schedule => schedule && schedule.name === scheduleName);

    const taskConfig = {
      task: `Run the codebase study loop for ${workingDirectory}`,
      working_directory: workingDirectory,
      project: args?.project || path.basename(workingDirectory),
      version_intent: 'internal',
      timeout_minutes: 30,
      auto_approve: true,
      tags: ['codebase-study', 'auto-generated'],
      tool_name: 'run_codebase_study',
      tool_args: {
        working_directory: workingDirectory,
      },
    };

    const schedule = existing
      ? schedulingAutomation.updateScheduledTask(existing.id, {
          cron_expression: cronExpression,
          timezone,
          enabled,
          task_description: taskConfig.task,
          task_config: taskConfig,
        })
      : schedulingAutomation.createCronScheduledTask({
          name: scheduleName,
          cron_expression: cronExpression,
          enabled,
          timezone,
          task_config: taskConfig,
        });

    let text = '## Codebase Study Schedule\n\n';
    text += `**Name:** ${schedule.name}\n`;
    text += `**ID:** ${schedule.id}\n`;
    text += `**Cron:** \`${schedule.cron_expression}\`\n`;
    text += `**Working Directory:** ${workingDirectory}\n`;
    text += `**Enabled:** ${schedule.enabled ? 'Yes' : 'No'}\n`;
    if (schedule.timezone) {
      text += `**Timezone:** ${schedule.timezone}\n`;
    }
    if (schedule.next_run_at) {
      text += `**Next Run:** ${schedule.next_run_at}\n`;
    }
    text += `**Tool:** run_codebase_study\n`;

    return {
      content: [{ type: 'text', text }],
      structuredData: {
        schedule_id: schedule.id,
        name: schedule.name,
        cron_expression: schedule.cron_expression,
        working_directory: workingDirectory,
        enabled: schedule.enabled,
        timezone: schedule.timezone || null,
        next_run_at: schedule.next_run_at || null,
      },
    };
  } catch (scheduleError) {
    return makeError(ErrorCodes.OPERATION_FAILED, scheduleError.message || String(scheduleError));
  }
}

module.exports = {
  handleRunCodebaseStudy,
  handleGetStudyStatus,
  handleResetCodebaseStudy,
  handleConfigureStudySchedule,
};
