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
  return metadata.mode === 'scout'
    && metadata.reason === STARVATION_RECOVERY_REASON
    && Boolean(metadata.project_id);
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

function createScoutOutputIntake({ factoryIntake, logger = console } = {}) {
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

    const projectId = metadata.project_id;
    const patterns = collectPatterns(task.output || '');
    const created = [];
    const skipped = [];

    if (patterns.length === 0) {
      return { created, skipped: [{ reason: 'no_patterns_ready_signal' }] };
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

    return { created, skipped, patterns_seen: patterns.length };
  }

  return { promoteTask };
}

function promoteScoutTaskOutputToIntake(task, deps = {}) {
  if (!isStarvationRecoveryScoutTask(task)) {
    return { created: [], skipped: [], reason: 'not_starvation_recovery_scout' };
  }

  const factoryIntake = deps.factoryIntake || require('../db/factory-intake');
  const logger = deps.logger || console;
  return createScoutOutputIntake({ factoryIntake, logger }).promoteTask(task);
}

module.exports = {
  STARVATION_RECOVERY_REASON,
  collectPatterns,
  createScoutOutputIntake,
  isStarvationRecoveryScoutTask,
  promoteScoutTaskOutputToIntake,
};
