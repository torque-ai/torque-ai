'use strict';

const { buildProviderLaneTaskMetadata } = require('./provider-lane-policy');

const PROJECT_BY_KIND = Object.freeze({
  architect_cycle: 'factory-architect',
  plan_generation: 'factory-plan',
  // verify_review is a structured yes/no verdict task (does this diff
  // explain those test failures?). Lives in factory-plan for billing
  // grouping but exists as a distinct kind so the verify-review path can
  // route to a fast/cheap provider (cerebras/groq) instead of inheriting
  // plan_generation's Codex/xhigh routing.
  verify_review: 'factory-plan',
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

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function ignoredSchemaLookupError(error) {
  const message = String(error?.message || '');
  return message.includes('no such table') || message.includes('no such column');
}

function readFactoryProject(project_id) {
  if (!project_id) return null;

  try {
    const database = require('../database');
    const db = database.getDbInstance?.();
    if (db && typeof db.prepare === 'function') {
      const row = db.prepare('SELECT id, name, path, status, config_json FROM factory_projects WHERE id = ?').get(project_id);
      if (row) {
        return row;
      }
    }
  } catch (error) {
    if (!ignoredSchemaLookupError(error)) {
      throw error;
    }
  }

  try {
    const factoryHealth = require('../db/factory-health');
    return factoryHealth.getProject(project_id) || null;
  } catch (_error) {
    return null;
  }
}

function getProjectDefaults(candidate) {
  const normalized = normalizeOptionalString(candidate);
  if (!normalized) return null;

  try {
    const projectConfigCore = require('../db/project-config-core');
    if (typeof projectConfigCore.getProjectDefaults === 'function') {
      return projectConfigCore.getProjectDefaults(normalized) || null;
    }
    if (typeof projectConfigCore.getProjectConfig === 'function') {
      return projectConfigCore.getProjectConfig(normalized) || null;
    }
  } catch (error) {
    if (!ignoredSchemaLookupError(error)) {
      throw error;
    }
  }

  return null;
}

function resolveTargetProjectDefaults(targetProject, workingDirectory) {
  if (!targetProject) {
    return null;
  }

  const candidates = [
    targetProject?.name,
    targetProject?.path,
    workingDirectory,
  ];

  for (const candidate of candidates) {
    const defaults = getProjectDefaults(candidate);
    if (defaults) {
      return {
        ...defaults,
        resolved_from: candidate,
      };
    }
  }

  return null;
}

function resolveInheritedRoutingIntent({
  targetProject,
  workingDirectory,
  requestedProvider,
  requestedRoutingTemplate,
}) {
  const defaults = resolveTargetProjectDefaults(targetProject, workingDirectory);
  if (!defaults) {
    return {
      defaults: null,
      provider: null,
      routingTemplate: null,
      model: null,
    };
  }

  const routingTemplate = requestedRoutingTemplate
    ? null
    : normalizeOptionalString(defaults.routing_template_id);
  const provider = requestedProvider || requestedRoutingTemplate || routingTemplate
    ? null
    : normalizeOptionalString(defaults.default_provider);
  const model = provider
    ? normalizeOptionalString(defaults.default_model)
    : null;

  return {
    defaults,
    provider,
    routingTemplate,
    model,
  };
}

function assertProjectAcceptsInternalTasks(project_id, targetProject = null) {
  const status = targetProject?.status || readFactoryProject(project_id)?.status || null;
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
  provider,
  routing_template,
  prefer_free,
  context_stuff,
  context_depth,
  files,
  extra_tags,
  extra_metadata,
  timeout_minutes,
}) {
  const resolvedWorkingDirectory = requireWorkingDirectory(working_directory);
  const resolvedKind = requireKnownKind(kind);
  const targetProject = readFactoryProject(project_id);
  assertProjectAcceptsInternalTasks(project_id, targetProject);
  const project = PROJECT_BY_KIND[resolvedKind];
  const requestedProvider = normalizeOptionalString(provider);
  const requestedRoutingTemplate = normalizeOptionalString(routing_template);
  const inheritedIntent = resolveInheritedRoutingIntent({
    targetProject,
    workingDirectory: resolvedWorkingDirectory,
    requestedProvider,
    requestedRoutingTemplate,
  });
  const effectiveProvider = requestedProvider || inheritedIntent.provider;
  const effectiveRoutingTemplate = requestedRoutingTemplate || inheritedIntent.routingTemplate;
  const effectiveModel = inheritedIntent.model;
  const tags = [
    'factory:internal',
    `factory:${resolvedKind}`,
    `factory:project_id=${project_id}`,
    ...(targetProject?.name ? [`factory:target_project=${targetProject.name}`] : []),
    ...(work_item_id ? [`factory:work_item_id=${work_item_id}`] : []),
    ...(Array.isArray(extra_tags) ? extra_tags : []),
  ];
  const task_metadata = {
    factory_internal: true,
    kind: resolvedKind,
    project_id,
    ...(targetProject?.name ? { target_project: targetProject.name } : {}),
    ...(targetProject?.path ? { target_project_path: targetProject.path } : {}),
    ...(work_item_id ? { work_item_id } : {}),
    ...(requestedProvider ? { requested_provider: requestedProvider } : {}),
    ...(requestedRoutingTemplate ? { requested_routing_template: requestedRoutingTemplate } : {}),
    ...(!requestedRoutingTemplate && inheritedIntent.routingTemplate ? {
      inherited_routing_template: inheritedIntent.routingTemplate,
      inherited_routing_template_from_project: inheritedIntent.defaults?.project || targetProject?.name || null,
    } : {}),
    ...(!requestedProvider && inheritedIntent.provider ? {
      inherited_provider: inheritedIntent.provider,
      inherited_provider_from_project: inheritedIntent.defaults?.project || targetProject?.name || null,
    } : {}),
    ...buildProviderLaneTaskMetadata(targetProject || {}),
    ...(extra_metadata || {}),
  };

  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const result = await handleSmartSubmitTask({
    task,
    project,
    working_directory: resolvedWorkingDirectory,
    ...(effectiveProvider ? { provider: effectiveProvider } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(effectiveRoutingTemplate ? { routing_template: effectiveRoutingTemplate } : {}),
    ...(prefer_free !== undefined ? { prefer_free } : {}),
    ...(context_stuff !== undefined ? { context_stuff } : {}),
    ...(context_depth !== undefined ? { context_depth } : {}),
    ...(Array.isArray(files) ? { files } : {}),
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
