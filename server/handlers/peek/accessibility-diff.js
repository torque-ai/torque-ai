'use strict';

const crypto = require('crypto');
const logger = require('../../logger').child({ component: 'peek-accessibility-diff' });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNodes(nodes) {
  if (Array.isArray(nodes)) {
    return nodes;
  }

  if (isPlainObject(nodes)) {
    return [nodes];
  }

  return [];
}

function getNodeKey(node, result) {
  const baseKey = typeof node?.automation_id === 'string' && node.automation_id.trim()
    ? node.automation_id.trim()
    : (typeof node?.name === 'string' && node.name.trim()
      ? node.name.trim()
      : `anon-${result.size}`);

  if (!result.has(baseKey)) {
    return baseKey;
  }

  let suffix = 2;
  let nextKey = `${baseKey}#${suffix}`;

  while (result.has(nextKey)) {
    suffix += 1;
    nextKey = `${baseKey}#${suffix}`;
  }

  logger.debug(`[peek-accessibility-diff] duplicate node key "${baseKey}" encountered, using "${nextKey}"`);
  return nextKey;
}

/**
 * Hash an element tree for quick comparison.
 */
function hashTree(tree) {
  const json = JSON.stringify(tree || []);
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Count total nodes in an element tree recursively.
 */
function countNodes(nodes) {
  return normalizeNodes(nodes).reduce((total, node) => {
    return total + 1 + countNodes(node.children);
  }, 0);
}

/**
 * Flatten a tree into a map of automation_id -> node for diffing.
 */
function flattenTree(nodes, result = new Map()) {
  for (const node of normalizeNodes(nodes)) {
    const key = getNodeKey(node, result);
    result.set(key, {
      name: node.name || null,
      type: node.type || null,
      automation_id: node.automation_id || null,
      bounds: node.bounds || null,
      child_count: normalizeNodes(node.children).length,
    });
    flattenTree(node.children, result);
  }

  return result;
}

function sortEntries(entries) {
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Diff two element trees. Returns a structured diff summary.
 */
function diffTrees(beforeTree, afterTree) {
  const beforeHash = hashTree(beforeTree);
  const afterHash = hashTree(afterTree);

  if (beforeHash === afterHash) {
    return {
      changed: false,
      before_tree_hash: beforeHash,
      after_tree_hash: afterHash,
      diff_summary: 'No changes detected',
      nodes_added: 0,
      nodes_removed: 0,
      nodes_changed: 0,
      details: [],
    };
  }

  const beforeFlat = flattenTree(beforeTree);
  const afterFlat = flattenTree(afterTree);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, afterNode] of afterFlat) {
    if (!beforeFlat.has(key)) {
      added.push({ key, node: afterNode });
      continue;
    }

    const beforeNode = beforeFlat.get(key);
    if (JSON.stringify(beforeNode) !== JSON.stringify(afterNode)) {
      changed.push({ key, before: beforeNode, after: afterNode });
    }
  }

  for (const [key, beforeNode] of beforeFlat) {
    if (!afterFlat.has(key)) {
      removed.push({ key, node: beforeNode });
    }
  }

  sortEntries(added);
  sortEntries(removed);
  sortEntries(changed);

  return {
    changed: true,
    before_tree_hash: beforeHash,
    after_tree_hash: afterHash,
    diff_summary: `${added.length} added, ${removed.length} removed, ${changed.length} changed`,
    nodes_added: added.length,
    nodes_removed: removed.length,
    nodes_changed: changed.length,
    details: [
      ...added.map((item) => ({ type: 'added', key: item.key, node: item.node })),
      ...removed.map((item) => ({ type: 'removed', key: item.key, node: item.node })),
      ...changed.map((item) => ({
        type: 'changed',
        key: item.key,
        before: item.before,
        after: item.after,
      })),
    ],
  };
}

/**
 * Create a before/after snapshot pair for a recovery action.
 */
function createDiffSnapshot(beforeTree, afterTree, action) {
  const diff = diffTrees(beforeTree, afterTree);
  return {
    action: action || 'unknown',
    captured_at: new Date().toISOString(),
    before_node_count: countNodes(beforeTree),
    after_node_count: countNodes(afterTree),
    ...diff,
  };
}

module.exports = {
  hashTree,
  countNodes,
  flattenTree,
  diffTrees,
  createDiffSnapshot,
};
