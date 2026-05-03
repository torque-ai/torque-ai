'use strict';

const fs = require('fs');
const path = require('path');
const { StreamSignalParser } = require('../diffusion/stream-signal-parser');
const { normalizeMetadata } = require('../utils/normalize-metadata');

const STARVATION_RECOVERY_REASON = 'factory_starvation_recovery';
const MAX_TITLE_LENGTH = 140;
const RECENT_TERMINAL_DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TERMINAL_DUPLICATE_STATUSES = Object.freeze([
  'completed',
  'rejected',
  'shipped',
  'shipped_stale',
  'unactionable',
]);
const SIGNAL_MARKERS = {
  patterns_ready: ['__PATTERNS_READY__', '__PATTERNS_READY_END__'],
  scout_discovery: ['__SCOUT_DISCOVERY__', '__SCOUT_DISCOVERY_END__'],
  scout_complete: ['__SCOUT_COMPLETE__', '__SCOUT_COMPLETE_END__'],
};

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

function titleFromIdentifier(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  const basename = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    || raw;
  const withoutExt = basename.replace(/\.[a-z0-9]+$/i, '');
  const withoutLeadingId = withoutExt.replace(/^\d+[-_]+/, '');
  const text = withoutLeadingId
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : raw;
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
  if (typeof item === 'string') {
    const title = titleFromIdentifier(item);
    if (!title) {
      return null;
    }
    return {
      title,
      why: null,
      description: `Scout identified a concrete factory work item reference: ${item}`,
      allowed_files: [],
      verification: null,
      source: item,
      sources: [item],
      priority: null,
    };
  }

  if (!item || typeof item !== 'object') {
    return null;
  }
  const title = typeof item.title === 'string' && item.title.trim()
    ? item.title.trim()
    : titleFromIdentifier(item.id || item.source || item.sources?.[0] || item.source_files?.[0]);
  const allowedFiles = Array.isArray(item.allowed_files)
    ? item.allowed_files.filter(Boolean)
    : (Array.isArray(item.source_files) ? item.source_files.filter(Boolean) : []);
  const validation = Array.isArray(item.validation)
    ? item.validation.filter(Boolean).join('; ')
    : null;
  if (!title) {
    return null;
  }

  return {
    title,
    why: typeof item.why === 'string' ? item.why.trim() : (typeof item.reason === 'string' ? item.reason.trim() : null),
    description: typeof item.description === 'string' ? item.description.trim() : null,
    allowed_files: allowedFiles,
    verification: typeof item.verification === 'string' ? item.verification.trim() : validation,
    source: typeof item.source === 'string' ? item.source.trim() : null,
    sources: Array.isArray(item.sources) ? item.sources.filter(Boolean) : allowedFiles,
    priority: Object.prototype.hasOwnProperty.call(item, 'priority') ? item.priority : null,
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

/**
 * Resolve the working directory for a scout task. Tasks store the actual
 * working directory at the top level; metadata may also carry project_path
 * or working_directory as a fallback. Returns null when none is available
 * — in that case existence checks fail-open (we can't validate without a
 * base directory, so we let the original behavior pass through).
 */
function resolveScoutWorkingDir(task, metadata) {
  const candidates = [
    task?.working_directory,
    metadata?.working_directory,
    metadata?.project_path,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return c.trim();
    }
  }
  return null;
}

/**
 * Filter a list of file path strings to those that exist relative to baseDir.
 * Used to catch hallucinated exemplar_files from small-LLM scouts that invent
 * paths instead of reading the real codebase (observed 2026-04-29 with
 * qwen3-coder:30b producing factory-starvation-recovery.md and 3 other
 * fictional paths in a DLPhone scout, see scout task e50cfe25).
 *
 * @returns {{ kept: string[], dropped: string[], unchecked: boolean }}
 *   `unchecked: true` when baseDir is missing or input is not an array —
 *   callers should fail-open in that case.
 */
function filterExistingFiles(filePaths, baseDir) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { kept: [], dropped: [], unchecked: false };
  }
  if (!baseDir || typeof baseDir !== 'string') {
    return { kept: [...filePaths], dropped: [], unchecked: true };
  }
  const kept = [];
  const dropped = [];
  for (const raw of filePaths) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = trimmed.replace(/\\/g, '/');
    const resolved = path.resolve(baseDir, normalized);
    let exists = false;
    try {
      exists = fs.existsSync(resolved);
    } catch {
      exists = false;
    }
    if (exists) {
      kept.push(raw);
    } else {
      dropped.push(raw);
    }
  }
  return { kept, dropped, unchecked: false };
}

function priorityForConcreteItem(item) {
  if (typeof item.priority === 'string') {
    const normalized = item.priority.trim().toLowerCase();
    if (['low', 'default', 'medium', 'high', 'architect_assigned', 'user_override'].includes(normalized)) {
      return normalized;
    }
  }
  const numeric = Number(item.priority);
  if (!Number.isFinite(numeric)) {
    return 'default';
  }
  if (numeric <= 2) {
    return 'high';
  }
  if (numeric <= 4) {
    return 'medium';
  }
  return 'default';
}

