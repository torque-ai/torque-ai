'use strict';

// Diagnose why strict scope returns fewer results than loose for a symbol.
// Walks every reference whose target_name == symbol that DIDN'T resolve
// (resolved_symbol_id IS NULL) and classifies each by why the indexer's
// pass-2 binding analysis didn't find a target.

const UNRESOLVED_REFS_SQL = `
  SELECT
    r.id,
    r.file_path     AS file,
    r.line          AS line,
    r.col           AS col,
    r.target_name   AS targetName,
    r.receiver_name AS receiverName,
    r.caller_symbol_id AS callerSymbolId,
    cs.name         AS callerSymbol,
    cs.kind         AS callerKind
  FROM cg_references r
  LEFT JOIN cg_symbols cs ON cs.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath
    AND r.target_name = @symbol
    AND r.resolved_symbol_id IS NULL
  ORDER BY r.file_path, r.line
`;

const RESOLVED_COUNT_SQL = `
  SELECT COUNT(*) AS n
  FROM cg_references r
  JOIN cg_symbols rs ON rs.id = r.resolved_symbol_id
  WHERE r.repo_path = @repoPath AND rs.name = @symbol
`;

const LOOSE_COUNT_SQL = `
  SELECT COUNT(*) AS n
  FROM cg_references r
  WHERE r.repo_path = @repoPath AND r.target_name = @symbol
`;

// Pass-2 import resolution looks up cg_imports by (repo_path, file_path,
// local_name). If a row exists with local_name=target, the call site has
// an import binding — but pass 2 may still drop it (e.g. the import points
// at a third-party module not in cg_symbols). If no row exists at all,
// no_import_for_target.
function findImportForRef(db, repoPath, file, targetName) {
  return db.prepare(`
    SELECT source_module, source_name
    FROM cg_imports
    WHERE repo_path = ? AND file_path = ? AND local_name = ?
    LIMIT 1
  `).get(repoPath, file, targetName);
}

// Pass-2 method resolution looks up cg_locals by (repo_path, file_path,
// scope_symbol_id, local_name) for the receiver. If a binding exists, it
// then looks up cg_symbols by (repo_path, container_name=type_name,
// name=method). Both paths can fail.
function findLocalForReceiver(db, repoPath, file, scopeSymbolId, receiverName) {
  // Function-scope binding first; fall back to file-scope (scope_symbol_id IS NULL).
  let row = null;
  if (scopeSymbolId != null) {
    row = db.prepare(`
      SELECT type_name FROM cg_locals
      WHERE repo_path = ? AND file_path = ? AND scope_symbol_id = ? AND local_name = ?
      LIMIT 1
    `).get(repoPath, file, scopeSymbolId, receiverName);
  }
  if (!row) {
    row = db.prepare(`
      SELECT type_name FROM cg_locals
      WHERE repo_path = ? AND file_path = ? AND scope_symbol_id IS NULL AND local_name = ?
      LIMIT 1
    `).get(repoPath, file, receiverName);
  }
  return row;
}

// Does any cg_symbols row in the repo claim this method on this type?
function hasMethodOnType(db, repoPath, typeName, methodName) {
  const row = db.prepare(`
    SELECT 1 FROM cg_symbols
    WHERE repo_path = ? AND container_name = ? AND name = ?
    LIMIT 1
  `).get(repoPath, typeName, methodName);
  return Boolean(row);
}

function classifyUnresolvedRef(db, repoPath, ref) {
  // Method call: receiver_name set on the reference.
  if (ref.receiverName) {
    if (ref.receiverName === 'this') {
      // `this.foo()` — pass 2 resolves via the enclosing class, not cg_locals.
      // If unresolved, the enclosing class either doesn't exist as a symbol or
      // doesn't have this method.
      return 'this_enclosing_class_lacks_method';
    }
    const local = findLocalForReceiver(db, repoPath, ref.file, ref.callerSymbolId, ref.receiverName);
    if (!local) return 'method_no_local_binding';
    if (!hasMethodOnType(db, repoPath, local.type_name, ref.targetName)) {
      return 'method_local_binding_to_unknown_type';
    }
    // Local + type both look fine — pass 2 should have resolved this. Edge case.
    return 'method_resolution_edge_case';
  }

  // Function call: pass 2 looks for target_name in cg_imports for the file.
  const imp = findImportForRef(db, repoPath, ref.file, ref.targetName);
  if (!imp) return 'no_import_for_target';

  // Import found but pass 2 didn't pin a resolved_symbol_id. Most common
  // cause: the source_module is third-party (not indexed in cg_symbols).
  // Distinguishing relative vs bare module is a useful signal.
  const isRelative = imp.source_module.startsWith('.') || imp.source_module.startsWith('/');
  return isRelative ? 'import_to_unindexed_local_file' : 'import_from_external_module';
}

function diagnose({ db, repoPath, symbol, sampleSize = 20 }) {
  const looseCount  = db.prepare(LOOSE_COUNT_SQL).get({ repoPath, symbol })?.n || 0;
  const strictCount = db.prepare(RESOLVED_COUNT_SQL).get({ repoPath, symbol })?.n || 0;
  const unresolvedRefs = db.prepare(UNRESOLVED_REFS_SQL).all({ repoPath, symbol });

  const reasons = {};
  const samples = [];
  for (const ref of unresolvedRefs) {
    const reason = classifyUnresolvedRef(db, repoPath, ref);
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (samples.length < sampleSize) {
      samples.push({
        file: ref.file,
        line: ref.line,
        column: ref.col,
        callerSymbol: ref.callerSymbol,
        callerKind: ref.callerKind,
        ...(ref.receiverName ? { receiver: ref.receiverName } : {}),
        reason,
      });
    }
  }

  return {
    symbol,
    loose_count: looseCount,
    strict_count: strictCount,
    unresolved_count: unresolvedRefs.length,
    reasons,
    unresolved_samples: samples,
    sample_size: sampleSize,
    truncated_samples: unresolvedRefs.length > sampleSize,
  };
}

module.exports = { diagnose };
