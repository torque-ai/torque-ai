/** MCP + REST handlers for routing template CRUD */

'use strict';

const templateStore = require('../routing/template-store');
const { getCategories } = require('../routing/category-classifier');

function makeTextResult(message, isError = false) {
  const payload = [{ type: 'text', text: typeof message === 'string' ? message : JSON.stringify(message, null, 2) }];
  return isError ? { isError: true, content: payload } : { content: payload };
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
    return makeTextResult('Active template cleared — using System Default');
  }
  const tmpl = args.id
    ? templateStore.getTemplate(args.id)
    : args.name
      ? templateStore.getTemplateByName(args.name)
      : null;
  if (!tmpl) return makeTextResult('Template not found', true);
  try {
    templateStore.setActiveTemplate(tmpl.id);
    return makeTextResult(`Active template set to '${tmpl.name}'`);
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
};
