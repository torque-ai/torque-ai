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

// Fallback 1: same-name symbols. In TORQUE plugins (and most JS conventions),
// the runtime dispatch handlers[toolDef.name] resolves to a method whose
// name equals the tool name.
const SYMBOL_COLS = `
  name        AS name,
  kind        AS kind,
  file_path   AS file,
  start_line  AS line,
  start_col   AS column,
  is_async    AS isAsync,
  is_generator AS isGenerator,
  is_static   AS isStatic
`;

const SYMBOL_FALLBACK_SQL = `
  SELECT ${SYMBOL_COLS}
  FROM cg_symbols
  WHERE repo_path = @repoPath AND name = @toolName
  ORDER BY file_path, start_line
  LIMIT 10
`;

// Fallback 2: convention-based name guessing. Many TORQUE handlers use
// handle<PascalCase(toolName)> naming — e.g. smart_submit_task →
// handleSmartSubmitTask. Generate likely candidates and look them up.
function guessHandlerNames(toolName) {
  const pascal = toolName
    .split(/[_\-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  if (!pascal) return [];
  return [
    `handle${pascal}`,
    `do${pascal}`,
    `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}Handler`,
  ];
}

const CONVENTION_FALLBACK_SQL = `
  SELECT ${SYMBOL_COLS}
  FROM cg_symbols
  WHERE repo_path = @repoPath AND name IN (SELECT value FROM json_each(@names))
  ORDER BY file_path, start_line
  LIMIT 10
`;

// Promote sparse modifier flags to the surface object: only emit when truthy
// to keep payloads tight for the common (modifier-free) case.
function decorateSymbolRow(row) {
  const { isAsync, isGenerator, isStatic, ...rest } = row;
  if (isAsync)     rest.is_async = true;
  if (isGenerator) rest.is_generator = true;
  if (isStatic)    rest.is_static = true;
  return rest;
}

function resolveTool({ db, repoPath, toolName }) {
  const handlers = db.prepare(DISPATCH_SQL).all({ repoPath, toolName });
  if (handlers.length > 0) return { handlers, candidates: [], convention_candidates: [] };

  // Fallback 1: same-name symbols.
  const candidates = db.prepare(SYMBOL_FALLBACK_SQL).all({ repoPath, toolName }).map(decorateSymbolRow);
  if (candidates.length > 0) return { handlers: [], candidates, convention_candidates: [] };

  // Fallback 2: convention-guessed names.
  const guesses = guessHandlerNames(toolName);
  let convention_candidates = [];
  if (guesses.length > 0) {
    convention_candidates = db.prepare(CONVENTION_FALLBACK_SQL).all({
      repoPath,
      names: JSON.stringify(guesses),
    }).map(decorateSymbolRow);
  }
  return { handlers: [], candidates: [], convention_candidates };
}

module.exports = { resolveTool, guessHandlerNames };
