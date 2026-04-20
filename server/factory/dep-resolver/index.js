'use strict';

const RESOLVER_TIMEOUT_MS = 10 * 60 * 1000;

async function resolve({ classification, project, worktree, workItem, instance, adapter, options = {} }) {
  if (!classification || classification.classification !== 'missing_dep') {
    return { outcome: 'unhandled', reverifyNeeded: false, reason: 'not_a_missing_dep_classification' };
  }
  if (!adapter || typeof adapter.buildResolverPrompt !== 'function' || typeof adapter.validateManifestUpdate !== 'function') {
    return { outcome: 'unhandled', reverifyNeeded: false, reason: 'adapter_missing_required_methods' };
  }

  const { submitFactoryInternalTask } = require('../internal-task-submit');
  const { handleAwaitTask } = require('../../handlers/workflow/await');
  const taskCore = require('../../db/task-core');

  const prompt = options.revisedPrompt && options.revisedPrompt.trim().length > 0
    ? options.revisedPrompt
    : adapter.buildResolverPrompt({
        package_name: classification.package_name,
        project,
        worktree,
        workItem,
        error_output: classification.error_output || '',
      });

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : RESOLVER_TIMEOUT_MS;

  const tags = [
    `factory:work_item_id=${workItem?.id || ''}`,
    `factory:batch_id=${instance?.batch_id || ''}`,
    `factory:dep_resolve=${classification.package_name}`,
    'factory:dep_resolve=true',
  ];

  let taskId;
  try {
    const submission = await submitFactoryInternalTask({
      task: prompt,
      working_directory: worktree?.path || project?.path || process.cwd(),
      kind: 'targeted_file_edit',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
      tags,
    });
    taskId = submission?.task_id || null;
  } catch (err) {
    return {
      outcome: 'resolver_task_failed',
      reverifyNeeded: false,
      reason: `submit_threw: ${err?.message || err}`,
      package: classification.package_name,
      manager: classification.manager,
    };
  }
  if (!taskId) {
    return {
      outcome: 'resolver_task_failed',
      reverifyNeeded: false,
      reason: 'no_task_id',
      package: classification.package_name,
      manager: classification.manager,
    };
  }

  try {
    await handleAwaitTask({ task_id: taskId, timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)), heartbeat_minutes: 0 });
  } catch (err) {
    return {
      outcome: 'resolver_task_failed',
      reverifyNeeded: false,
      reason: `await_threw: ${err?.message || err}`,
      taskId,
      package: classification.package_name,
      manager: classification.manager,
    };
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') {
    return {
      outcome: 'resolver_task_failed',
      reverifyNeeded: false,
      reason: `task_status=${task?.status || 'missing'}`,
      taskId,
      resolverError: task?.output || '',
      package: classification.package_name,
      manager: classification.manager,
    };
  }

  let validation;
  try {
    validation = await adapter.validateManifestUpdate(worktree?.path || project?.path, classification.package_name);
  } catch (err) {
    validation = { valid: false, reason: `validate_threw: ${err?.message || err}` };
  }
  if (!validation || !validation.valid) {
    return {
      outcome: 'validation_failed',
      reverifyNeeded: false,
      reason: validation?.reason || 'validation_rejected',
      taskId,
      package: classification.package_name,
      manager: classification.manager,
    };
  }

  return {
    outcome: 'resolved',
    reverifyNeeded: true,
    taskId,
    package: classification.package_name,
    manager: classification.manager,
    manifest: validation.manifest || null,
  };
}

module.exports = { resolve, RESOLVER_TIMEOUT_MS };
