'use strict';

const fs = require('fs');
const path = require('path');

let matter;
try {
  matter = require('gray-matter');
} catch {
  matter = null;
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatter(source) {
  if (typeof matter === 'function') return matter(source);

  const normalized = source.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) {
    return { data: {}, content: normalized };
  }

  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { data: {}, content: normalized };
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) {
      throw new Error('Malformed skill frontmatter');
    }
    const [, key, rawValue] = field;
    data[key] = stripWrappingQuotes(rawValue.trim());
  }

  return {
    data,
    content: normalized.slice(match[0].length),
  };
}

// Walks .claude/skills/*/SKILL.md and returns { name, description, body, path }.
// Used by the provider to list available skills before each task turn.
function loadSkills(workingDir) {
  const skillsDir = path.join(workingDir, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  const skills = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    try {
      const parsed = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
      skills.push({
        name: parsed.data.name || entry.name,
        description: parsed.data.description || '',
        body: parsed.content,
        path: skillFile,
      });
    } catch {
      // Skip malformed skills so one bad file does not break provider startup.
    }
  }

  return skills;
}

module.exports = { loadSkills };
