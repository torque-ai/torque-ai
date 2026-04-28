'use strict';

// Search cg_symbols by name pattern. Pattern uses SQLite GLOB syntax —
// `*` matches any chars, `?` matches one char, `[abc]` matches a class.
// Common usage from LLM consumers:
//   pattern='create*'         → all symbols starting with create
//   pattern='*Handler'        → all symbols ending with Handler
//   pattern='cg_*'            → all cg_* tool handlers
//   pattern='handle?Create*'  → handleCreateX (one char between e and Create)
function search({ db, repoPath, pattern, kind = null, container = null, isExported = null, limit = 200 }) {
  const params = { repo_path: repoPath, pattern, limit };
  const filters = ['repo_path = @repo_path', 'name GLOB @pattern'];
  if (kind != null) {
    filters.push('kind = @kind');
    params.kind = kind;
  }
  if (container != null) {
    filters.push('container_name = @container');
    params.container = container;
  }
  if (isExported === true) {
    filters.push('is_exported = 1');
  } else if (isExported === false) {
    filters.push('is_exported = 0');
  }

  // limit+1 sentinel lets us detect truncation without a separate COUNT(*).
  const rows = db.prepare(`
    SELECT name, kind, file_path, start_line, start_col, container_name,
           is_exported, is_async, is_generator, is_static
    FROM cg_symbols
    WHERE ${filters.join(' AND ')}
    ORDER BY name COLLATE NOCASE, file_path, start_line
    LIMIT @limit
  `).all({ ...params, limit: limit + 1 });

  const truncated = rows.length > limit;
  const results = (truncated ? rows.slice(0, limit) : rows).map((r) => ({
    name: r.name,
    kind: r.kind,
    file: r.file_path,
    line: r.start_line,
    column: r.start_col,
    ...(r.container_name ? { container: r.container_name } : {}),
    ...(r.is_exported   ? { is_exported:   true } : {}),
    ...(r.is_async      ? { is_async:      true } : {}),
    ...(r.is_generator  ? { is_generator:  true } : {}),
    ...(r.is_static     ? { is_static:     true } : {}),
  }));

  return { results, truncated, limit };
}

module.exports = { search };
