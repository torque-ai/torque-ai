'use strict';

const MAX_DEPTH = 8;
const MAX_NODES = 100;

// Ancestors: who does X extend/implement?  Walk subtype -> supertype.
const ANCESTORS_SQL = `
  SELECT DISTINCT supertype_name AS name, edge_kind AS kind
  FROM cg_class_edges
  WHERE repo_path = @repoPath AND subtype_name = @symbol
`;

// Descendants: who extends/implements X?  Walk supertype -> subtype.
const DESCENDANTS_SQL = `
  SELECT DISTINCT subtype_name AS name, edge_kind AS kind
  FROM cg_class_edges
  WHERE repo_path = @repoPath AND supertype_name = @symbol
`;

// Pull modifiers + kind for a batch of names so the response can show
// `class` vs `interface` vs raw symbol — useful when an extractor surfaces
// a name we don't have a declaration for (cross-module inheritance).
const NODE_INFO_SQL = `
  SELECT name, kind
  FROM cg_symbols
  WHERE repo_path = @repoPath AND name IN (SELECT value FROM json_each(@names))
`;

function lookupNodeInfo(db, repoPath, names) {
  if (names.length === 0) return new Map();
  const rows = db.prepare(NODE_INFO_SQL).all({ repoPath, names: JSON.stringify(names) });
  const map = new Map();
  // First-write-wins so the first declaration we see is what gets surfaced.
  for (const r of rows) if (!map.has(r.name)) map.set(r.name, r);
  return map;
}

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function classHierarchy({ db, repoPath, symbol, direction = 'descendants', depth = 3 }) {
  const dirSql = direction === 'ancestors' ? ANCESTORS_SQL : DESCENDANTS_SQL;
  const cappedDepth = clamp(depth, 1, MAX_DEPTH);

  const visited = new Set([symbol]);
  const edges = []; // {from, to, kind}
  let frontier = new Set([symbol]);
  let truncated = false;

  for (let d = 0; d < cappedDepth && frontier.size > 0; d++) {
    const next = new Set();
    for (const node of frontier) {
      const rows = db.prepare(dirSql).all({ repoPath, symbol: node });
      for (const r of rows) {
        if (direction === 'ancestors') {
          edges.push({ from: node, to: r.name, kind: r.kind });
        } else {
          edges.push({ from: r.name, to: node, kind: r.kind });
        }
        if (!visited.has(r.name)) {
          visited.add(r.name);
          next.add(r.name);
          if (visited.size >= MAX_NODES) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = next;
  }

  // Decorate nodes with their declared kind ('class'/'interface'/etc.) when
  // we have it. Names with no declaration row stay as bare {name} entries.
  const allNames = [...visited];
  const info = lookupNodeInfo(db, repoPath, allNames);
  const nodes = allNames.map((name) => {
    const i = info.get(name);
    return i ? { name, kind: i.kind } : { name };
  });

  return {
    nodes,
    edges,
    truncated,
    max_nodes: MAX_NODES,
    max_depth: MAX_DEPTH,
  };
}

module.exports = { classHierarchy, MAX_NODES, MAX_DEPTH };
