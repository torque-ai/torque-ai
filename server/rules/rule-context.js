'use strict';

const path = require('path');
const { loadRules } = require('./rule-loader');
const { selectRules } = require('./rule-selector');

function resolveRoot(task = {}) {
  return task.working_directory || task.project_root || process.cwd();
}

function formatRuleBlock(rules = []) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const lines = ['## Project rules'];
  for (const rule of rules) {
    lines.push(`### ${rule.title || rule.id}`);
    lines.push(rule.body);
  }
  return lines.join('\n\n');
}

function injectRules(description, task = {}) {
  const root = resolveRoot(task);
  const files = Array.isArray(task.files_modified)
    ? task.files_modified
    : Array.isArray(task.file_paths)
      ? task.file_paths
      : [];
  const relativeFiles = files.map((file) => {
    try { return path.relative(root, file).replace(/\\/g, '/'); } catch { return String(file); }
  });
  const rules = selectRules(loadRules(root), {
    files: relativeFiles,
    tags: Array.isArray(task.tags) ? task.tags : [],
  });
  const block = formatRuleBlock(rules);
  return block ? `${block}\n\n---\n\n${description}` : description;
}

module.exports = {
  formatRuleBlock,
  injectRules,
};
