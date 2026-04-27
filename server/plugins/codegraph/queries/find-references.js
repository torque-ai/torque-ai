'use strict';

const SQL = `
  SELECT
    r.file_path  AS file,
    r.line       AS line,
    r.col        AS column,
    s.name       AS callerSymbol
  FROM cg_references r
  LEFT JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND r.target_name = @symbol
  ORDER BY r.file_path, r.line
`;

function findReferences({ db, repoPath, symbol }) {
  return db.prepare(SQL).all({ repoPath, symbol });
}

module.exports = { findReferences };
