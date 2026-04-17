'use strict';

const fs = require('fs');
const path = require('path');

function loadPatternsFromDir(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }

  const patterns = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const patDir = path.join(dir, entry.name);
    const systemPath = path.join(patDir, 'system.md');
    if (!fs.existsSync(systemPath)) continue;

    const pattern = {
      name: entry.name,
      system: fs.readFileSync(systemPath, 'utf8'),
      user_template: null,
      description: null,
      tags: [],
      variables: [],
      source_dir: patDir,
    };

    const userPath = path.join(patDir, 'user.md');
    if (fs.existsSync(userPath)) {
      pattern.user_template = fs.readFileSync(userPath, 'utf8');
    }

    const metaPath = path.join(patDir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.description) pattern.description = meta.description;
        if (Array.isArray(meta.tags)) pattern.tags = meta.tags;
        if (Array.isArray(meta.variables)) pattern.variables = meta.variables;
      } catch {
        // Skip malformed metadata so one bad pattern does not break discovery.
      }
    }

    patterns.push(pattern);
  }

  return patterns;
}

module.exports = { loadPatternsFromDir };
