'use strict';

const fs = require('fs');
const path = require('path');

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(pattern) {
  const normalized = normalizePath(pattern);
  let source = '';

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        const slashAfter = normalized[i + 2] === '/';
        source += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(ch);
    }
  }

  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

function listFiles(workingDir) {
  const results = [];
  const pending = [workingDir];
  const visited = new Set();

  while (pending.length > 0) {
    const current = pending.pop();
    let realPath;
    try {
      realPath = fs.realpathSync(current);
    } catch {
      continue;
    }
    if (visited.has(realPath)) continue;
    visited.add(realPath);

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

async function buildDataset({ workingDir, globs, outputPath, ignore = [], maxFileBytes = 100 * 1024 }) {
  const includeMatchers = (Array.isArray(globs) ? globs : [globs]).filter(Boolean).map(globToRegex);
  const ignoreMatchers = (Array.isArray(ignore) ? ignore : [ignore]).filter(Boolean).map(globToRegex);
  const resolvedWorkingDir = path.resolve(workingDir);
  const resolvedOutputPath = path.resolve(outputPath);
  const files = listFiles(resolvedWorkingDir)
    .filter((file) => path.resolve(file) !== resolvedOutputPath)
    .filter((file) => {
      const rel = normalizePath(path.relative(resolvedWorkingDir, file));
      return includeMatchers.some((matcher) => matcher.test(rel))
        && !ignoreMatchers.some((matcher) => matcher.test(rel));
    })
    .sort((a, b) => normalizePath(path.relative(resolvedWorkingDir, a)).localeCompare(
      normalizePath(path.relative(resolvedWorkingDir, b))
    ));

  const out = fs.openSync(outputPath, 'w');
  let count = 0;

  try {
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        if (stat.size > maxFileBytes) continue;
        const content = fs.readFileSync(file, 'utf8');
        const rel = path.relative(resolvedWorkingDir, file);
        const record = {
          prompt: `// File: ${rel}\n`,
          completion: content,
          metadata: { path: rel, bytes: stat.size },
        };
        fs.writeSync(out, `${JSON.stringify(record)}\n`);
        count++;
      } catch {
        // Skip unreadable files and continue building the dataset.
      }
    }
  } finally {
    fs.closeSync(out);
  }

  return { outputPath, record_count: count };
}

module.exports = { buildDataset };
