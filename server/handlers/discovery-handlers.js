'use strict';

const { resolveHandlerDatabase } = require('./shared');

let discoveryHandlerDeps = {};

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeDiscoveryHandlerDeps(deps = {}) {
  const normalized = {};
  if (hasOwn(deps, 'db')) normalized.db = deps.db;
  if (hasOwn(deps, 'rawDb')) normalized.rawDb = deps.rawDb;
  if (hasOwn(deps, 'container')) normalized.container = deps.container;
  return normalized;
}

function getDiscoveryDb() {
  const db = resolveHandlerDatabase(discoveryHandlerDeps, { raw: true });
  if (!db) {
    throw new Error('discovery-handlers database dependency is missing (expected db or dbInstance)');
  }
  return db;
}

async function handleDiscoverModels(args) {
  const db = getDiscoveryDb();
  // Ensure model registry has the DB handle (legacy setDb pattern)
  const registry = require('../models/registry');
  if (typeof registry.setDb === 'function') registry.setDb(db);
  const provider = args?.provider;

  if (provider) {
    const { discoverFromAdapter } = require('../discovery/discovery-engine');
    const { getProviderAdapter } = require('../providers/adapter-registry');
    const adapter = getProviderAdapter(provider);
    if (!adapter) return `Unknown provider: ${provider}. Use list_providers to see available providers.`;
    const result = await discoverFromAdapter(db, adapter, provider, null);
    return formatDiscoveryResult(provider, result);
  }

  const { discoverAllModels } = require('../providers/adapter-registry');
  const results = await discoverAllModels(db);
  return formatAllResults(results);
}

function formatDiscoveryResult(provider, result) {
  if (result.error) return `## Discovery: ${provider}\n\nError: ${result.error}`;
  let out = `## Discovery: ${provider}\n\n`;
  out += `| Metric | Count |\n|--------|-------|\n`;
  out += `| Discovered | ${result.discovered} |\n`;
  out += `| New | ${result.new} |\n`;
  out += `| Updated | ${result.updated} |\n`;
  out += `| Removed | ${result.removed} |\n`;
  out += `| Capabilities set | ${result.capabilities_set} |\n`;
  if (result.roles_assigned && result.roles_assigned.length > 0) {
    out += `\n**Roles assigned:** ${result.roles_assigned.map(r => `${r.role}=${r.model}`).join(', ')}`;
  }
  return out;
}

function formatAllResults(results) {
  if (!results || Object.keys(results).length === 0) {
    return '## Model Discovery\n\nNo providers available for discovery. Enable providers with API keys first.';
  }
  let out = '## Model Discovery Results\n\n';
  for (const [provider, result] of Object.entries(results)) {
    out += formatDiscoveryResult(provider, result) + '\n\n';
  }
  return out;
}

function withDiscoveryHandlerDeps(deps, handler) {
  return (...args) => {
    const previousDeps = discoveryHandlerDeps;
    discoveryHandlerDeps = deps;
    try {
      const result = handler(...args);
      if (result && typeof result.then === 'function') {
        return result.finally(() => {
          discoveryHandlerDeps = previousDeps;
        });
      }
      discoveryHandlerDeps = previousDeps;
      return result;
    } catch (error) {
      discoveryHandlerDeps = previousDeps;
      throw error;
    }
  };
}

function createDiscoveryHandlers(deps = {}) {
  const normalizedDeps = normalizeDiscoveryHandlerDeps(deps);
  return { handleDiscoverModels: withDiscoveryHandlerDeps(normalizedDeps, handleDiscoverModels) };
}

module.exports = { handleDiscoverModels, createDiscoveryHandlers };
