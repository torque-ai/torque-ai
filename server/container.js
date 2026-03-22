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
 *   .boot()             — resolve deps, run factories, freeze
 *   .get(name)          — retrieve an instantiated service
 *   .has(name)          — check if a service is registered
 *   .list()             — list all registered service names
 *   .resetForTest()     — reset to pre-boot state (keeps registrations)
 *   .freeze()           — explicit freeze (must be called after boot)
 */

const logger = require('./logger').child({ component: 'container' });

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

  function register(name, deps, factory) {
    if (_booted) {
      throw new Error(`Container is frozen after boot() — cannot register '${name}'`);
    }
    if (_registry.has(name)) {
      logger.warn(`Container: overwriting registration for '${name}'`);
    }
    _registry.set(name, { deps, factory, value: undefined });
  }

  function registerValue(name, value) {
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
  }

  function resetForTest() {
    _instances.clear();
    _booted = false;
  }

  return { register, registerValue, boot, get, has, list, freeze, resetForTest };
}

// ── Legacy compatibility ────────────────────────────────────────────────────
const _defaultContainer = createContainer();

function initModules(db, serverConfig) {
  if (!_defaultContainer.has('db')) {
    _defaultContainer.registerValue('db', db);
  }
  if (!_defaultContainer.has('serverConfig')) {
    _defaultContainer.registerValue('serverConfig', serverConfig);
  }

  serverConfig.init({ db });
  logger.info('Container: config.js wired via init(deps)');

  const providerCfg = require('./providers/config');
  providerCfg.init({ db });
  if (!_defaultContainer.has('providerCfg')) {
    _defaultContainer.registerValue('providerCfg', providerCfg);
  }

  const providerRegistry = require('./providers/registry');
  providerRegistry.init({ db });
  if (!_defaultContainer.has('providerRegistry')) {
    _defaultContainer.registerValue('providerRegistry', providerRegistry);
  }

  const mcpProtocol = require('./mcp-protocol');
  if (!_defaultContainer.has('mcpProtocol')) {
    _defaultContainer.registerValue('mcpProtocol', mcpProtocol);
  }

  logger.info('Container: core modules initialized (legacy path)');
}

function getModule(name) {
  try {
    return _defaultContainer.get(name);
  } catch {
    return undefined;
  }
}

module.exports = {
  createContainer,
  initModules,
  getModule,
  defaultContainer: _defaultContainer,
};
