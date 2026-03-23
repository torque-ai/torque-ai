'use strict';

const modelRoles = require('../db/model-roles');

function getRegistry() {
  return require('../models/registry');
}

function textResult(data) {
  return {
    content: [{
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  };
}

function handleListPendingModels() {
  try {
    const registry = getRegistry();
    const pending = registry.listPendingModels();
    const data = {
      pending_count: pending.length,
      models: pending.map(m => ({
        provider: m.provider,
        model_name: m.model_name,
        host_id: m.host_id || null,
        size_bytes: m.size_bytes || null,
        first_seen_at: m.first_seen_at,
      })),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredData: data,
    };
  } catch (err) {
    return textResult(`Error listing pending models: ${err.message}`);
  }
}

function handleApproveModel(args) {
  if (!args.provider || !args.model_name) {
    return { isError: true, content: [{ type: 'text', text: 'Error: provider and model_name are required' }] };
  }

  try {
    const registry = getRegistry();
    registry.approveModel(args.provider, args.model_name, args.host_id || null);
    return textResult(`Model '${args.model_name}' approved for provider '${args.provider}'`);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Error approving model: ${err.message}` }] };
  }
}

function handleDenyModel(args) {
  if (!args.provider || !args.model_name) {
    return { isError: true, content: [{ type: 'text', text: 'Error: provider and model_name are required' }] };
  }

  try {
    const registry = getRegistry();
    registry.denyModel(args.provider, args.model_name, args.host_id || null);
    return textResult(`Model '${args.model_name}' denied for provider '${args.provider}'`);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Error denying model: ${err.message}` }] };
  }
}

function handleBulkApproveModels(args) {
  if (!args.provider) {
    return textResult('Error: provider is required');
  }

  try {
    const registry = getRegistry();
    const count = registry.bulkApproveByProvider(args.provider);
    return textResult(`Approved ${count} pending model(s) for provider '${args.provider}'`);
  } catch (err) {
    return textResult(`Error bulk approving: ${err.message}`);
  }
}

function handleListModels(args = {}) {
  try {
    const registry = getRegistry();
    const filters = {};
    if (args.status) filters.status = args.status;
    if (args.provider) filters.provider = args.provider;

    const models = registry.listModels(filters);
    const data = {
      count: models.length,
      models: models.map(m => ({
        provider: m.provider,
        model_name: m.model_name,
        host_id: m.host_id || null,
        status: m.status,
        size_bytes: m.size_bytes || null,
        first_seen_at: m.first_seen_at,
        last_seen_at: m.last_seen_at,
        approved_at: m.approved_at || null,
      })),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredData: data,
    };
  } catch (err) {
    return textResult(`Error listing models: ${err.message}`);
  }
}

function handleConfigureModelRoles(args) {
  if (!args.provider) {
    return { isError: true, content: [{ type: 'text', text: 'Error: provider is required' }] };
  }
  if (!args.role) {
    return { isError: true, content: [{ type: 'text', text: 'Error: role is required' }] };
  }
  if (!args.model_name) {
    return { isError: true, content: [{ type: 'text', text: 'Error: model_name is required' }] };
  }

  try {
    modelRoles.setModelRole(args.provider, args.role, args.model_name);
    return textResult(`Set ${args.provider}/${args.role} → ${args.model_name}`);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Error configuring model role: ${err.message}` }] };
  }
}

function handleListModelRoles(args = {}) {
  try {
    const roles = modelRoles.listModelRoles(args.provider || undefined);
    if (roles.length === 0) {
      return textResult('No model role assignments found.');
    }

    const header = '| Provider | Role | Model | Updated At |';
    const separator = '|----------|------|-------|------------|';
    const rows = roles.map(r =>
      `| ${r.provider} | ${r.role} | ${r.model_name} | ${r.updated_at || '—'} |`
    );
    const table = [header, separator, ...rows].join('\n');

    return {
      content: [{ type: 'text', text: table }],
      structuredData: { count: roles.length, roles },
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Error listing model roles: ${err.message}` }] };
  }
}

module.exports = {
  handleListPendingModels,
  handleApproveModel,
  handleDenyModel,
  handleBulkApproveModels,
  handleListModels,
  handleConfigureModelRoles,
  handleListModelRoles,
};
