'use strict';

const MAX_DEPTH = 8;
const MAX_NODES = 100;

// Loose mode (back-compat): identifier-only matching. Conflates same-name
// symbols across the repo. Strict mode joins on resolved_symbol_id and only
// surfaces reference edges the indexer pinned through import resolution.
const CALLEES_SQL_LOOSE = `
  SELECT DISTINCT r.target_name AS name
  FROM cg_references r
  JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND s.name = @symbol
`;

const CALLERS_SQL_LOOSE = `
  SELECT DISTINCT s.name AS name
  FROM cg_references r
  JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND r.target_name = @symbol
`;

const CALLEES_SQL_STRICT = `
  SELECT DISTINCT rs.name AS name
  FROM cg_references r
  JOIN cg_symbols s  ON s.id = r.caller_symbol_id
  JOIN cg_symbols rs ON rs.id = r.resolved_symbol_id
  WHERE r.repo_path = @repoPath AND s.name = @symbol
`;

const CALLERS_SQL_STRICT = `
  SELECT DISTINCT s.name AS name
  FROM cg_references r
  JOIN cg_symbols s  ON s.id = r.caller_symbol_id
  JOIN cg_symbols rs ON rs.id = r.resolved_symbol_id
  WHERE r.repo_path = @repoPath AND rs.name = @symbol
`;

function expand(db, repoPath, frontier, sql, isCalleesSql, depth, visited) {
  let next = new Set(frontier);
  const edges = new Set();
  let truncated = false;
  for (let d = 0; d < depth && next.size > 0; d++) {
    const newFrontier = new Set();
    for (const sym of next) {
      const rows = db.prepare(sql).all({ repoPath, symbol: sym });
      for (const r of rows) {
        if (isCalleesSql) edges.add(`${sym}->${r.name}`);
        else              edges.add(`${r.name}->${sym}`);
        if (!visited.has(r.name)) {
          visited.add(r.name);
          newFrontier.add(r.name);
        }
        if (visited.size >= MAX_NODES) {
          truncated = true;
          return { edges, truncated };
        }
      }
    }
    next = newFrontier;
  }
  return { edges, truncated };
}

// Look up kind + modifier flags for a batch of symbol names. Returns a Map
// keyed by name. When multiple symbols share a name (overloads, plugin
// methods + module functions, etc.) we keep the first row — the call graph
// is identifier-only so all same-name symbols are conflated anyway.
const NODE_INFO_SQL = `
  SELECT name, kind, is_async AS isAsync, is_generator AS isGenerator, is_static AS isStatic
  FROM cg_symbols
  WHERE repo_path = @repoPath AND name IN (SELECT value FROM json_each(@names))
`;

function lookupNodeInfo(db, repoPath, names) {
  if (names.length === 0) return new Map();
  const rows = db.prepare(NODE_INFO_SQL).all({ repoPath, names: JSON.stringify(names) });
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.name)) map.set(r.name, r);
  }
  return map;
}

function decorateNode(name, info) {
  const node = { name };
  if (!info) return node;
  node.kind = info.kind;
  if (info.isAsync)     node.is_async = true;
  if (info.isGenerator) node.is_generator = true;
  if (info.isStatic)    node.is_static = true;
  return node;
}

function callGraph({ db, repoPath, symbol, direction = 'callees', depth = 2, scope = 'loose' }) {
  const cap = Math.min(Math.max(1, depth | 0), MAX_DEPTH);
  const visited = new Set([symbol]);
  const allEdges = new Set();
  let truncated = false;

  const calleesSql = scope === 'strict' ? CALLEES_SQL_STRICT : CALLEES_SQL_LOOSE;
  const callersSql = scope === 'strict' ? CALLERS_SQL_STRICT : CALLERS_SQL_LOOSE;

  if (direction === 'callees' || direction === 'both') {
    const r = expand(db, repoPath, [symbol], calleesSql, true, cap, visited);
    for (const e of r.edges) allEdges.add(e);
    truncated = truncated || r.truncated;
  }
  if (direction === 'callers' || direction === 'both') {
    const r = expand(db, repoPath, [symbol], callersSql, false, cap, visited);
    for (const e of r.edges) allEdges.add(e);
    truncated = truncated || r.truncated;
  }

  // One bulk symbol-info lookup, then decorate each node sparsely.
  const names = [...visited];
  const info = lookupNodeInfo(db, repoPath, names);

  return {
    nodes: names.map((name) => decorateNode(name, info.get(name))),
    edges: [...allEdges].map((e) => {
      const [from, to] = e.split('->');
      return { from, to };
    }),
    truncated,
    max_nodes: MAX_NODES,
  };
}

module.exports = { callGraph, MAX_NODES, MAX_DEPTH };
