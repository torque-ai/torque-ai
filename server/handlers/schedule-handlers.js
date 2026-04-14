'use strict';

const fs = require('fs');
const path = require('path');
const { createCronScheduledTask } = require('../db/cron-scheduling');
const { ErrorCodes, makeError } = require('./shared');

async function validateWorkflowSpec(specPath) {
  let parseSpec = null;
  try {
    ({ parseSpec } = require('../workflow-spec'));
  } catch {
    parseSpec = null;
  }

  if (typeof parseSpec === 'function') {
    try {
      const parsed = await parseSpec(specPath);
      if (parsed?.ok) {
        return { ok: true };
      }
      const errors = Array.isArray(parsed?.errors) && parsed.errors.length > 0
        ? parsed.errors
        : ['Unknown workflow spec parse failure'];
      return { ok: false, errors };
    } catch (error) {
      return { ok: false, errors: [error.message] };
    }
  }

  if (!fs.existsSync(specPath)) {
    return { ok: false, errors: [`Spec file not found: ${specPath}`] };
  }

  let content = '';
  try {
    content = fs.readFileSync(specPath, 'utf8');
  } catch (error) {
    return { ok: false, errors: [`Unable to read spec: ${error.message}`] };
  }

  const errors = [];
  if (!/\.(yaml|yml)$/i.test(specPath)) {
    errors.push('Spec path must end with .yaml or .yml');
  }
  if (!content.trim()) {
    errors.push('Spec file is empty');
  }
  if (!/^\s*tasks\s*:/m.test(content)) {
    errors.push('Spec must define a top-level tasks: block');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

async function handleScheduleWorkflowSpec(args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : '';
  const cron = typeof args?.cron === 'string' ? args.cron.trim() : '';
  const specPath = typeof args?.spec_path === 'string' ? args.spec_path.trim() : '';

  if (!name || !cron || !specPath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name, cron, and spec_path are required');
  }

  const workingDirectory = typeof args?.working_directory === 'string' && args.working_directory.trim()
    ? path.resolve(args.working_directory.trim())
    : null;
  const specAbs = path.isAbsolute(specPath)
    ? path.normalize(specPath)
    : path.resolve(workingDirectory || process.cwd(), specPath);

  const parsed = await validateWorkflowSpec(specAbs);
  if (!parsed.ok) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Spec ${specAbs} does not parse:\n- ${parsed.errors.join('\n- ')}`
    );
  }

  try {
    const schedule = createCronScheduledTask({
      name,
      cron_expression: cron,
      payload_kind: 'workflow_spec',
      spec_path: specAbs,
      enabled: args.enabled !== false,
      timezone: typeof args?.timezone === 'string' && args.timezone.trim()
        ? args.timezone.trim()
        : null,
      task_config: {
        task: `Run workflow spec: ${path.basename(specAbs)}`,
        working_directory: workingDirectory || undefined,
      },
    });

    return {
      content: [{ type: 'text', text: `Scheduled workflow spec '${schedule.name}' (id ${schedule.id}) to run on '${cron}'.` }],
      structuredData: {
        schedule_id: schedule.id,
        name: schedule.name,
        cron,
        spec_path: specAbs,
        payload_kind: schedule.payload_kind,
      },
    };
  } catch (error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to create workflow spec schedule: ${error.message}`);
  }
}

module.exports = { handleScheduleWorkflowSpec };
