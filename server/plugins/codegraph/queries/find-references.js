'use strict';

// LEFT JOIN cg_symbols (the caller_symbol_id row in cg_references) lets us
// project the caller's kind + modifier flags alongside the call site. LLMs
// planning a refactor can then reason "this function is called from 5 places:
// 3 in async functions, 1 in a generator, 1 at file scope" without having to
// fetch each caller separately.
//
// scope='loose' (default): identifier-only matching; returns every reference
//   whose target_name == symbol. False-positive-prone for common names but
//   back-compat with callers that pre-date scoped resolution.
// scope='strict': only returns references whose resolved_symbol_id (set by
//   indexer pass 2 from import/binding analysis) points at a symbol in the
//   repo with the requested name. Drops unresolved references entirely.
const LOOSE_SQL = `
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

// Strict resolution: an inner JOIN against cg_symbols on resolved_symbol_id
// guarantees we only surface references the indexer has confirmed point at
// the named symbol. The outer LEFT JOIN against caller still decorates with
// caller-context modifiers.
const STRICT_SQL = `
  SELECT
    r.file_path     AS file,
    r.line          AS line,
    r.col           AS column,
    cs.name         AS callerSymbol,
    cs.kind         AS callerKind,
    cs.is_async     AS callerIsAsync,
    cs.is_generator AS callerIsGenerator,
    cs.is_static    AS callerIsStatic
  FROM cg_references r
  JOIN cg_symbols rs ON rs.id = r.resolved_symbol_id
  LEFT JOIN cg_symbols cs ON cs.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND rs.name = @symbol
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

function findReferences({ db, repoPath, symbol, scope = 'loose' }) {
  const sql = scope === 'strict' ? STRICT_SQL : LOOSE_SQL;
  return db.prepare(sql).all({ repoPath, symbol }).map(decorate);
}

module.exports = { findReferences };
