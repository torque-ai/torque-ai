'use strict';

const defaultModelRegistry = require('../models/registry');

let _deps = {};

function init(deps = {}) {
  _deps = { ...deps };
  if (_deps.db && typeof defaultModelRegistry.setDb === 'function') {
    defaultModelRegistry.setDb(_deps.db);
  }
}

function getModelRegistry(deps = {}) {
  if (deps?.modelRegistry) {
    return deps.modelRegistry;
  }
  if (deps?.registry) {
    return deps.registry;
  }
  if (deps?.db && typeof defaultModelRegistry.setDb === 'function') {
    defaultModelRegistry.setDb(deps.db);
  }
  return defaultModelRegistry;
}

function handleListModels(args, deps) {
  const provider = args?.provider;
  const rows = getModelRegistry(deps).listModelSummaries({ provider });

  if (rows.length === 0) {
    return '## Models\n\nNo models registered. Run `discover_models` to scan providers.';
  }

  // Group by provider
  const byProvider = {};
  for (const row of rows) {
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  let out = '## Registered Models\n\n';
  for (const [prov, models] of Object.entries(byProvider)) {
    out += `### ${prov}\n\n`;
    out += '| Model | Family | Size | Role | Hashline | Agentic | Status |\n';
    out += '|-------|--------|------|------|----------|---------|--------|\n';
    for (const m of models) {
      const size = m.parameter_size_b ? `${m.parameter_size_b}B` : '-';
      const role = m.role || '-';
      const hl = m.cap_hashline ? 'Y' : '-';
      const ag = m.cap_agentic ? 'Y' : '-';
      out += `| ${m.model_name} | ${m.family || '?'} | ${size} | ${role} | ${hl} | ${ag} | ${m.status} |\n`;
    }
    out += '\n';
  }
  return out;
}

function handleAssignModelRole(args, deps) {
  const { provider, role, model_name } = args || {};

  if (!provider || !role || !model_name) {
    return 'Required: provider, role, model_name. Valid roles: fast, balanced, quality, default, fallback.';
  }

  const validRoles = ['fast', 'balanced', 'quality', 'default', 'fallback'];
  if (!validRoles.includes(role)) {
    return `Invalid role "${role}". Valid roles: ${validRoles.join(', ')}`;
  }

  getModelRegistry(deps).assignModelRole(provider, role, model_name);

  return `Assigned ${provider}/${role} = ${model_name}`;
}

function createModelRegistryHandlers(deps) {
  return {
    handleListModels: (args) => handleListModels(args, deps),
    handleAssignModelRole: (args) => handleAssignModelRole(args, deps),
  };
}

module.exports = {
  init,
  createModelRegistryHandlers,
  handleListModels: (args) => handleListModels(args, _deps),
  handleAssignModelRole: (args) => handleAssignModelRole(args, _deps),
};
