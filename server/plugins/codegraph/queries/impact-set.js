'use strict';

const { callGraph } = require('./call-graph');

// Default depth changed from 5 to 3. Depth 5 on foundational functions
// (e.g. gracefulShutdown) returned 100+ symbols across 300+ files, which
// is more impact-set than fits in an LLM's context window for planning.
// Depth 3 captures the local blast radius (direct callers + their callers
// + theirs) which is the practical refactor scope; depth 5+ is available
// for explicit transitive analysis.
function impactSet({ db, repoPath, symbol, depth = 3, scope = 'loose' }) {
  const g = callGraph({ db, repoPath, symbol, direction: 'callers', depth, scope });
  const symbols = g.nodes.map((n) => n.name).filter((n) => n !== symbol);
  if (symbols.length === 0) {
    return { symbols: [], files: [], truncated: g.truncated };
  }

  const placeholders = symbols.map(() => '?').join(',');
  const fileRows = db.prepare(
    `SELECT DISTINCT file_path FROM cg_symbols
     WHERE repo_path = ? AND name IN (${placeholders})`
  ).all(repoPath, ...symbols);

  return {
    symbols,
    files: fileRows.map((r) => r.file_path),
    truncated: g.truncated,
    max_nodes: g.max_nodes,
  };
}

module.exports = { impactSet };
