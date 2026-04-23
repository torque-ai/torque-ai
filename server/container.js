'use strict';

/**
 * server/container.js — DI container and composition root for TORQUE.
 *
 * Every module registers as a factory with declared dependencies.
 * boot() resolves the dependency graph via topological sort and
 * instantiates all services in the correct order.
 *
 * API:
 *   createContainer()   → new container instance
 *   .register(name, deps, factory)  — register a factory
 *   .registerValue(name, value)     — register a pre-built value
 *   .boot()             — resolve deps, run factories
 *   .get(name)          — retrieve an instantiated service
 *   .has(name)          — check if a service is registered
 *   .list()             — list all registered service names
 *   .resetForTest()     — reset to pre-boot state (keeps registrations)
 *   .freeze()           — explicit freeze (must be called after boot)
 */

const logger = require('./logger').child({ component: 'container' });
const path = require('path');

const { createFamilyTemplates } = require('./db/family-templates');
const { createActionRegistry } = require('./dispatch/action-registry');
const { createConstructionCache } = require('./dispatch/construction-cache');
const { createExecutor } = require('./dispatch/executor');
const { createRunDirManager } = require('./runs/run-dir-manager');

/**
 * Topological sort using Kahn's algorithm.
 * @param {Map<string, string[]>} graph - service name → dependency names
 * @returns {string[]} Sorted service names (dependency-first order)
 */
function topoSort(graph) {
  // Validate all deps exist
  for (const [name, deps] of graph) {
    for (const dep of deps) {
      if (!graph.has(dep)) {
        throw new Error(
          `Container: service '${name}' depends on '${dep}' which is not registered`
        );
      }
    }
  }

  // In-degree = number of unresolved dependencies each node has
  const inDeg = new Map();
  for (const [name, deps] of graph) {
    inDeg.set(name, deps.length);
  }

  // Queue starts with nodes that have no dependencies
  const queue = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }

  // Reverse adjacency: for each dep, which services depend on it?
  const dependents = new Map();
  for (const name of graph.keys()) {
    dependents.set(name, []);
  }
  for (const [name, deps] of graph) {
    for (const dep of deps) {
      dependents.get(dep).push(name);
    }
  }

  const sorted = [];
  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);
    for (const dependent of (dependents.get(current) || [])) {
      const newDeg = inDeg.get(dependent) - 1;
      inDeg.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== graph.size) {
    const remaining = [...graph.keys()].filter(n => !sorted.includes(n));
    throw new Error(
      `Container: circular dependency detected among: ${remaining.join(', ')}`
    );
  }

  return sorted;
}

/**
 * Create a new DI container.
 * @returns {object} Container instance
 */
function createContainer() {
  const _registry = new Map();
  const _instances = new Map();
  let _booted = false;
  let _frozen = false;

  function register(name, deps, factory) {
    if (_frozen) throw new Error('Container: cannot register after freeze()');
    if (_booted) {
      throw new Error(`Container is frozen after boot() — cannot register '${name}'`);
    }
    if (_registry.has(name)) {
      logger.warn(`Container: overwriting registration for '${name}'`);
    }
    _registry.set(name, { deps, factory, value: undefined });
  }

  function registerValue(name, value) {
    if (_frozen) throw new Error('Container: cannot registerValue after freeze()');
    if (_booted) {
      throw new Error(`Container is frozen after boot() — cannot register '${name}'`);
    }
    _registry.set(name, { deps: [], factory: null, value });
  }

  function boot() {
    if (_booted) {
      logger.warn('Container: boot() called multiple times — skipping');
      return;
    }

    const graph = new Map();
    for (const [name, entry] of _registry) {
      graph.set(name, entry.deps);
    }

    const order = topoSort(graph);

    for (const name of order) {
      const entry = _registry.get(name);
      if (entry.factory) {
        const deps = {};
        for (const depName of entry.deps) {
          deps[depName] = _instances.get(depName);
        }
        try {
          _instances.set(name, entry.factory(deps));
        } catch (err) {
          const depNames = entry.deps.join(', ') || 'none';
          logger.error(`Container: factory for '${name}' threw (deps: ${depNames}): ${err.message}`);
          throw err;
        }
      } else {
        _instances.set(name, entry.value);
      }
    }

    _booted = true;
    logger.info(`Container: booted ${_instances.size} services`);
  }

  function get(name) {
    if (!_booted) {
      throw new Error(
        `Container: get('${name}') called before boot() — ` +
        `ensure container.boot() is called during startup`
      );
    }
    if (!_instances.has(name)) {
      throw new Error(`Container: service '${name}' is not registered`);
    }
    return _instances.get(name);
  }

  function has(name) {
    return _registry.has(name);
  }

  function list() {
    return [..._instances.keys()];
  }

  function peek(name) {
    if (_instances.has(name)) return _instances.get(name);
    const entry = _registry.get(name);
    if (!entry || entry.factory) return undefined;
    return entry.value;
  }

  function freeze() {
    if (!_booted) {
      throw new Error('Container: cannot freeze before boot() — call boot() first');
    }
    _frozen = true;
  }

  function resetForTest() {
    _instances.clear();
    _booted = false;
    _frozen = false;
  }

  return { register, registerValue, boot, get, has, list, peek, freeze, resetForTest };
}

