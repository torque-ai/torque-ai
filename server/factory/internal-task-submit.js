'use strict';

const {
  buildProviderLaneTaskMetadata,
  getProviderLanePolicyFromProject,
  specializePolicyForKind,
} = require('./provider-lane-policy');
const { MAX_TASK_LENGTH } = require('../handlers/shared');

const TRUNCATED_TASK_MARKER = '[... factory internal prompt truncated: middle content omitted ...]';

const PROJECT_BY_KIND = Object.freeze({
  architect_json: 'factory-architect',
  architect_cycle: 'factory-architect',
  replan_decompose: 'factory-architect',
  replan_rewrite: 'factory-architect',
  plan_generation: 'factory-plan',
  plan_quality_review: 'factory-plan',
  // verify_review is a structured yes/no verdict task (does this diff
  // explain those test failures?). Lives in factory-plan for billing
  // grouping but exists as a distinct kind so the verify-review path can
  // use a fast/cheap reviewer for ordinary projects while still inheriting
  // target project lane routing when that lane is configured.
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

function resolveFacade() {
  try {
    const { defaultContainer } = require('../container');
    return defaultContainer.get('db');
  } catch {
    return require('../database');
  }
}

function readFactoryProject(project_id) {
  if (!project_id) return null;

  try {
    const database = resolveFacade();
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
  kind,
}) {
  const rawLanePolicy = getProviderLanePolicyFromProject(targetProject || {});
  // Phase H: when the project's lane policy carries a `by_kind` map and
  // this submission has a kind that matches, the kind's override
  // becomes the effective expected_provider. Without specialization the
  // architect/plan-quality/verify-review tasks would inherit the
  // worker-lane provider (e.g. ollama on DLPhone) and never reach the
  // stronger model the operator pinned for those manager kinds.
  const lanePolicy = kind
    ? specializePolicyForKind(rawLanePolicy, kind)
    : rawLanePolicy;
  const laneProvider = !requestedProvider && !requestedRoutingTemplate
    ? normalizeOptionalString(lanePolicy?.expected_provider)
    : null;
  const defaults = resolveTargetProjectDefaults(targetProject, workingDirectory);
  const deferProjectDefaultProvider = kind === 'plan_generation'
    && !requestedProvider
    && !requestedRoutingTemplate
    && !laneProvider;
  if (!defaults) {
    return {
      defaults: null,
      provider: laneProvider,
      routingTemplate: null,
      model: null,
      providerSource: laneProvider ? 'provider_lane_policy' : null,
      deferredDefaultProvider: false,
    };
  }

  const routingTemplate = requestedRoutingTemplate || laneProvider
    ? null
    : normalizeOptionalString(defaults.routing_template_id);
  const defaultProvider = normalizeOptionalString(defaults.default_provider);
  const provider = requestedProvider || requestedRoutingTemplate || routingTemplate || deferProjectDefaultProvider
    ? null
    : (laneProvider || defaultProvider);
  const model = provider && provider === defaultProvider
    ? normalizeOptionalString(defaults.default_model)
    : null;

  return {
    defaults,
    provider,
    routingTemplate,
    model,
    providerSource: provider
      ? (laneProvider && provider === laneProvider ? 'provider_lane_policy' : 'project_defaults')
      : null,
    deferredDefaultProvider: deferProjectDefaultProvider && Boolean(defaultProvider),
  };
}

function assertProjectAcceptsInternalTasks(project_id, targetProject = null) {
  const status = targetProject?.status || readFactoryProject(project_id)?.status || null;
  if (status === 'paused') {
    throw new Error(`Factory project is paused: ${project_id}; internal task submission blocked`);
  }
}

function boundFactoryInternalTaskDescription(task, maxLength = MAX_TASK_LENGTH) {
  if (typeof task !== 'string' || task.length <= maxLength) {
    return {
      task,
      truncated: false,
      originalLength: typeof task === 'string' ? task.length : null,
      submittedLength: typeof task === 'string' ? task.length : null,
    };
  }

  const notice = [
    '[Factory internal prompt truncated before submit]',
    `Original task description length: ${task.length} characters. Submission limit: ${maxLength}.`,
    'The middle was omitted to keep this factory self-healing task admissible; preserve the visible instructions and use repository context if more detail is needed.',
    '',
  ].join('\n');
  const marker = `\n\n${TRUNCATED_TASK_MARKER}\n\n`;
  const contentBudget = maxLength - notice.length - marker.length;

  if (contentBudget <= 0) {
    const fallback = task.slice(0, maxLength);
    return {
      task: fallback,
      truncated: true,
      originalLength: task.length,
      submittedLength: fallback.length,
    };
  }

  const headLength = Math.ceil(contentBudget * 0.62);
  const tailLength = contentBudget - headLength;
  const boundedTask = `${notice}${task.slice(0, headLength)}${marker}${task.slice(task.length - tailLength)}`;

  return {
    task: boundedTask,
    truncated: true,
    originalLength: task.length,
    submittedLength: boundedTask.length,
  };
}

async function submitFactoryInternalTask({
  task,
  working_directory,
  kind,
  project_id,
  work_item_id,
  provider,
  model,
  routing_template,
  prefer_free,
  context_stuff,
  context_depth,
  study_context,
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
    kind: resolvedKind,
  });
  const effectiveProvider = requestedProvider || inheritedIntent.provider;
  const effectiveRoutingTemplate = requestedRoutingTemplate || inheritedIntent.routingTemplate;
  // Caller-provided model wins over inherited. Used by the verify-review
  // path to pin a small/fast model (llama3.1-8b) instead of inheriting
  // the routing template's heavy model (qwen-3-235b returns null output
  // on short structured prompts).
  const requestedModel = normalizeOptionalString(model);
  const effectiveModel = requestedModel || inheritedIntent.model;
  const boundedTask = boundFactoryInternalTaskDescription(task);
  const tags = [
    'factory:internal',
    `factory:${resolvedKind}`,
    `factory:project_id=${project_id}`,
    ...(targetProject?.name ? [`factory:target_project=${targetProject.name}`] : []),
    ...(work_item_id ? [`factory:work_item_id=${work_item_id}`] : []),
    ...(boundedTask.truncated ? ['factory:task_truncated'] : []),
    ...(Array.isArray(extra_tags) ? extra_tags : []),
  ];
  const task_metadata = {
    factory_internal: true,
    kind: resolvedKind,
    project_id,
    ...(targetProject?.name ? { target_project: targetProject.name } : {}),
    ...(targetProject?.path ? { target_project_path: targetProject.path } : {}),
    ...(work_item_id ? { work_item_id } : {}),
    ...(boundedTask.truncated ? {
      task_description_truncated: true,
      task_description_original_length: boundedTask.originalLength,
      task_description_submitted_length: boundedTask.submittedLength,
      task_description_limit: MAX_TASK_LENGTH,
      task_description_truncation_strategy: 'preserve_head_and_tail',
    } : {}),
    ...(requestedProvider ? { requested_provider: requestedProvider } : {}),
    ...(requestedRoutingTemplate ? { requested_routing_template: requestedRoutingTemplate } : {}),
    ...(!requestedRoutingTemplate && inheritedIntent.routingTemplate ? {
      inherited_routing_template: inheritedIntent.routingTemplate,
      inherited_routing_template_from_project: inheritedIntent.defaults?.project || targetProject?.name || null,
    } : {}),
    ...(!requestedProvider && inheritedIntent.provider ? {
      inherited_provider: inheritedIntent.provider,
      inherited_provider_from_project: inheritedIntent.defaults?.project || targetProject?.name || null,
      inherited_provider_source: inheritedIntent.providerSource || 'project_defaults',
      user_provider_override: false,
    } : {}),
    ...(!requestedProvider && inheritedIntent.deferredDefaultProvider ? {
      deferred_provider_inheritance: true,
      deferred_provider_inheritance_from_project: inheritedIntent.defaults?.project || targetProject?.name || null,
      deferred_provider_inheritance_reason: 'plan_generation_uses_routing_template',
    } : {}),
    ...buildProviderLaneTaskMetadata(targetProject || {}, resolvedKind),
    ...(extra_metadata || {}),
  };

  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const result = await handleSmartSubmitTask({
    task: boundedTask.task,
    project,
    working_directory: resolvedWorkingDirectory,
    ...(effectiveProvider ? { provider: effectiveProvider } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(effectiveRoutingTemplate ? { routing_template: effectiveRoutingTemplate } : {}),
    ...(prefer_free !== undefined ? { prefer_free } : {}),
    ...(context_stuff !== undefined ? { context_stuff } : {}),
    ...(context_depth !== undefined ? { context_depth } : {}),
    ...(study_context !== undefined ? { study_context } : {}),
    ...(Array.isArray(files) ? { files } : {}),
    timeout_minutes: timeout_minutes ?? 10,
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
