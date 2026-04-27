'use strict';

// Primary path: dispatcher edges captured at parse time from switch/case,
// Map.set() registrations, object-literal {name, handler} entries, and
// `createXxxHandlers` factory return objects (where method-name == tool-name).
const DISPATCH_SQL = `
  SELECT
    case_string  AS toolName,
    handler_name AS handlerName,
    file_path    AS file,
    line,
    col          AS column
  FROM cg_dispatch_edges
  WHERE repo_path = @repoPath AND case_string = @toolName
  ORDER BY file_path, line
`;

// Fallback: when no dispatcher matched, look up symbols whose name matches
// the tool name. In TORQUE plugins (and most JS conventions), the runtime
// dispatch `handlers[toolDef.name]` resolves to a method whose name equals
// the tool name. The `cg_dispatch_edges` capture for createXxxHandlers
// factories should usually have already returned an answer, but this
// fallback covers cases where the factory isn't recognized — exported
// handler maps, alternate naming conventions, or method definitions inside
// classes.
const SYMBOL_FALLBACK_SQL = `
  SELECT
    name      AS name,
    kind      AS kind,
    file_path AS file,
    start_line AS line,
    start_col  AS column
  FROM cg_symbols
  WHERE repo_path = @repoPath AND name = @toolName
  ORDER BY file_path, start_line
  LIMIT 10
`;

function resolveTool({ db, repoPath, toolName }) {
  const handlers = db.prepare(DISPATCH_SQL).all({ repoPath, toolName });
  if (handlers.length > 0) return { handlers, candidates: [] };

  // No explicit dispatcher — return same-name symbols as candidates.
  const candidates = db.prepare(SYMBOL_FALLBACK_SQL).all({ repoPath, toolName });
  return { handlers: [], candidates };
}

module.exports = { resolveTool };