function createScoutOutputIntake({ factoryIntake, logger = console, resolveProjectId } = {}) {
  if (!factoryIntake || typeof factoryIntake.createWorkItem !== 'function') {
    throw new Error('factoryIntake with createWorkItem is required');
  }

  function findScoutDuplicate(projectId, title) {
    if (typeof factoryIntake.findDuplicates !== 'function') {
      return null;
    }
    try {
      const openDuplicates = factoryIntake.findDuplicates(projectId, title) || [];
      if (openDuplicates.length > 0) {
        return {
          reason: 'duplicate_open_item',
          work_item_id: openDuplicates[0]?.item?.id || null,
        };
      }
      if (typeof factoryIntake.findRecentDuplicateWorkItems !== 'function') {
        return null;
      }
      const terminalDuplicates = factoryIntake.findRecentDuplicateWorkItems(projectId, title, {
        source: 'scout',
        statuses: TERMINAL_DUPLICATE_STATUSES,
        windowMs: RECENT_TERMINAL_DUPLICATE_WINDOW_MS,
      }) || [];
      if (terminalDuplicates.length > 0) {
        return {
          reason: 'duplicate_recent_terminal_item',
          work_item_id: terminalDuplicates[0]?.id || null,
        };
      }
      return null;
    } catch (err) {
      logger.warn?.('Scout output duplicate check failed', {
        project_id: projectId,
        err: err.message,
      });
      return null;
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
    const workingDir = resolveScoutWorkingDir(task, metadata);
    const created = [];
    const skipped = [];

    if (patterns.length === 0 && concreteItems.length === 0) {
      return { created, skipped: [{ reason: 'no_actionable_scout_output' }] };
    }

    for (const pattern of patterns) {
      const label = pattern.description || pattern.id || 'scout pattern';
      const title = truncateTitle(`Scout pattern: ${label}`);
      const duplicate = findScoutDuplicate(projectId, title);
      if (duplicate) {
        skipped.push({ ...duplicate, title });
        continue;
      }

      // Existence guard: drop patterns whose exemplar_files are entirely
      // hallucinated. Small-LLM scouts (qwen3-coder:30b on DLPhone, scout
      // task e50cfe25 on 2026-04-29) regularly produce plausible-looking
      // patterns about fictional files. Without this filter the patterns
      // reach the architect, get re-planned 5 times until the deterministic
      // plan-quality cap kicks in, then move on to the next hallucinated
      // pattern — burning a full STARVED recovery cycle on garbage.
      if (pattern.exemplar_files.length > 0) {
        const existence = filterExistingFiles(pattern.exemplar_files, workingDir);
        if (!existence.unchecked && existence.kept.length === 0 && existence.dropped.length > 0) {
          logger.warn?.('Scout pattern dropped: all exemplar_files non-existent', {
            project_id: projectId,
            pattern_id: pattern.id,
            title,
            dropped_files: existence.dropped,
            working_directory: workingDir,
            scout_task_id: task?.id || null,
          });
          skipped.push({
            reason: 'exemplar_files_hallucinated',
            title,
            pattern_id: pattern.id,
            dropped_files: existence.dropped,
          });
          continue;
        }
        if (!existence.unchecked && existence.dropped.length > 0) {
          logger.info?.('Scout pattern: filtered hallucinated exemplar_files', {
            project_id: projectId,
            pattern_id: pattern.id,
            title,
            kept_count: existence.kept.length,
            dropped_count: existence.dropped.length,
            dropped_files: existence.dropped,
            scout_task_id: task?.id || null,
          });
          pattern.exemplar_files = existence.kept;
        }
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
      const duplicate = findScoutDuplicate(projectId, title);
      if (duplicate) {
        skipped.push({ ...duplicate, title });
        continue;
      }

      // Existence guard for concrete work items — same rationale as the
      // pattern loop above. allowed_files is the ground truth for what
      // the EXECUTE stage will be allowed to touch; if all entries are
      // hallucinated, the work item can't possibly be executed.
      if (concreteItem.allowed_files.length > 0) {
        const existence = filterExistingFiles(concreteItem.allowed_files, workingDir);
        if (!existence.unchecked && existence.kept.length === 0 && existence.dropped.length > 0) {
          logger.warn?.('Scout concrete item dropped: all allowed_files non-existent', {
            project_id: projectId,
            title,
            dropped_files: existence.dropped,
            working_directory: workingDir,
            scout_task_id: task?.id || null,
          });
          skipped.push({
            reason: 'allowed_files_hallucinated',
            title,
            dropped_files: existence.dropped,
          });
          continue;
        }
        if (!existence.unchecked && existence.dropped.length > 0) {
          logger.info?.('Scout concrete item: filtered hallucinated allowed_files', {
            project_id: projectId,
            title,
            kept_count: existence.kept.length,
            dropped_count: existence.dropped.length,
            dropped_files: existence.dropped,
            scout_task_id: task?.id || null,
          });
          concreteItem.allowed_files = existence.kept;
        }
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

function promoteScoutSignalToIntake(task, signalType, signalData, deps = {}) {
  const markers = SIGNAL_MARKERS[signalType];
  if (!markers) {
    return { created: [], skipped: [], reason: 'unsupported_scout_signal' };
  }
  const [start, end] = markers;
  const output = [
    start,
    JSON.stringify(signalData || {}),
    end,
  ].join('\n');
  return promoteScoutTaskOutputToIntake({
    ...(task || {}),
    output,
  }, deps);
}

module.exports = {
  STARVATION_RECOVERY_REASON,
  collectConcreteWorkItems,
  collectPatterns,
  createScoutOutputIntake,
  filterExistingFiles,
  isStarvationRecoveryScoutTask,
  promoteScoutSignalToIntake,
  promoteScoutTaskOutputToIntake,
  resolveScoutWorkingDir,
};
