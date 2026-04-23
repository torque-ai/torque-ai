'use strict';

const { RemoteAgentRegistry } = require('./agent-registry');

let _registry = null;
let _registryResolved = false;
let _registryError = null;
let _handlerCache = null;
let _handlerCacheRegistry = null;
let _handlerCacheDb = null;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function unwrapRemoteAgentDb(dbService) {
  const rawDb = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('remote agent registry requires db service with prepare()');
  }
  return rawDb;
}

function resolveDefaultDb() {
  return require('../../database');
}

function resolveHandlerDb(deps = {}) {
  if (hasOwn(deps, 'db')) {
    return deps.db;
  }

  try {
    const { defaultContainer } = require('../../container');
    const db = defaultContainer.get('db');
    if (db) return db;
  } catch {
    // Fall back to the legacy database facade below.
  }

  return resolveDefaultDb();
}

function resetRemoteAgentPluginHandlers() {
  _handlerCache = null;
  _handlerCacheRegistry = null;
  _handlerCacheDb = null;
}

function setRemoteAgentRegistry(remoteAgentRegistry) {
  const nextRegistry = remoteAgentRegistry || null;
  if (nextRegistry !== _registry) {
    resetRemoteAgentPluginHandlers();
  }
  _registry = nextRegistry;
  _registryResolved = true;
  _registryError = null;
  return _registry;
}

function shouldResolveRegistry(deps = {}) {
  if (!_registryResolved) return true;
  if (_registry) return false;
  return hasOwn(deps, 'db');
}

function resolveRemoteAgentRegistry(deps = {}) {
  if (hasOwn(deps, 'remoteAgentRegistry')) {
    return setRemoteAgentRegistry(deps.remoteAgentRegistry);
  }

  if (!shouldResolveRegistry(deps)) {
    return _registry;
  }

  try {
    const dbService = hasOwn(deps, 'db') ? deps.db : resolveDefaultDb();
    const nextRegistry = new RemoteAgentRegistry(unwrapRemoteAgentDb(dbService));
    if (nextRegistry !== _registry) {
      resetRemoteAgentPluginHandlers();
    }
    _registry = nextRegistry;
    _registryError = null;
  } catch (err) {
    _registry = null;
    _registryError = err;
  }
  _registryResolved = true;
  return _registry;
}

function requireRemoteAgentRegistry(deps = {}) {
  const registry = resolveRemoteAgentRegistry(deps);
  if (!registry) {
    throw _registryError || new Error('remote agent registry is not available');
  }
  return registry;
}

function getInstalledRegistry() {
  return _registry;
}

function getRemoteAgentPluginHandlers(deps = {}) {
  const agentRegistry = resolveRemoteAgentRegistry(deps);
  if (!agentRegistry) return null;

  const database = resolveHandlerDb(deps);
  if (
    _handlerCache
    && _handlerCacheRegistry === agentRegistry
    && _handlerCacheDb === database
  ) {
    return _handlerCache;
  }

  const { createHandlers } = require('./handlers');
  _handlerCache = createHandlers({
    agentRegistry,
    db: database,
  });
  _handlerCacheRegistry = agentRegistry;
  _handlerCacheDb = database;
  return _handlerCache;
}

function resetRemoteAgentRegistry() {
  _registry = null;
  _registryResolved = false;
  _registryError = null;
  resetRemoteAgentPluginHandlers();
}

module.exports = {
  unwrapRemoteAgentDb,
  resolveRemoteAgentRegistry,
  requireRemoteAgentRegistry,
  getInstalledRegistry,
  setRemoteAgentRegistry,
  resetRemoteAgentRegistry,
  getRemoteAgentPluginHandlers,
  resetRemoteAgentPluginHandlers,
};
