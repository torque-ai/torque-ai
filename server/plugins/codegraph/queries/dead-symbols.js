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

const DEFAULT_SQL = `
  SELECT s.name, s.kind, s.file_path AS file, s.start_line AS line, s.is_exported AS isExported
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
  SELECT s.name, s.kind, s.file_path AS file, s.start_line AS line, s.is_exported AS isExported
  FROM cg_symbols s
  WHERE s.repo_path = @repoPath
    AND NOT EXISTS (
      SELECT 1 FROM cg_references r
      WHERE r.repo_path = s.repo_path AND r.target_name = s.name
    )
  ORDER BY s.file_path, s.start_line
`;

function deadSymbols({ db, repoPath, includeExported = false, includeLikelyDispatched = false }) {
  const sql = includeExported ? PERMISSIVE_SQL : DEFAULT_SQL;
  let result = db.prepare(sql).all({ repoPath });
  if (!includeLikelyDispatched) {
    result = result.filter((s) => !looksLikeDispatched(s.name));
  }
  // Strip is_exported from the surface output unless caller asked for it.
  return result.map(({ isExported, ...rest }) => includeExported ? { ...rest, is_exported: !!isExported } : rest);
}

module.exports = { deadSymbols, looksLikeDispatched, DISPATCH_LIKELY_PATTERNS };
