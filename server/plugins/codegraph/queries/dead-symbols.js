'use strict';

// Names matching these patterns are excluded from the "dead" list because
// they are nearly always dispatched dynamically (string-keyed handler
// lookup, plugin contracts, framework lifecycle hooks). Including them
// produces false positives that drown out the real dead-code candidates.
//
// Note: this is a HEURISTIC. A symbol matching a pattern here might still
// be genuinely dead. Use `include_likely_dispatched: true` to override.
const DISPATCH_LIKELY_PATTERNS = [
  // MCP tool prefixes used by TORQUE plugins
  /^cg_/, /^vc_/, /^peek_/,
  // Express/HTTP route handlers and tool dispatchers
  /^handle[A-Z]/,
  // Plugin contract methods called by the plugin loader
  /^(?:install|uninstall|mcpTools|middleware|eventHandlers|configSchema|diagnostics|tierTools|classifierRules|recoveryStrategies)$/,
  // Class lifecycle / framework hooks commonly dispatched by name
  /^(?:default|main|init|setup|teardown|before|after|on[A-Z]|component[A-Z])/,
  // React component / class names — exported for JSX consumption
  /^[A-Z][a-z]/,
];

function looksLikeDispatched(name) {
  return DISPATCH_LIKELY_PATTERNS.some((re) => re.test(name));
}

const SELECT_COLS = `
  s.name, s.kind, s.file_path AS file, s.start_line AS line,
  s.is_exported AS isExported, s.is_async AS isAsync,
  s.is_generator AS isGenerator, s.is_static AS isStatic
`;

const DEFAULT_SQL = `
  SELECT ${SELECT_COLS}
  FROM cg_symbols s
  WHERE s.repo_path = @repoPath
    AND s.is_exported = 0
    AND NOT EXISTS (
      SELECT 1 FROM cg_references r
      WHERE r.repo_path = s.repo_path AND r.target_name = s.name
    )
    AND NOT EXISTS (
      SELECT 1 FROM cg_dispatch_edges d
      WHERE d.repo_path = s.repo_path AND d.handler_name = s.name
    )
  ORDER BY s.file_path, s.start_line
`;

const PERMISSIVE_SQL = `
  SELECT ${SELECT_COLS}
  FROM cg_symbols s
  WHERE s.repo_path = @repoPath
    AND NOT EXISTS (
      SELECT 1 FROM cg_references r
      WHERE r.repo_path = s.repo_path AND r.target_name = s.name
    )
  ORDER BY s.file_path, s.start_line
`;

// Decorate raw query rows with boolean modifiers and (optionally) is_exported.
// Modifier flags are only emitted when truthy to keep response payloads tight
// for the common case (functions with no special modifiers).
function decorate(rows, { includeExported }) {
  return rows.map(({ isExported, isAsync, isGenerator, isStatic, ...rest }) => {
    const out = { ...rest };
    if (includeExported) out.is_exported = !!isExported;
    if (isAsync)     out.is_async = true;
    if (isGenerator) out.is_generator = true;
    if (isStatic)    out.is_static = true;
    return out;
  });
}

function deadSymbols({ db, repoPath, includeExported = false, includeLikelyDispatched = false }) {
  const sql = includeExported ? PERMISSIVE_SQL : DEFAULT_SQL;
  let rows = db.prepare(sql).all({ repoPath });
  if (!includeLikelyDispatched) {
    rows = rows.filter((s) => !looksLikeDispatched(s.name));
  }
  return decorate(rows, { includeExported });
}

module.exports = { deadSymbols, looksLikeDispatched, DISPATCH_LIKELY_PATTERNS };
