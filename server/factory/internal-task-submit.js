'use strict';

const PROJECT_BY_KIND = Object.freeze({
  architect_cycle: 'factory-architect',
  plan_generation: 'factory-plan',
});

function requireWorkingDirectory(working_directory) {
  if (typeof working_directory !== 'string' || working_directory.trim() === '') {
    throw new Error('working_directory is required for factory-internal tasks');
  }
  return working_directory.trim();
}

function requireKnownKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(PROJECT_BY_KIND, kind)) {
    throw new Error(`Unknown factory-internal task kind: ${String(kind)}`);
  }
  return kind;
}

function readProjectStatusFromDb(project_id) {
  if (!project_id) return null;

  try {
    const database = require('../database');
    const db = database.getDbInstance?.();
    if (db && typeof db.prepare === 'function') {
      const row = db.prepare('SELECT status FROM factory_projects WHERE id = ?').get(project_id);
      if (row && typeof row.status === 'string') {
        return row.status;
      }
    }
  } catch (error) {
    if (!String(error?.message || '').includes('no such table')) {
      throw error;
    }
  }

  try {
    const factoryHealth = require('../db/factory-health');
    const project = factoryHealth.getProject(project_id);
    return project?.status || null;
  } catch (_error) {
    return null;
  }
}

function assertProjectAcceptsInternalTasks(project_id) {
  const status = readProjectStatusFromDb(project_id);
  if (status === 'paused') {
    throw new Error(`Factory project is paused: ${project_id}; internal task submission blocked`);
  }
}

async function submitFactoryInternalTask({
  task,
  working_directory,
  kind,
  project_id,
  work_item_id,
  extra_tags,
  extra_metadata,
  timeout_minutes,
}) {
  const resolvedWorkingDirectory = requireWorkingDirectory(working_directory);
  const resolvedKind = requireKnownKind(kind);
  assertProjectAcceptsInternalTasks(project_id);
  const project = PROJECT_BY_KIND[resolvedKind];
  const tags = [
    'factory:internal',
    `factory:${resolvedKind}`,
    `factory:project_id=${project_id}`,
    ...(work_item_id ? [`factory:work_item_id=${work_item_id}`] : []),
    ...(Array.isArray(extra_tags) ? extra_tags : []),
  ];
  const task_metadata = {
    factory_internal: true,
    kind: resolvedKind,
    project_id,
    ...(work_item_id ? { work_item_id } : {}),
    ...(extra_metadata || {}),
  };

  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const result = await handleSmartSubmitTask({
    task,
    project,
    working_directory: resolvedWorkingDirectory,
    timeout_minutes: timeout_minutes || 10,
    version_intent: 'internal',
    tags,
    task_metadata,
  });

  if (result?.isError || !result?.task_id) {
    const detail = result?.content?.[0]?.text || 'no task_id returned';
    const code = result?.error_code ? ` [${result.error_code}]` : '';
    throw new Error(`smart_submit_task failed${code}: ${detail}`);
  }

  return {
    task_id: result.task_id,
  };
}

module.exports = {
  submitFactoryInternalTask,
};
