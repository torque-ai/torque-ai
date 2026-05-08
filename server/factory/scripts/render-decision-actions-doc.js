'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BEGIN_MARKER = '<!-- BEGIN AUTOGEN: decision-actions-table -->';
const END_MARKER = '<!-- END AUTOGEN: decision-actions-table -->';

function formatClassifier(entry) {
  if (entry.classifier === 'recovery-rule' && entry.rule_id) {
    return `\`recovery-rule\` (rule: \`${entry.rule_id}\`)`;
  }
  return `\`${entry.classifier}\``;
}

function formatOutcome(entry) {
  const keys = Array.isArray(entry.outcome) ? entry.outcome : [];
  if (keys.length === 0) return '_(none)_';
  return keys.map((k) => `\`${k}\``).join(', ');
}

function renderTable(catalog) {
  const lines = [];
  lines.push('| Stage | Action | Classifier | Outcome shape |');
  lines.push('|---|---|---|---|');

  for (const [action, entry] of Object.entries(catalog)) {
    const stage = entry.stage || '?';
    lines.push(`| ${stage} | \`${action}\` | ${formatClassifier(entry)} | ${formatOutcome(entry)} |`);
  }

  return lines.join('\n') + '\n';
}

function spliceIntoDoc(docPath, table) {
  const text = fs.readFileSync(docPath, 'utf8');
  const beginIdx = text.indexOf(BEGIN_MARKER);
  const endIdx = text.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`Autogen markers not found in ${docPath}. Add ${BEGIN_MARKER} and ${END_MARKER}.`);
  }
  const before = text.slice(0, beginIdx + BEGIN_MARKER.length);
  const after = text.slice(endIdx);
  return `${before}\n${table}${after}`;
}

if (require.main === module) {
  const write = process.argv.includes('--write');
  const rootDir = process.cwd();
  const { DECISION_ACTIONS } = require(path.join(rootDir, 'server/factory/decision-actions'));
  const table = renderTable(DECISION_ACTIONS);

  if (write) {
    const docPath = path.join(rootDir, 'docs/factory-loop-states.md');
    const updated = spliceIntoDoc(docPath, table);
    fs.writeFileSync(docPath, updated, 'utf8');
    process.stdout.write(`Wrote autogen table to ${docPath}\n`);
  } else {
    process.stdout.write(table);
  }
}

module.exports = { renderTable, spliceIntoDoc, BEGIN_MARKER, END_MARKER };
