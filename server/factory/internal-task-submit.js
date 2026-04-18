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

  return {
    task_id: result?.task_id || null,
  };
}

module.exports = {
  submitFactoryInternalTask,
};
