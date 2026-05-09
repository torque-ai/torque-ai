/** MCP + REST handlers for routing template CRUD */

'use strict';

const templateStore = require('../routing/template-store');
const { getCategories } = require('../routing/category-classifier');
const providerRoutingCore = require('../db/provider/routing-core');

function makeTextResult(message, isError = false) {
  const payload = [{ type: 'text', text: typeof message === 'string' ? message : JSON.stringify(message, null, 2) }];
  return isError ? { isError: true, content: payload } : { content: payload };
}

function getChainPrimaryProvider(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value.find((entry) => {
    if (typeof entry === 'string') return entry.trim();
    return entry && typeof entry.provider === 'string' && entry.provider.trim();
  });
  if (typeof first === 'string') return first.trim() || null;
  return first?.provider?.trim() || null;
}

function collectPrimaryProviders(template) {
  const providers = new Map();
  const add = (provider, label) => {
    if (!provider) return;
    const existing = providers.get(provider) || { provider, categories: [] };
    existing.categories.push(label);
    providers.set(provider, existing);
  };

  for (const [category, rule] of Object.entries(template?.rules || {})) {
    add(getChainPrimaryProvider(rule), category);
  }

  for (const [category, overrides] of Object.entries(template?.complexity_overrides || {})) {
    if (!overrides || typeof overrides !== 'object') continue;
    for (const [complexity, rule] of Object.entries(overrides)) {
      add(getChainPrimaryProvider(rule), `${category}.${complexity}`);
    }
  }

  return [...providers.values()];
}

function summarizeCategories(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  if (categories.length <= 4) return categories.join(', ');
  return `${categories.slice(0, 4).join(', ')} +${categories.length - 4} more`;
}

function getProviderActivationIssue(provider) {
  let config = null;
  try {
    config = providerRoutingCore.getProvider(provider);
  } catch {
    config = null;
  }
  if (!config) {
    return { reason: 'missing_provider_config', enabled: false, configured: false };
  }

  const enabled = Boolean(config.enabled);
  let configured = true;
  try {
    configured = providerRoutingCore.isProviderConfiguredForRouting(provider);
  } catch {
    configured = true;
  }

  if (!enabled) return { reason: 'disabled', enabled, configured };
  if (!configured) return { reason: 'missing_api_key', enabled, configured };
  return null;
}

function getActivationWarnings(template) {
  const unavailable = [];
  for (const entry of collectPrimaryProviders(template)) {
    const issue = getProviderActivationIssue(entry.provider);
    if (!issue) continue;
    unavailable.push({
      provider: entry.provider,
      categories: entry.categories,
      reason: issue.reason,
      enabled: issue.enabled,
      configured: issue.configured,
    });
  }

  if (unavailable.length === 0) return [];
  const providerSummary = unavailable
    .map((entry) => `${entry.provider} (${summarizeCategories(entry.categories)})`)
    .join('; ');

  return [{
    code: 'routing_template_primary_unavailable',
    severity: 'warning',
    message: `Template '${template.name}' activated, but these primary providers are not enabled or configured: ${providerSummary}. Routing will fall through to later providers in each chain.`,
    providers: unavailable,
  }];
}

function handleListRoutingTemplates() {
  const templates = templateStore.listTemplates();
  return makeTextResult(templates);
}

function handleGetRoutingTemplate(args) {
  const tmpl = args.id
    ? templateStore.getTemplate(args.id)
    : args.name
      ? templateStore.getTemplateByName(args.name)
      : null;
  if (!tmpl) return makeTextResult('Template not found', true);
  return makeTextResult(tmpl);
}

function handleSetRoutingTemplate(args) {
  if (!args.name || !args.rules) {
    return makeTextResult('name and rules are required', true);
  }
  const existing = templateStore.getTemplateByName(args.name);
  if (existing && existing.preset) {
    return makeTextResult(`Cannot modify preset template '${args.name}'. Duplicate it first.`, true);
  }
  try {
    if (existing) {
      const updated = templateStore.updateTemplate(existing.id, {
        description: args.description,
        rules: args.rules,
        complexity_overrides: args.complexity_overrides,
      });
      return makeTextResult(updated);
    } else {
      const created = templateStore.createTemplate({
        name: args.name,
        description: args.description || '',
        rules: args.rules,
        complexity_overrides: args.complexity_overrides || {},
      });
      return makeTextResult(created);
    }
  } catch (err) {
    return makeTextResult(err.message, true);
  }
}

function handleDeleteRoutingTemplate(args) {
  const tmpl = args.id
    ? templateStore.getTemplate(args.id)
    : args.name
      ? templateStore.getTemplateByName(args.name)
      : null;
  if (!tmpl) return makeTextResult('Template not found', true);
  try {
    const result = templateStore.deleteTemplate(tmpl.id);
    return makeTextResult(result.deleted ? `Deleted template '${tmpl.name}'` : 'Template not deleted');
  } catch (err) {
    return makeTextResult(err.message, true);
  }
}

function handleActivateRoutingTemplate(args) {
  if (args.id === null || args.id === 'null') {
    templateStore.setActiveTemplate(null);
    return makeTextResult({ message: 'Active template cleared — using System Default', warnings: [] });
  }
  const tmpl = args.id
    ? templateStore.getTemplate(args.id)
    : args.name
      ? templateStore.getTemplateByName(args.name)
      : null;
  if (!tmpl) return makeTextResult('Template not found', true);
  try {
    templateStore.setActiveTemplate(tmpl.id);
    return makeTextResult({
      message: `Active template set to '${tmpl.name}'`,
      template: { id: tmpl.id, name: tmpl.name },
      warnings: getActivationWarnings(tmpl),
    });
  } catch (err) {
    return makeTextResult(err.message, true);
  }
}

function handleGetActiveRouting() {
  const explicitId = templateStore.getExplicitActiveTemplateId();
  const tmpl = templateStore.getActiveTemplate();
  if (!tmpl) return makeTextResult('No active template and System Default not found', true);
  return makeTextResult({
    template: tmpl,
    explicit: !!explicitId,
    categories: getCategories(),
  });
}

function handleListRoutingCategories() {
  return makeTextResult(getCategories());
}

module.exports = {
  handleListRoutingTemplates,
  handleGetRoutingTemplate,
  handleSetRoutingTemplate,
  handleDeleteRoutingTemplate,
  handleActivateRoutingTemplate,
  handleGetActiveRouting,
  handleListRoutingCategories,
  getActivationWarnings,
};