// ── Legacy compatibility ────────────────────────────────────────────────────
const _defaultContainer = createContainer();

// ── DI-factory registrations ─────────────────────────────────────────────────
// Register services that use the proper DI factory pattern (createXxx(deps)).
// These are resolved at boot() time, after all values (e.g. 'db') are registered.
// index.js registers the database MODULE (not the raw better-sqlite3 handle)
// under the 'db' key. Factories that need prepared statements must unwrap via
// getDbInstance. unwrapDb normalizes both shapes so either registration works.
function unwrapDb(db) {
  return db && typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
}
_defaultContainer.register('familyTemplates', ['db'], ({ db }) => createFamilyTemplates({ db: unwrapDb(db) }));
_defaultContainer.register('actionRegistry', [], () => createActionRegistry());
_defaultContainer.register('constructionCache', ['db'], ({ db }) => createConstructionCache({ db: unwrapDb(db) }));
_defaultContainer.register('executor', ['actionRegistry'], ({ actionRegistry }) => createExecutor({ registry: actionRegistry }));
_defaultContainer.register('runDirManager', ['db'], ({ db }) => {
  const dataDir = typeof db.getDataDir === 'function'
    ? db.getDataDir()
    : require('./data-dir').getDataDir();
  return createRunDirManager({
    db: unwrapDb(db),
    rootDir: path.join(dataDir, 'runs'),
    promotedDir: path.join(dataDir, 'promoted'),
  });
});
_defaultContainer.register('providerScoring', ['db'], ({ db }) => {
  const { createProviderScoring } = require('./db/provider-scoring');
  return createProviderScoring({ db: unwrapDb(db) });
});

_defaultContainer.register('autoRecoveryServices', ['db', 'eventBus', 'logger'], ({ db, eventBus, logger: log }) => {
  const { createAutoRecoveryServices } = require('./factory/auto-recovery/services');
  let handleRetryFactoryVerify = null;
  let factoryIntake = null;
  let factoryHealth = null;
  let loopController = null;
  try {
    ({ handleRetryFactoryVerify } = require('./handlers/factory-handlers'));
  } catch (_e) { void _e; }
  try {
    factoryIntake = require('./db/factory-intake');
    factoryHealth = require('./db/factory-health');
    loopController = require('./factory/loop-controller');
  } catch (_e) { void _e; }
  return createAutoRecoveryServices({
    db: unwrapDb(db), eventBus, logger: log,
    extras: {
      retryFactoryVerify: async (args) =>
        handleRetryFactoryVerify ? handleRetryFactoryVerify(args) : null,
      rejectWorkItem: async ({ project_id, work_item_id, reason }) => {
        if (!factoryIntake) throw new Error('factory intake service unavailable');
        const item = factoryIntake.getWorkItem(work_item_id);
        if (!item) throw new Error(`Work item not found: ${work_item_id}`);
        if (project_id && item.project_id !== project_id) {
          throw new Error(`Work item ${work_item_id} does not belong to project ${project_id}`);
        }
        return factoryIntake.rejectWorkItem(work_item_id, reason);
      },
      advanceLoop: async ({ project_id }) => {
        if (!loopController) throw new Error('factory loop controller unavailable');
        return loopController.advanceLoopForProject(project_id);
      },
      rejectGate: async ({ project_id, stage }) => {
        if (!loopController) throw new Error('factory loop controller unavailable');
        return loopController.rejectGateForProject(project_id, stage);
      },
      startLoop: async ({ project_id, auto_advance }) => {
        if (!loopController) throw new Error('factory loop controller unavailable');
        return auto_advance
          ? loopController.startLoopAutoAdvanceForProject(project_id)
          : loopController.startLoopForProject(project_id);
      },
      pauseProject: async ({ project_id }) => {
        if (!factoryHealth) throw new Error('factory health service unavailable');
        return factoryHealth.updateProject(project_id, { status: 'paused' });
      },
    },
  });
});

