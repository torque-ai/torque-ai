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

  return { register, registerValue, boot, get, has, list, freeze, resetForTest };
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
_defaultContainer.register('starvationRecovery', [], () => {
  const { createStarvationRecovery } = require('./factory/starvation-recovery');
  const diffusionHandlers = require('./handlers/diffusion-handlers');
  const loopController = require('./factory/loop-controller');

  // Scout dispatcher: handleSubmitScout takes ONE scope per call, so we fan out
  // the variant set in parallel. Each variant becomes one scout task.
  const VARIANT_SCOPES = {
    quality: 'scan the project for code quality issues, dead code, missing tests, and refactoring opportunities; write findings to docs/findings/',
    security: 'scan the project for security issues (auth, input validation, secret handling, injection); write findings to docs/findings/',
    performance: 'scan the project for performance issues (slow queries, N+1, sync I/O, hot paths); write findings to docs/findings/',
    documentation: 'scan the project for documentation gaps and stale docs; write findings to docs/findings/',
    'test-coverage': 'scan the project for files lacking test coverage; write findings to docs/findings/',
    dependency: 'scan the project for outdated, unused, or risky dependencies; write findings to docs/findings/',
  };

  async function submitScout({ project_id, project_path, variants, reason }) {
    const list = Array.isArray(variants) && variants.length ? variants : Object.keys(VARIANT_SCOPES);
    const tasks = await Promise.all(list.map((variant) => {
      const scope = VARIANT_SCOPES[variant] || `scan the project for ${variant} issues; write findings to docs/findings/`;
      return Promise.resolve(diffusionHandlers.handleSubmitScout({
        scope: `${scope} (variant: ${variant}, reason: ${reason || 'starvation_recovery'}, project: ${project_id})`,
        working_directory: project_path,
        provider: 'codex',
      }));
    }));
    return { task_count: tasks.length };
  }

  function updateLoopState(project_id, updates) {
    const factoryHealth = require('./db/factory-health');
    const project = factoryHealth.getProject(project_id);
    if (!project) return;
    const factoryLoopInstances = require('./db/factory-loop-instances');
    const instances = factoryLoopInstances.getActiveInstancesForProject
      ? factoryLoopInstances.getActiveInstancesForProject(project_id)
      : (loopController.getActiveInstances ? loopController.getActiveInstances(project_id) : []);
    if (Array.isArray(instances) && instances.length > 0) {
      const target = instances[0];
      if (typeof loopController.updateInstanceAndSync === 'function') {
        loopController.updateInstanceAndSync(target.id, {
          loop_state: updates.loop_state,
          last_action_at: updates.last_action_at,
        });
      } else if (typeof factoryLoopInstances.updateInstance === 'function') {
        factoryLoopInstances.updateInstance(target.id, {
          loop_state: updates.loop_state,
          last_action_at: updates.last_action_at,
        });
        if (typeof loopController.syncLegacyProjectLoopState === 'function') {
          loopController.syncLegacyProjectLoopState(project_id);
        }
      } else if (typeof loopController.syncLegacyProjectLoopState === 'function') {
        loopController.syncLegacyProjectLoopState(project_id);
      }
    } else if (typeof loopController.syncLegacyProjectLoopState === 'function') {
      loopController.syncLegacyProjectLoopState(project_id);
    }
  }

  return createStarvationRecovery({
    submitScout,
    updateLoopState,
    dwellMs: 15 * 60 * 1000,
  });
});


function getModule(name) {
  try {
    return _defaultContainer.get(name);
  } catch {
    return undefined;
  }
}

module.exports = {
  createContainer,
  getModule,
  defaultContainer: _defaultContainer,
};
