'use strict';

const { callGraph } = require('./call-graph');

function impactSet({ db, repoPath, symbol, depth = 5 }) {
  const g = callGraph({ db, repoPath, symbol, direction: 'callers', depth });
  const symbols = g.nodes.map((n) => n.name).filter((n) => n !== symbol);
  if (symbols.length === 0) return { symbols: [], files: [] };

  const placeholders = symbols.map(() => '?').join(',');
  const fileRows = db.prepare(
    `SELECT DISTINCT file_path FROM cg_symbols
     WHERE repo_path = ? AND name IN (${placeholders})`
  ).all(repoPath, ...symbols);

  return {
    symbols,
    files: fileRows.map((r) => r.file_path),
  };
}

module.exports = { impactSet };
