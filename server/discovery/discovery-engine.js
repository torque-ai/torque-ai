'use strict';

const logger = require('../logger').child({ component: 'discovery-engine' });
const { assignRolesForProvider } = require('./auto-role-assigner');
const { applyHeuristicCapabilities } = require('./heuristic-capabilities');
const registry = require('../models/registry');

/**
 * Post-discovery processing: apply heuristic capabilities + auto-assign roles.
 * Called after models are synced into the registry.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} provider
 * @param {{ new?: object[] }} syncResult
 * @returns {{ capabilities_set: number, roles_assigned: object[] }}
 */
function runPostDiscovery(db, provider, syncResult) {
  let capabilitiesSet = 0;

  // Apply heuristic capabilities for new models
  for (const model of (syncResult?.new || [])) {
    if (model.family) {
      try {
        applyHeuristicCapabilities(db, model.model_name, model.family);
        capabilitiesSet++;
      } catch (err) {
        logger.warn(`Failed to apply capabilities for ${model.model_name}: ${err.message}`);
      }
    }
  }

  // Auto-assign roles
  let rolesAssigned = [];
  try {
    rolesAssigned = assignRolesForProvider(db, provider);
    if (rolesAssigned.length > 0) {
      logger.info(`Auto-assigned roles for ${provider}: ${rolesAssigned.map(r => `${r.role}=${r.model}`).join(', ')}`);
    }
  } catch (err) {
    logger.warn(`Failed to auto-assign roles for ${provider}: ${err.message}`);
  }

  return { capabilities_set: capabilitiesSet, roles_assigned: rolesAssigned };
}

/**
 * Run discovery for a specific provider via its adapter.
 * Calls adapter.discoverModels(), syncs into registry, runs post-discovery.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ discoverModels(): Promise<{ models: object[], provider: string }> }} adapter
 * @param {string} provider
 * @param {string|null} hostId
 * @returns {Promise<{ discovered: number, new: number, updated: number, removed: number, roles_assigned: object[], capabilities_set: number }>}
 */
async function discoverFromAdapter(db, adapter, provider, hostId) {
  let discoveryResult;
  try {
    discoveryResult = await adapter.discoverModels();
  } catch (err) {
    logger.warn(`Discovery failed for ${provider}: ${err.message}`);
    return { discovered: 0, new: 0, updated: 0, removed: 0, roles_assigned: [], capabilities_set: 0 };
  }

  const models = discoveryResult?.models || [];
  if (models.length === 0) {
    return { discovered: 0, new: 0, updated: 0, removed: 0, roles_assigned: [], capabilities_set: 0 };
  }

  // Feed into registry
  const syncResult = registry.syncModelsFromHealthCheck(provider, hostId || null, models);

  // Auto-approve new models from cloud providers.
  // Local Ollama hosts stay pending; cloud providers should flow through automatically.
  // `ollama-cloud` uses the Ollama protocol against a remote endpoint and its
  // models are Ollama-native — operators curate them like local Ollama models,
  // so keep new models pending until explicitly approved.
  const isCloudProvider = provider !== 'ollama' && provider !== 'ollama-cloud';
  if (isCloudProvider) {
    for (const model of syncResult.new) {
      try {
        registry.approveModel(provider, model.model_name, hostId || null);
      } catch (_err) {
        // already approved — safe to ignore
      }
    }
  }

  // Post-discovery processing
  const postResult = runPostDiscovery(db, provider, syncResult);
  let scoutResult = null;
  if (provider === 'openrouter') {
    try {
      const { runOpenRouterScout } = require('./openrouter-scout');
      scoutResult = await runOpenRouterScout({ db, models, smokeLimit: 0 });
    } catch (err) {
      logger.warn(`OpenRouter scout failed: ${err.message}`);
    }
  }

  return {
    discovered: models.length,
    new: syncResult.new.length,
    updated: syncResult.updated.length,
    removed: syncResult.removed.length,
    roles_assigned: postResult.roles_assigned,
    capabilities_set: postResult.capabilities_set,
    ...(scoutResult ? { openrouter_scout: scoutResult } : {}),
  };
}

module.exports = {
  runPostDiscovery,
  discoverFromAdapter,
};
