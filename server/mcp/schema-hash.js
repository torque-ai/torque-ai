'use strict';
const crypto = require('crypto');

function hashToolSchema(tool) {
  const content = JSON.stringify(tool.inputSchema || {});
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function hashAllToolSchemas(tools) {
  const result = {};
  for (const tool of tools) {
    result[tool.name] = hashToolSchema(tool);
  }
  return result;
}

function detectChangedTools(previousHashes, currentHashes) {
  const changed = [];
  const added = [];
  const removed = [];

  for (const [name, hash] of Object.entries(currentHashes)) {
    if (!previousHashes[name]) {
      added.push(name);
    } else if (previousHashes[name] !== hash) {
      changed.push(name);
    }
  }
  for (const name of Object.keys(previousHashes)) {
    if (!currentHashes[name]) {
      removed.push(name);
    }
  }
  return { changed, added, removed, hasChanges: changed.length + added.length + removed.length > 0 };
}

module.exports = { hashToolSchema, hashAllToolSchemas, detectChangedTools };
