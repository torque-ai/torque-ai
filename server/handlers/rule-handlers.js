'use strict';

const { loadRules } = require('../rules/rule-loader');
const { selectRules } = require('../rules/rule-selector');

function handleListProjectRules(args = {}) {
  const root = args.working_directory;
  if (!root || typeof root !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'working_directory is required' }] };
  }
  const rules = loadRules(root);
  return {
    content: [{ type: 'text', text: JSON.stringify({ count: rules.length, rules }, null, 2) }],
    structuredData: { count: rules.length, rules },
  };
}

function handlePreviewProjectRules(args = {}) {
  const root = args.working_directory;
  if (!root || typeof root !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'working_directory is required' }] };
  }
  const rules = selectRules(loadRules(root), { files: args.files || [], tags: args.tags || [] });
  return {
    content: [{ type: 'text', text: JSON.stringify({ count: rules.length, rules }, null, 2) }],
    structuredData: { count: rules.length, rules },
  };
}

module.exports = {
  handleListProjectRules,
  handlePreviewProjectRules,
};
