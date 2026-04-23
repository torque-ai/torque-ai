'use strict';

const { StreamSignalParser } = require('../diffusion/stream-signal-parser');

const STARVATION_RECOVERY_REASON = 'factory_starvation_recovery';
const MAX_TITLE_LENGTH = 140;

function normalizeMetadata(metadata) {
  if (!metadata) {
    return {};
  }
  if (typeof metadata === 'object') {
    return metadata;
  }
  if (typeof metadata !== 'string') {
    return {};
  }
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

function isStarvationRecoveryScoutTask(task) {
  const metadata = normalizeMetadata(task?.metadata);
  const scope = typeof metadata.scope === 'string' ? metadata.scope : '';
  return metadata.mode === 'scout'
    && (
      metadata.reason === STARVATION_RECOVERY_REASON
      || /\bFactory starvation recovery scout\b/i.test(scope)
      || /\bproject reached STARVED\b/i.test(scope)
    );
}

function truncateTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_TITLE_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_TITLE_LENGTH - 3).trim()}...`;
}

function normalizePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') {
    return null;
  }
  const id = typeof pattern.id === 'string' && pattern.id.trim()
    ? pattern.id.trim()
    : null;
  const description = typeof pattern.description === 'string' && pattern.description.trim()
    ? pattern.description.trim()
    : null;
  if (!id && !description) {
    return null;
  }
  return {
    id,
    description,
    transformation: typeof pattern.transformation === 'string' ? pattern.transformation.trim() : null,
    exemplar_files: Array.isArray(pattern.exemplar_files) ? pattern.exemplar_files.filter(Boolean) : [],
    exemplar_diff: typeof pattern.exemplar_diff === 'string' ? pattern.exemplar_diff : null,
    file_count: Number.isFinite(Number(pattern.file_count)) ? Number(pattern.file_count) : null,
  };
}

function collectScoutSignals(output) {
  const signals = [];
  if (typeof output !== 'string' || !output.trim()) {
    return signals;
  }
  const parser = new StreamSignalParser((type, data) => {
    signals.push({ type, data });
  });
  parser.feed(output);
  parser.destroy();
  return signals;
}

function collectPatterns(output) {
  const patterns = [];
  for (const signal of collectScoutSignals(output)) {
    if (signal.type !== 'patterns_ready') {
      continue;
    }
    const rawPatterns = Array.isArray(signal.data?.patterns) ? signal.data.patterns : [];
    for (const rawPattern of rawPatterns) {
      const pattern = normalizePattern(rawPattern);
      if (pattern) {
        patterns.push({
          ...pattern,
          shared_dependencies: Array.isArray(signal.data?.shared_dependencies)
            ? signal.data.shared_dependencies
            : [],
        });
      }
    }
  }
  return patterns;
}

function normalizeConcreteWorkItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const title = typeof item.title === 'string' && item.title.trim()
    ? item.title.trim()
    : null;
  if (!title) {
    return null;
  }

  return {
    title,
    why: typeof item.why === 'string' ? item.why.trim() : null,
    description: typeof item.description === 'string' ? item.description.trim() : null,
    allowed_files: Array.isArray(item.allowed_files) ? item.allowed_files.filter(Boolean) : [],
    verification: typeof item.verification === 'string' ? item.verification.trim() : null,
    source: typeof item.source === 'string' ? item.source.trim() : null,
    sources: Array.isArray(item.sources) ? item.sources.filter(Boolean) : [],
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : null,
  };
}

function collectConcreteWorkItems(output) {
  const workItems = [];
  for (const signal of collectScoutSignals(output)) {
    if (signal.type !== 'scout_complete') {
      continue;
    }
    const rawItems = Array.isArray(signal.data?.concrete_factory_work_items)
      ? signal.data.concrete_factory_work_items
      : [];
    for (const rawItem of rawItems) {
      const item = normalizeConcreteWorkItem(rawItem);
      if (item) {
        workItems.push(item);
      }
    }
  }
  return workItems;
}

function buildDescription(pattern, task) {
  return [
    'Starvation recovery scout found an actionable transformation pattern.',
    pattern.description ? `Description: ${pattern.description}` : null,
    pattern.transformation ? `Transformation: ${pattern.transformation}` : null,
    pattern.exemplar_files.length > 0 ? `Exemplar files: ${pattern.exemplar_files.join(', ')}` : null,
    Number.isFinite(pattern.file_count) ? `Estimated file count: ${pattern.file_count}` : null,
    task?.id ? `Scout task: ${task.id}` : null,
  ].filter(Boolean).join('\n\n');
}

function buildConcreteDescription(item, task) {
  return [
    'Starvation recovery scout returned a concrete factory work item.',
    item.why ? `Why: ${item.why}` : null,
    item.description ? `Description: ${item.description}` : null,
    item.allowed_files.length > 0 ? `Allowed files: ${item.allowed_files.join(', ')}` : null,
    item.verification ? `Verification: ${item.verification}` : null,
    task?.id ? `Scout task: ${task.id}` : null,
  ].filter(Boolean).join('\n\n');
}

function priorityForConcreteItem(item) {
  if (!Number.isFinite(item.priority)) {
    return 'default';
  }
  if (item.priority <= 2) {
    return 'high';
  }
  if (item.priority <= 4) {
    return 'medium';
  }
  return 'default';
}

function createScoutOutputIntake({ factoryIntake, logger = console, resolveProjectId } = {}) {
  if (!factoryIntake || typeof factoryIntake.createWorkItem !== 'function') {
    throw new Error('factoryIntake with createWorkItem is required');
  }

  function hasOpenDuplicate(projectId, title) {
    if (typeof factoryIntake.findDuplicates !== 'function') {
      return false;
    }
    try {
      return (factoryIntake.findDuplicates(projectId, title) || []).length > 0;
    } catch (err) {
      logger.warn?.('Scout output duplicate check failed', {
        project_id: projectId,
        err: err.message,
      });
      return false;
    }
  }

  function promoteTask(task) {
    const metadata = normalizeMetadata(task?.metadata);
    if (!isStarvationRecoveryScoutTask(task)) {
      return { created: [], skipped: [], reason: 'not_starvation_recovery_scout' };
    }

    const projectId = metadata.project_id
      || (typeof resolveProjectId === 'function' ? resolveProjectId(task, metadata) : null);
    if (!projectId) {
      return { created: [], skipped: [{ reason: 'missing_project_id' }] };
    }

    const patterns = collectPatterns(task.output || '');
    const concreteItems = collectConcreteWorkItems(task.output || '');
    const created = [];
    const skipped = [];

    if (patterns.length === 0 && concreteItems.length === 0) {
      return { created, skipped: [{ reason: 'no_actionable_scout_output' }] };
    }

    for (const pattern of patterns) {
      const label = pattern.description || pattern.id || 'scout pattern';
      const title = truncateTitle(`Scout pattern: ${label}`);
      if (hasOpenDuplicate(projectId, title)) {
        skipped.push({ reason: 'duplicate_open_item', title });
        continue;
      }

      try {
        const item = factoryIntake.createWorkItem({
          project_id: projectId,
          source: 'scout',
          title,
          description: buildDescription(pattern, task),
          priority: pattern.file_count && pattern.file_count >= 10 ? 'medium' : 'default',
          requestor: 'starvation-recovery-scout',
          origin: {
            type: 'starvation_recovery_scout_pattern',
            task_id: task.id || null,
            pattern_id: pattern.id,
            exemplar_files: pattern.exemplar_files,
            file_count: pattern.file_count,
            shared_dependencies: pattern.shared_dependencies,
          },
        });
        created.push(item);
      } catch (err) {
        logger.warn?.('Scout output work item creation failed', {
          project_id: projectId,
          title,
          err: err.message,
        });
        skipped.push({ reason: 'create_failed', title, error: err.message });
      }
    }

    for (const concreteItem of concreteItems) {
      const title = truncateTitle(concreteItem.title);
      if (hasOpenDuplicate(projectId, title)) {
        skipped.push({ reason: 'duplicate_open_item', title });
        continue;
      }

      try {
        const item = factoryIntake.createWorkItem({
          project_id: projectId,
          source: 'scout',
          title,
          description: buildConcreteDescription(concreteItem, task),
          priority: priorityForConcreteItem(concreteItem),
          requestor: 'starvation-recovery-scout',
          origin: {
            type: 'starvation_recovery_scout_work_item',
            task_id: task.id || null,
            scout_priority: concreteItem.priority,
            allowed_files: concreteItem.allowed_files,
            verification: concreteItem.verification,
            source: concreteItem.source,
            sources: concreteItem.sources,
          },
        });
        created.push(item);
      } catch (err) {
        logger.warn?.('Scout output work item creation failed', {
          project_id: projectId,
          title,
          err: err.message,
        });
        skipped.push({ reason: 'create_failed', title, error: err.message });
      }
    }

    return {
      created,
      skipped,
      patterns_seen: patterns.length,
      work_items_seen: concreteItems.length,
    };
  }

  return { promoteTask };
}

function promoteScoutTaskOutputToIntake(task, deps = {}) {
  if (!isStarvationRecoveryScoutTask(task)) {
    return { created: [], skipped: [], reason: 'not_starvation_recovery_scout' };
  }

  const factoryIntake = deps.factoryIntake || require('../db/factory-intake');
  const logger = deps.logger || console;
  const resolveProjectId = deps.resolveProjectId || ((candidateTask) => {
    try {
      const factoryHealth = deps.factoryHealth || require('../db/factory-health');
      return factoryHealth.getProjectByPath(candidateTask?.working_directory)?.id || null;
    } catch {
      return null;
    }
  });
  return createScoutOutputIntake({ factoryIntake, logger, resolveProjectId }).promoteTask(task);
}

module.exports = {
  STARVATION_RECOVERY_REASON,
  collectConcreteWorkItems,
  collectPatterns,
  createScoutOutputIntake,
  isStarvationRecoveryScoutTask,
  promoteScoutTaskOutputToIntake,
};
