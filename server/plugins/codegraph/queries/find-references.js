'use strict';

// LEFT JOIN cg_symbols (the caller_symbol_id row in cg_references) lets us
// project the caller's kind + modifier flags alongside the call site. LLMs
// planning a refactor can then reason "this function is called from 5 places:
// 3 in async functions, 1 in a generator, 1 at file scope" without having to
// fetch each caller separately.
const SQL = `
  SELECT
    r.file_path     AS file,
    r.line          AS line,
    r.col           AS column,
    s.name          AS callerSymbol,
    s.kind          AS callerKind,
    s.is_async      AS callerIsAsync,
    s.is_generator  AS callerIsGenerator,
    s.is_static     AS callerIsStatic
  FROM cg_references r
  LEFT JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND r.target_name = @symbol
  ORDER BY r.file_path, r.line
`;

// Sparse modifier surface: only emit boolean flags when truthy. Keeps payloads
// compact for the common case (caller is a plain sync function).
function decorate(row) {
  const { callerIsAsync, callerIsGenerator, callerIsStatic, ...rest } = row;
  if (callerIsAsync)     rest.callerIsAsync = true;
  if (callerIsGenerator) rest.callerIsGenerator = true;
  if (callerIsStatic)    rest.callerIsStatic = true;
  return rest;
}

function findReferences({ db, repoPath, symbol }) {
  return db.prepare(SQL).all({ repoPath, symbol }).map(decorate);
}

module.exports = { findReferences };