_defaultContainer.register(
  'autoRecoveryEngine',
  ['db', 'eventBus', 'logger', 'autoRecoveryServices'],
  ({ db, eventBus, logger: log, autoRecoveryServices }) => {
    const { createAutoRecoveryEngine } = require('./factory/auto-recovery/engine');
    const { createPlugin } = require('./plugins/auto-recovery-core');
    const plugin = createPlugin();
    return createAutoRecoveryEngine({
      db: unwrapDb(db), logger: log, eventBus,
      rules: plugin.classifierRules,
      strategies: plugin.recoveryStrategies,
      services: autoRecoveryServices,
    });
  }
);

_defaultContainer.register(
  'starvationRecovery',
  ['db', 'logger', 'eventBus'],
  ({ db, logger: log, eventBus }) => {
    const { createStarvationRecovery } = require('./factory/starvation-recovery');
    const { createScoutFindingsIntake } = require('./factory/scout-findings-intake');
    const { handleSubmitScout } = require('./handlers/diffusion-handlers');
    const factoryHealth = require('./db/factory-health');
    const factoryIntake = require('./db/factory-intake');
    const factoryLoopInstances = require('./db/factory-loop-instances');
    const recoveryLogger = log?.child
      ? log.child({ component: 'starvation-recovery' })
      : log;
    const rawDb = unwrapDb(db);

    return createStarvationRecovery({
      logger: recoveryLogger,
      submitScout: async (opts) => handleSubmitScout({
        project_id: opts.project_id,
        project_path: opts.project_path,
        reason: opts.reason,
        scope: opts.scope,
        working_directory: opts.working_directory || opts.project_path,
        file_patterns: opts.file_patterns,
        provider: opts.provider || 'codex',
        timeout_minutes: opts.timeout_minutes || 30,
      }),
      countOpenWorkItems: async (projectId) => factoryIntake.listOpenWorkItems({
        project_id: projectId,
        limit: 1,
      }).length,
      ingestScoutFindings: async (project) => {
        if (!rawDb || !project?.path) {
          return { created: [], skipped: [], scanned: 0 };
        }
        const intake = createScoutFindingsIntake({ db: rawDb, factoryIntake });
        return intake.scan({
          project_id: project.id,
          findings_dir: path.join(project.path, 'docs', 'findings'),
        });
      },
      updateLoopState: async (projectId, updates) => {
        const activeInstances = factoryLoopInstances.listInstances({
          project_id: projectId,
          active_only: true,
        });
        const starvedInstance = activeInstances.find((instance) => instance.loop_state === 'STARVED');
        const lastActionAt = updates.loop_last_action_at || new Date().toISOString();
        if (starvedInstance) {
          factoryLoopInstances.updateInstance(starvedInstance.id, {
            loop_state: updates.loop_state,
            paused_at_stage: updates.loop_paused_at_stage || null,
            last_action_at: lastActionAt,
          });
        }

        const projectUpdates = {
          loop_state: updates.loop_state,
          loop_last_action_at: lastActionAt,
          loop_paused_at_stage: updates.loop_paused_at_stage || null,
          consecutive_empty_cycles: updates.consecutive_empty_cycles || 0,
        };
        const project = factoryHealth.updateProject(projectId, projectUpdates);
        eventBus?.emitFactoryLoopChanged?.({
          type: 'state_changed',
          project_id: projectId,
          instance_id: starvedInstance?.id || null,
          loop_state: updates.loop_state,
          paused_at_stage: updates.loop_paused_at_stage || null,
        });
        return project;
      },
    });
  }
);


function getModule(name) {
  try {
    return _defaultContainer.get(name);
  } catch {
    return typeof _defaultContainer.peek === 'function'
      ? _defaultContainer.peek(name)
      : undefined;
  }
}

module.exports = {
  createContainer,
  getModule,
  defaultContainer: _defaultContainer,
};
