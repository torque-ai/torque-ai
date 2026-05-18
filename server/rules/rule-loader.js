'use strict';

const fs = require('fs');
const path = require('path');

function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { data: {}, body: text };
  }

  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: text };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else if (/^(true|false)$/i.test(value)) {
      value = /^true$/i.test(value);
    }
    data[key] = value;
  }

  return { data, body: text.slice(match[0].length).trim() };
}

function loadRules(rootDir) {
  const rulesDir = path.join(rootDir, '.torque', 'rules');
  if (!fs.existsSync(rulesDir)) return [];

  const files = fs.readdirSync(rulesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(rulesDir, entry.name))
    .sort();

  return files.map((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseFrontmatter(raw);
    return {
      id: parsed.data.id || path.basename(file, '.md'),
      title: parsed.data.title || path.basename(file, '.md'),
      applies_to: parsed.data.applies_to || parsed.data.files || ['**/*'],
      tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
      enabled: parsed.data.enabled !== false,
      path: file,
      body: parsed.body,
    };
  }).filter((rule) => rule.enabled);
}

module.exports = {
  parseFrontmatter,
  loadRules,
};
