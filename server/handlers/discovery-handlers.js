'use strict';

async function handleDiscoverModels(args) {
  const db = require('../database').getDbInstance();
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
  if (result.openrouter_scout) {
    out += `\n\n**OpenRouter scout:** scored ${result.openrouter_scout.scored} model(s)`;
    const scoutRoles = result.openrouter_scout.roles_assigned || [];
    if (scoutRoles.length > 0) {
      out += `; roles ${scoutRoles.map(r => `${r.role}=${r.model}`).join(', ')}`;
    }
    const topModels = result.openrouter_scout.top_models || [];
    if (topModels.length > 0) {
      out += `\nTop scored: ${topModels.map(m => `${m.model_name} (${m.score})`).join(', ')}`;
    }
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

function createDiscoveryHandlers() {
  return { handleDiscoverModels };
}

module.exports = { handleDiscoverModels, createDiscoveryHandlers };
