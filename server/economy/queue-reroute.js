// Queue Re-routing — shift queued tasks to economy providers on activation

'use strict';

const db = require('../database');
const { getDefaultPolicy } = require('./policy');
const { analyzeTaskForRouting } = require('../db/provider-routing-core');
const logger = require('../logger').child({ component: 'economy-reroute' });

function getDatabase() {
  if (typeof db.getDb === 'function') {
    return db.getDb();
  }

  if (typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  return null;
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    return null;
  }

  return {
    ...getDefaultPolicy(),
    ...policy,
  };
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) return rawMetadata;
  if (typeof rawMetadata !== 'string') return {};

  try {
    const parsed = JSON.parse(rawMetadata);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function hasUserProviderOverride(task) {
  const metadata = parseMetadata(task?.metadata);
  return Boolean(
    task?.original_provider
    || metadata?.user_provider_override === true
    || (typeof metadata.requested_provider === 'string' && metadata.requested_provider.trim().length > 0)
  );
}

function getTaskComplexity(task) {
  if (typeof task?.complexity === 'string' && task.complexity.length > 0) {
    return task.complexity;
  }

  if (typeof db.determineTaskComplexity === 'function') {
    try {
      return db.determineTaskComplexity(task?.task_description || '', []);
    } catch {
      return null;
    }
  }

  return null;
}

function getScopeFilter(scope, policy) {
  const normalizedScope = String(scope || 'global');
  const scopeFilters = {
    global: null,
    project: {
      column: 'working_directory',
      value: policy?.working_directory || policy?.workingDirectory || null,
    },
    workflow: {
      column: 'workflow_id',
      value: policy?.workflow_id || policy?.workflowId || null,
    },
  };

  const scopeFilter = scopeFilters[normalizedScope] || scopeFilters.global;
  return {
    isGlobal: !scopeFilter || !scopeFilter.value,
    filter: scopeFilter,
  };
}

function rerouteQueuedTasks(scope, policy) {
  const effectivePolicy = normalizePolicy(policy);
  if (!effectivePolicy || !effectivePolicy.enabled) {
    return { rerouted: 0, skipped: 0 };
  }

  const database = getDatabase();
  if (!database || typeof database.prepare !== 'function') {
    return { rerouted: 0, skipped: 0 };
  }

  const scopeSpec = getScopeFilter(scope, effectivePolicy);

  const baseQuery = [
    'SELECT id, status, provider, original_provider, task_description, working_directory, workflow_id, complexity, metadata',
    'FROM tasks',
    'WHERE status = ?',
  ];
  const values = ['queued'];

  if (!scopeSpec.isGlobal && scopeSpec.filter && scopeSpec.filter.value != null) {
    baseQuery.push(`AND ${scopeSpec.filter.column} = ?`);
    values.push(scopeSpec.filter.value);
  }

  baseQuery.push('AND archived = 0');
  baseQuery.push('ORDER BY created_at ASC');

  const runReroute = database.transaction(() => {
    const tasks = database.prepare(baseQuery.join(' ')).all(...values);
    let rerouted = 0;
    let skipped = 0;

    for (const task of tasks) {
      if (hasUserProviderOverride(task)) {
        skipped += 1;
        continue;
      }

      if (effectivePolicy.complexity_exempt && getTaskComplexity(task) === 'complex') {
        skipped += 1;
        continue;
      }

      const routing = analyzeTaskForRouting(task.task_description || '', task.working_directory || null, [], {
        economy: effectivePolicy,
        workflowId: task.workflow_id || null,
      });

      const newProvider = routing?.provider || null;
      const oldProvider = task.provider || null;

      if (newProvider && newProvider !== oldProvider) {
        const metadata = parseMetadata(task.metadata);
        const nextMetadata = {
          ...metadata,
          economy_rerouted: true,
          economy_rerouted_at: new Date().toISOString(),
        };
        const originalEconomyProvider = metadata.economy_original_provider || oldProvider || task.original_provider || null;
        if (originalEconomyProvider) {
          nextMetadata.economy_original_provider = originalEconomyProvider;
        }

        database.prepare('UPDATE tasks SET provider = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ? AND status = \'queued\'').run(
          newProvider,
          JSON.stringify(nextMetadata),
          task.id,
        );
        logger.info(`Economy mode: task ${task.id} re-routed ${oldProvider} -> ${newProvider}`);
        rerouted += 1;
      }
    }

    return { rerouted, skipped };
  });

  return runReroute();
}

function onEconomyActivated(policy) {
  return rerouteQueuedTasks('global', policy);
}

function onEconomyDeactivated() {
  const database = getDatabase();
  if (!database || typeof database.prepare !== 'function') {
    return { restored: 0, skipped: 0 };
  }

  const restoreQueuedTasks = database.transaction(() => {
    const tasks = database.prepare(
      'SELECT id, provider, original_provider, metadata FROM tasks WHERE status = ? AND archived = 0 ORDER BY created_at ASC'
    ).all('queued');

    let restored = 0;
    let skipped = 0;

    for (const task of tasks) {
      const metadata = parseMetadata(task.metadata);
      const restoreProvider = metadata.economy_original_provider || task.original_provider || null;
      const wasEconomyRerouted = metadata.economy_rerouted === true
        || (
          Boolean(restoreProvider)
          && task.provider !== restoreProvider
          && metadata.user_provider_override !== true
          && !metadata.free_provider_retry
          && !metadata.free_tier_overflow
          && !metadata.free_tier_fallback_attempted
        );

      if (!wasEconomyRerouted || !restoreProvider || restoreProvider === task.provider) {
        skipped += 1;
        continue;
      }

      const nextMetadata = { ...metadata };
      delete nextMetadata.economy_rerouted;
      delete nextMetadata.economy_original_provider;
      delete nextMetadata.economy_rerouted_at;

      database.prepare('UPDATE tasks SET provider = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ? AND status = \'queued\'').run(
        restoreProvider,
        JSON.stringify(nextMetadata),
        task.id,
      );
      logger.info(`Economy mode: restored task ${task.id} ${task.provider} -> ${restoreProvider}`);
      restored += 1;
    }

    return { restored, skipped };
  });

  return restoreQueuedTasks();
}

module.exports = {
  rerouteQueuedTasks,
  onEconomyActivated,
  onEconomyDeactivated,
};
