'use strict';

const MAX_DEPTH = 8;
const MAX_NODES = 100;

const CALLEES_SQL = `
  SELECT DISTINCT r.target_name AS name
  FROM cg_references r
  JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND s.name = @symbol
`;

const CALLERS_SQL = `
  SELECT DISTINCT s.name AS name
  FROM cg_references r
  JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND r.target_name = @symbol
`;

function expand(db, repoPath, frontier, sql, depth, visited) {
  let next = new Set(frontier);
  const edges = new Set();
  for (let d = 0; d < depth && next.size > 0; d++) {
    const newFrontier = new Set();
    for (const sym of next) {
      const rows = db.prepare(sql).all({ repoPath, symbol: sym });
      for (const r of rows) {
        if (sql === CALLEES_SQL) edges.add(`${sym}->${r.name}`);
        else                     edges.add(`${r.name}->${sym}`);
        if (!visited.has(r.name)) {
          visited.add(r.name);
          newFrontier.add(r.name);
        }
        if (visited.size >= MAX_NODES) return edges;
      }
    }
    next = newFrontier;
  }
  return edges;
}

function callGraph({ db, repoPath, symbol, direction = 'callees', depth = 2 }) {
  const cap = Math.min(Math.max(1, depth | 0), MAX_DEPTH);
  const visited = new Set([symbol]);
  const allEdges = new Set();

  if (direction === 'callees' || direction === 'both') {
    for (const e of expand(db, repoPath, [symbol], CALLEES_SQL, cap, visited)) allEdges.add(e);
  }
  if (direction === 'callers' || direction === 'both') {
    for (const e of expand(db, repoPath, [symbol], CALLERS_SQL, cap, visited)) allEdges.add(e);
  }

  return {
    nodes: [...visited].map((name) => ({ name })),
    edges: [...allEdges].map((e) => {
      const [from, to] = e.split('->');
      return { from, to };
    }),
  };
}

module.exports = { callGraph };
