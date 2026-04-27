'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_DEPTH = 3;
const TARGET_FILENAME = 'package-lock.json';
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees']);

function walk(dir, root, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return; // unreadable subdir — skip
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), root, depth + 1, out);
    } else if (entry.isFile() && entry.name === TARGET_FILENAME) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      try {
        const buf = fs.readFileSync(abs);
        out[rel] = crypto.createHash('sha256').update(buf).digest('hex');
      } catch (_err) {
        // unreadable file — skip
      }
    }
  }
}

function computeLockHashes(projectRoot) {
  const out = {};
  walk(projectRoot, projectRoot, 0, out);
  return out;
}

module.exports = { computeLockHashes };
