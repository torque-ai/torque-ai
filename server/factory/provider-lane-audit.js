'use strict';

const database = require('../database');
const { safeJsonParse } = require('../utils/json');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ACTIVE_STATUSES = new Set(['pending', 'pending_approval', 'queued', 'running', 'blocked', 'retry_scheduled']);

function normalizeProvider(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeBoolean(value, defaultValue = true) {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function normalizeProviderList(value) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : []);
  const seen = new Set();
  const providers = [];

  for (const entry of raw) {
    const normalized = normalizeProvider(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    providers.push(normalized);
  }

  return providers;
}

function parseJsonObject(value) {
  const parsed = safeJsonParse(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function parseJsonArray(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all()
      .some((entry) => entry && entry.name === column);
  } catch {
    return false;
  }
}

function getTags(row) {
  const tags = parseJsonArray(row.tags);
  return tags.filter((entry) => typeof entry === 'string');
}

function getTagValue(tags, prefix) {
  const match = tags.find((entry) => entry.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

function normalizeFilesModified(value) {
  const files = parseJsonArray(value);
  const seen = new Set();
  const normalized = [];
  for (const entry of files) {
    const filePath = typeof entry === 'string'
      ? entry
      : (entry && typeof entry.path === 'string' ? entry.path : null);
    if (!filePath) continue;
    const trimmed = filePath.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function textExcerpt(value, max = 240) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function getProviderSwitchHistory(metadata) {
  return Array.isArray(metadata.provider_switch_history)
    ? metadata.provider_switch_history.filter((entry) => entry && typeof entry === 'object')
    : [];
}

function getLastProviderSwitch(metadata) {
  if (metadata.last_provider_switch && typeof metadata.last_provider_switch === 'object') {
    return metadata.last_provider_switch;
  }
  const history = getProviderSwitchHistory(metadata);
  return history.length ? history[history.length - 1] : null;
}

function getRoutingTemplate(metadata) {
  return metadata._routing_template
    || metadata.routing_template
    || metadata.requested_routing_template
    || metadata.inherited_routing_template
    || null;
}

function getMergedMetadata(row) {
  return {
    ...parseJsonObject(row.task_metadata),
    ...parseJsonObject(row.metadata),
  };
}

function normalizeTaskRow(row, project) {
  const tags = getTags(row);
  const metadata = getMergedMetadata(row);
  const lastSwitch = getLastProviderSwitch(metadata);
  const provider = normalizeProvider(row.provider);
  const originalProvider = normalizeProvider(row.original_provider);
  const filesModified = normalizeFilesModified(row.files_modified);
  const handoffReason = metadata.agentic_handoff_reason
    || metadata.fallback_reason
    || metadata.provider_selection_lock_reason
    || lastSwitch?.reason
    || null;
  const handoff = {
    active: Boolean(
      metadata.agentic_handoff
      || metadata.agentic_handoff_from
      || metadata.agentic_handoff_to
      || handoffReason
      || (originalProvider && provider && originalProvider !== provider)
      || lastSwitch
    ),
    from: normalizeProvider(metadata.agentic_handoff_from) || normalizeProvider(lastSwitch?.from) || originalProvider,
    to: normalizeProvider(metadata.agentic_handoff_to) || normalizeProvider(lastSwitch?.to) || provider,
    mode: metadata.agentic_handoff_mode || null,
    reason: handoffReason,
    classified: Boolean(
      metadata.agentic_handoff
      || handoffReason
      || (originalProvider && provider && originalProvider !== provider)
      || lastSwitch
    ),
  };
  const workItemId = metadata.work_item_id ?? getTagValue(tags, 'factory:work_item_id=');
  const targetProject = metadata.target_project
    || getTagValue(tags, 'factory:target_project=')
    || project.name
    || null;

  return {
    id: row.id,
    status: row.status || null,
    project: row.project || null,
    target_project: targetProject,
    work_item_id: workItemId === undefined || workItemId === null ? null : Number(workItemId),
    provider,
    model: row.model || null,
    original_provider: originalProvider,
    routing_template: getRoutingTemplate(metadata),
    created_at: row.created_at || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    active: ACTIVE_STATUSES.has(row.status),
    files_modified_count: filesModified.length,
    files_modified: filesModified,
    handoff,
    fallback_reason: metadata.fallback_reason || null,
    task_description: textExcerpt(row.task_description, 160),
    output_excerpt: textExcerpt(row.output),
    error_excerpt: textExcerpt(row.error_output),
  };
}

function increment(map, key) {
  const normalized = key || '(none)';
  map.set(normalized, (map.get(normalized) || 0) + 1);
}

function mapToCounts(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

function summarizeTasks(tasks) {
  const byProvider = new Map();
  const byModel = new Map();
  const byStatus = new Map();
  const byTemplate = new Map();
  let active = 0;
  let handoffs = 0;
  let fileChangeTasks = 0;

  for (const task of tasks) {
    increment(byProvider, task.provider);
    increment(byModel, task.model);
    increment(byStatus, task.status);
    increment(byTemplate, task.routing_template);
    if (task.active) active++;
    if (task.handoff.active) handoffs++;
    if (task.files_modified_count > 0) fileChangeTasks++;
  }

  return {
    total_tasks: tasks.length,
    active_tasks: active,
    handoff_tasks: handoffs,
    file_change_tasks: fileChangeTasks,
    no_file_change_tasks: tasks.length - fileChangeTasks,
    by_provider: mapToCounts(byProvider),
    by_model: mapToCounts(byModel),
    by_status: mapToCounts(byStatus),
    by_routing_template: mapToCounts(byTemplate),
  };
}

function resolveLanePolicy(project, options = {}) {
  const config = parseJsonObject(project.config_json);
  const laneConfig = parseJsonObject(config.provider_lane_policy || config.provider_lane);
  const projectPolicy = parseJsonObject(config.policy);
  const expectedFromRequest = normalizeProvider(options.expected_provider || options.expectedProvider);
  const expectedFromConfig = normalizeProvider(laneConfig.expected_provider || laneConfig.expectedProvider);
  const policyProviders = normalizeProviderList(projectPolicy.provider_restrictions);
  const hasAllowedFallbackOverride = (
    Object.prototype.hasOwnProperty.call(options, 'allowed_fallback_providers')
    && options.allowed_fallback_providers !== undefined
  ) || (
    Object.prototype.hasOwnProperty.call(options, 'allowedFallbackProviders')
    && options.allowedFallbackProviders !== undefined
  );
  const allowedFallbacks = hasAllowedFallbackOverride
    ? normalizeProviderList(options.allowed_fallback_providers || options.allowedFallbackProviders)
    : normalizeProviderList(laneConfig.allowed_fallback_providers || laneConfig.allowedFallbackProviders);
  const hasRequireClassifiedOverride = (
    Object.prototype.hasOwnProperty.call(options, 'require_classified_fallback')
    && options.require_classified_fallback !== undefined
  ) || (
    Object.prototype.hasOwnProperty.call(options, 'requireClassifiedFallback')
    && options.requireClassifiedFallback !== undefined
  );
  const requireClassifiedFallback = hasRequireClassifiedOverride
    ? normalizeBoolean(options.require_classified_fallback ?? options.requireClassifiedFallback, true)
    : normalizeBoolean(laneConfig.require_classified_fallback ?? laneConfig.requireClassifiedFallback, true);

  let expectedProvider = expectedFromRequest || expectedFromConfig || null;
  let source = expectedProvider ? (expectedFromRequest ? 'request' : 'project_config') : 'unconfigured';
  if (!expectedProvider && policyProviders.length === 1) {
    expectedProvider = policyProviders[0];
    source = 'project_policy.provider_restrictions';
  }

  return {
    expected_provider: expectedProvider,
    allowed_fallback_providers: allowedFallbacks,
    allowed_providers: policyProviders,
    require_classified_fallback: requireClassifiedFallback,
    source,
  };
}

function evaluateGuard(tasks, policy) {
  const violations = [];
  const warnings = [];

  for (const task of tasks) {
    if (!task.provider) continue;

    if (policy.allowed_providers.length > 0 && !policy.allowed_providers.includes(task.provider)) {
      violations.push({
        task_id: task.id,
        type: 'provider_not_allowed',
        provider: task.provider,
        expected_provider: policy.expected_provider,
        reason: `Provider "${task.provider}" is outside project provider_restrictions`,
      });
      continue;
    }

    if (!policy.expected_provider) {
      if (task.handoff.active) {
        warnings.push({
          task_id: task.id,
          type: 'fallback_without_expected_provider',
          provider: task.provider,
          reason: task.handoff.reason || 'Task contains handoff metadata but no provider-lane policy is configured',
        });
      }
      continue;
    }

    if (task.provider === policy.expected_provider) {
      continue;
    }

    if (policy.allowed_fallback_providers.includes(task.provider)) {
      if (policy.require_classified_fallback && !task.handoff.classified) {
        violations.push({
          task_id: task.id,
          type: 'unclassified_allowed_fallback',
          provider: task.provider,
          expected_provider: policy.expected_provider,
          reason: `Provider "${task.provider}" is an allowed fallback, but the task has no handoff/fallback classification`,
        });
      } else {
        warnings.push({
          task_id: task.id,
          type: 'allowed_fallback_used',
          provider: task.provider,
          expected_provider: policy.expected_provider,
          reason: task.handoff.reason || `Allowed fallback provider "${task.provider}" was used`,
        });
      }
      continue;
    }

    violations.push({
      task_id: task.id,
      type: 'provider_drift',
      provider: task.provider,
      expected_provider: policy.expected_provider,
      reason: `Provider "${task.provider}" does not match expected provider "${policy.expected_provider}"`,
    });
  }

  let status = 'not_configured';
  if (violations.length > 0) {
    status = 'fail';
  } else if (warnings.length > 0) {
    status = 'warn';
  } else if (policy.expected_provider || policy.allowed_providers.length > 0) {
    status = 'pass';
  }

  return {
    status,
    violations_count: violations.length,
    warnings_count: warnings.length,
    violations,
    warnings,
  };
}

function queryTaskRows(db, project, limit) {
  const hasTaskMetadata = hasColumn(db, 'tasks', 'task_metadata');
  const selectTaskMetadata = hasTaskMetadata ? 'task_metadata' : 'NULL AS task_metadata';
  const conditions = [];
  const params = { limit };

  if (project.id) {
    conditions.push('tags LIKE @projectTag ESCAPE \'\\\'');
    params.projectTag = `%factory:project_id=${escapeLike(project.id)}%`;
    conditions.push('metadata LIKE @projectIdMeta ESCAPE \'\\\'');
    params.projectIdMeta = `%${escapeLike(project.id)}%`;
    conditions.push('project = @projectId');
    params.projectId = project.id;
  }
  if (project.name) {
    conditions.push('project = @projectName');
    params.projectName = project.name;
    conditions.push('tags LIKE @targetTag ESCAPE \'\\\'');
    params.targetTag = `%factory:target_project=${escapeLike(project.name)}%`;
    conditions.push('metadata LIKE @targetNameMeta ESCAPE \'\\\'');
    params.targetNameMeta = `%${escapeLike(project.name)}%`;
  }
  if (project.path) {
    conditions.push('working_directory LIKE @projectPath ESCAPE \'\\\'');
    params.projectPath = `${escapeLike(project.path)}%`;
  }

  if (conditions.length === 0) {
    return [];
  }

  return db.prepare(`
    SELECT
      id, status, project, provider, model, original_provider, tags, metadata, ${selectTaskMetadata},
      working_directory, created_at, started_at, completed_at, files_modified,
      task_description, output, error_output
    FROM tasks
    WHERE ${conditions.map((condition) => `(${condition})`).join(' OR ')}
    ORDER BY COALESCE(created_at, '') DESC, id DESC
    LIMIT @limit
  `).all(params);
}

function buildProviderLaneAudit({ project, db, limit, expected_provider, expectedProvider, allowed_fallback_providers, allowedFallbackProviders, require_classified_fallback, requireClassifiedFallback } = {}) {
  if (!project || typeof project !== 'object') {
    throw new Error('project is required');
  }

  const dbHandle = db || database.getDbInstance();
  if (!dbHandle) {
    throw new Error('database handle is unavailable');
  }
  const resolvedLimit = normalizeLimit(limit);
  const policy = resolveLanePolicy(project, {
    expected_provider,
    expectedProvider,
    allowed_fallback_providers,
    allowedFallbackProviders,
    require_classified_fallback,
    requireClassifiedFallback,
  });
  const rows = queryTaskRows(dbHandle, project, resolvedLimit);
  const tasks = rows.map((row) => normalizeTaskRow(row, project));
  const summary = summarizeTasks(tasks);
  const guard = evaluateGuard(tasks, policy);

  return {
    project: {
      id: project.id || null,
      name: project.name || null,
      path: project.path || null,
    },
    policy,
    window: {
      limit: resolvedLimit,
      returned_tasks: tasks.length,
    },
    summary,
    guard,
    tasks,
  };
}

module.exports = {
  buildProviderLaneAudit,
  _internalForTests: {
    normalizeProviderList,
    normalizeTaskRow,
    resolveLanePolicy,
    evaluateGuard,
  },
};
