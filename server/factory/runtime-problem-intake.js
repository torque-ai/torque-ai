'use strict';

const OPEN_DUPLICATE_STATUSES = [
  'pending',
  'triaged',
  'in_progress',
  'intake',
  'prioritized',
  'planned',
  'executing',
  'verifying',
  'needs_replan',
];

const PROBLEM_DEFINITIONS = Object.freeze({
  timeout_overrun_active: {
    title: (ctx) => `Investigate factory runtime timeout overruns for ${ctx.kindLabel} tasks`,
    actionCreated: 'runtime_timeout_overrun_intake_created',
    actionDuplicate: 'runtime_timeout_overrun_intake_duplicate',
    summary: 'A factory task exceeded its configured wall-clock timeout, but recent activity kept it running.',
  },
  stall_threshold_extended: {
    title: (ctx) => `Investigate factory stall-threshold extensions for ${ctx.kindLabel} tasks`,
    actionCreated: 'runtime_stall_extension_intake_created',
    actionDuplicate: 'runtime_stall_extension_intake_duplicate',
    summary: 'A factory task crossed the output-stall threshold, but the process was still alive so enforcement was deferred.',
  },
});

function parseJsonMaybe(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTags(value) {
  const parsed = parseJsonMaybe(value, value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((tag) => typeof tag === 'string');
}

function getTagValue(tags, prefix) {
  const match = tags.find((tag) => tag.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function normalizeKind(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/^factory:/, '');
}

function inferKind(task, metadata, tags) {
  const metadataKind = normalizeKind(metadata.kind);
  if (metadataKind) return metadataKind;

  const kindTag = tags.find((tag) => /^factory:[a-z_]+$/i.test(tag) && tag !== 'factory:internal');
  const tagKind = normalizeKind(kindTag);
  if (tagKind) return tagKind;

  if (tags.some((tag) => tag.startsWith('factory:batch_id='))) return 'execute';
  if (typeof task.project === 'string' && task.project.startsWith('factory-')) {
    return task.project.replace(/^factory-/, '');
  }
  return 'factory';
}

function formatKindLabel(kind) {
  return String(kind || 'factory').replace(/[_-]+/g, ' ');
}

function isFactoryRelated(task, metadata, tags) {
  if (metadata.factory_internal === true) return true;
  if (tags.some((tag) => tag === 'factory:internal' || tag.startsWith('factory:'))) return true;
  return typeof task.project === 'string' && task.project.startsWith('factory-');
}

function resolveFactoryControlProject(factoryHealth) {
  try {
    const byCurrentDirectory = factoryHealth.getProjectByPath?.(process.cwd());
    if (byCurrentDirectory?.id) return byCurrentDirectory;
  } catch {
    // Fall through to name lookup.
  }

  try {
    const projects = factoryHealth.listProjects?.() || [];
    return projects.find((project) => project?.name === 'torque-public') || null;
  } catch {
    return null;
  }
}

function resolveAffectedProject(task, metadata, tags, factoryHealth) {
  const taggedProjectId = getTagValue(tags, 'factory:project_id=');
  const projectId = metadata.project_id || taggedProjectId;
  if (projectId) {
    try {
      const project = factoryHealth.getProject?.(projectId);
      if (project?.id) return project;
    } catch {
      return { id: projectId };
    }
    return { id: projectId };
  }

  if (task.working_directory) {
    try {
      const project = factoryHealth.getProjectByPath?.(task.working_directory);
      if (project?.id) return project;
    } catch {
      // Affected project is optional context.
    }
  }

  return null;
}

function safeFindDuplicates(factoryIntake, projectId, title) {
  try {
    if (typeof factoryIntake.findRecentDuplicateWorkItems !== 'function') {
      return [];
    }
    return factoryIntake.findRecentDuplicateWorkItems(projectId, title, {
      source: 'self_generated',
      statuses: OPEN_DUPLICATE_STATUSES,
      windowMs: 6 * 60 * 60 * 1000,
      limit: 100,
    });
  } catch {
    return [];
  }
}

function recordDecision(factoryDecisions, payload, logger) {
  try {
    if (typeof factoryDecisions.recordDecision === 'function') {
      return factoryDecisions.recordDecision(payload);
    }
  } catch (error) {
    logger?.info?.(`[RuntimeProblemIntake] Failed to record factory decision: ${error.message}`);
  }
  return null;
}

function buildDescription({ definition, task, metadata, affectedProject, details, kind }) {
  const lines = [
    definition.summary,
    '',
    `Task: ${task.id || 'unknown'}`,
    `Task project: ${task.project || 'unknown'}`,
    `Factory kind: ${kind}`,
  ];

  if (affectedProject?.name || metadata.target_project) {
    lines.push(`Affected project: ${affectedProject?.name || metadata.target_project}`);
  }
  if (task.provider || task.model) {
    lines.push(`Provider/model: ${task.provider || 'unknown'} / ${task.model || 'default'}`);
  }
  if (details.timeoutMinutes != null) {
    lines.push(`Configured timeout: ${details.timeoutMinutes} minute(s)`);
  }
  if (details.elapsedMinutes != null) {
    lines.push(`Elapsed runtime: ${details.elapsedMinutes} minute(s)`);
  }
  if (details.idleMinutes != null) {
    lines.push(`Last observed activity: ${details.idleMinutes} minute(s) ago`);
  }
  if (details.lastActivitySeconds != null) {
    lines.push(`Last output activity: ${details.lastActivitySeconds} second(s) ago`);
  }
  if (details.stallThresholdSeconds != null) {
    lines.push(`Stall threshold: ${details.stallThresholdSeconds} second(s)`);
  }

  lines.push('');
  lines.push('Investigate the TORQUE factory control plane. Prefer fixes that split oversized tasks, tune task-specific budgets, improve progress detection, or add durable self-healing. Do not edit the affected product project unless the evidence clearly shows the product repo caused the runtime failure.');

  return lines.join('\n');
}

function reportRuntimeTaskProblem({
  db,
  task,
  problem,
  details = {},
  logger,
  factoryIntake = require('../db/factory-intake'),
  factoryHealth = require('../db/factory-health'),
  factoryDecisions = require('../db/factory-decisions'),
} = {}) {
  if (!task || !task.id || !PROBLEM_DEFINITIONS[problem]) {
    return { reported: false, reason: 'invalid_input' };
  }

  let fullTask = task;
  try {
    if (db && typeof db.getTask === 'function') {
      fullTask = { ...task, ...(db.getTask(task.id) || {}) };
    }
  } catch (error) {
    logger?.info?.(`[RuntimeProblemIntake] Failed to load full task ${task.id}: ${error.message}`);
  }

  const metadata = parseJsonMaybe(fullTask.metadata, {});
  const tags = normalizeTags(fullTask.tags);
  if (!isFactoryRelated(fullTask, metadata, tags)) {
    return { reported: false, reason: 'not_factory_related' };
  }

  const kind = inferKind(fullTask, metadata, tags);
  const kindLabel = formatKindLabel(kind);
  const definition = PROBLEM_DEFINITIONS[problem];
  const controlProject = resolveFactoryControlProject(factoryHealth);
  const affectedProject = resolveAffectedProject(fullTask, metadata, tags, factoryHealth);
  const project = controlProject || affectedProject;

  if (!project?.id) {
    return { reported: false, reason: 'no_factory_project' };
  }

  const title = definition.title({ kindLabel, task: fullTask });
  const duplicate = safeFindDuplicates(factoryIntake, project.id, title)[0] || null;
  const commonDecision = {
    project_id: project.id,
    stage: 'learn',
    actor: 'auto-recovery',
    reasoning: `${definition.summary} Seeded factory learning for task ${fullTask.id}.`,
    inputs: {
      problem,
      task_id: fullTask.id,
      task_project: fullTask.project || null,
      affected_project_id: affectedProject?.id || null,
      affected_project_name: affectedProject?.name || metadata.target_project || null,
      kind,
      details,
    },
    confidence: 0.85,
  };

  if (duplicate) {
    recordDecision(factoryDecisions, {
      ...commonDecision,
      action: definition.actionDuplicate,
      outcome: {
        duplicate_work_item_id: duplicate.id,
        title,
      },
    }, logger);
    return { reported: true, duplicate: true, work_item: duplicate };
  }

  let workItem = null;
  try {
    workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'self_generated',
      origin: {
        type: 'factory_runtime_problem',
        problem,
        task_id: fullTask.id,
        task_project: fullTask.project || null,
        affected_project_id: affectedProject?.id || null,
        affected_project_name: affectedProject?.name || metadata.target_project || null,
        kind,
        details,
      },
      title,
      description: buildDescription({
        definition,
        task: fullTask,
        metadata,
        affectedProject,
        details,
        kind,
      }),
      priority: 'high',
      requestor: 'runtime-self-heal',
      constraints: {
        expected_repo: 'torque-public',
        affected_task_id: fullTask.id,
        problem,
      },
      status: 'pending',
    });
  } catch (error) {
    logger?.info?.(`[RuntimeProblemIntake] Failed to create factory runtime intake for ${fullTask.id}: ${error.message}`);
    recordDecision(factoryDecisions, {
      ...commonDecision,
      action: 'runtime_problem_intake_failed',
      outcome: {
        error: error.message,
        title,
      },
      confidence: 0.6,
    }, logger);
    return { reported: false, reason: 'create_failed', error };
  }

  recordDecision(factoryDecisions, {
    ...commonDecision,
    action: definition.actionCreated,
    outcome: {
      work_item_id: workItem?.id || null,
      title,
    },
  }, logger);

  return { reported: true, duplicate: false, work_item: workItem };
}

module.exports = {
  OPEN_DUPLICATE_STATUSES,
  reportRuntimeTaskProblem,
  _private: {
    inferKind,
    isFactoryRelated,
    normalizeTags,
    parseJsonMaybe,
  },
};
