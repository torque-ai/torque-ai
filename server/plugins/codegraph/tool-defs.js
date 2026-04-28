'use strict';

// Tool descriptions are written for LLM consumers. They state what the tool
// does, what its limitations are (especially identifier-only resolution which
// breaks on dynamic dispatch), and how to interpret the staleness field that
// every query response carries.

const STALENESS_NOTE = ' Every response includes a `staleness` object with `stale: bool` and `current_sha`/`indexed_sha`; if `stale` is true, results reflect a previous commit — call cg_reindex with force=true to refresh, or treat the data as historical.';

const RESOLUTION_NOTE = ' Resolution is identifier-only: a call to `foo()` matches any defined symbol named `foo` in the repo, regardless of imports or scope. This means dynamic dispatch — string-keyed handler lookup like `handlers[name](args)`, plugin contract methods called by a loader via `plugin.install()`, dependency-injection containers, framework lifecycle hooks — appears in the graph the same as a static call, and may be missing entirely from caller→callee edges. Treat results as candidate impact requiring human verification, not proof.';

const tools = [
  {
    name: 'cg_index_status',
    description: 'Read the current code graph index state for a repo. Returns whether it is indexed, the indexed commit SHA, indexed_at timestamp, file/symbol/reference counts, and a staleness object comparing the indexed SHA to current git HEAD. Cheap (single SQLite read + one git rev-parse). Call this before relying on query results to confirm the graph is fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string', description: 'Absolute path to the repository root (the directory containing `.git`).' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_reindex',
    description: 'Build (or rebuild) the code graph index for a repo by parsing every JS/TS/TSX file at git HEAD. Idempotent: returns {skipped: true} if the index already matches the current HEAD SHA, unless force=true. Reads from HEAD only — uncommitted changes in the working tree are ignored. By default runs in a worker thread (returns immediately with a jobId; poll cg_index_status to detect completion). Pass async=false to block until indexing finishes (use only for small repos — TORQUE itself takes a few seconds). Pass if_tracked=true to skip with `{skipped:"not_tracked"}` when the repo is not already in cg_index_state — used by the post-commit auto-reindex hook to keep existing indexes fresh without bootstrapping new ones.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path:  { type: 'string' },
        force:      { type: 'boolean', default: false, description: 'Re-index even if the indexed SHA matches current HEAD.' },
        async:      { type: 'boolean', default: true,  description: 'Run in worker thread (returns jobId immediately). Set false for blocking sync indexing.' },
        if_tracked: { type: 'boolean', default: false, description: 'Skip with {skipped:"not_tracked"} unless repo_path already has a cg_index_state row. Lets fire-and-forget callers (post-commit hook) refresh existing indexes without bootstrapping new ones.' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_find_references',
    description: 'Find every call site of a named symbol in the indexed repo. Returns `{references: [{file, line, column, callerSymbol}], scope, staleness}`. callerSymbol is the function/method enclosing the call site, or null for file-scope calls. The `scope` parameter trades recall for precision: "loose" (default) matches by identifier — high recall, false-positive-prone for common names. "strict" only returns references the indexer pinned to a specific exported symbol via import-binding analysis — high precision, drops cross-package and dynamically-dispatched calls.' + RESOLUTION_NOTE + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string', description: 'Bare identifier name (no namespacing, no parens). For methods like `foo.bar()` this matches any symbol named `bar`.' },
        scope:     { type: 'string', enum: ['loose', 'strict'], default: 'loose', description: 'loose = identifier-only match (high recall); strict = only resolved-via-import or import-typed-receiver references (high precision).' },
        container: { type: 'string', description: 'When scope=strict, also filter by the resolved symbol\'s container_name. Disambiguates methods that share a name across multiple classes (e.g. Animal.speak vs Other.speak). Ignored when scope=loose.' },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_call_graph',
    description: 'Walk the call graph from a symbol. direction=callees follows what the symbol calls; direction=callers follows what calls it; direction=both unions both. Returns `{nodes: [{name}], edges: [{from, to}], truncated, max_nodes, scope, staleness}`. Bounded by depth (max 8) and a 100-node cap. When truncated=true the response includes truncation_hint suggesting how to narrow. The `scope` parameter has the same loose/strict meaning as cg_find_references.' + RESOLUTION_NOTE + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
        direction: { type: 'string', enum: ['callers', 'callees', 'both'], default: 'callees' },
        depth:     { type: 'integer', minimum: 1, maximum: 8, default: 2 },
        scope:     { type: 'string', enum: ['loose', 'strict'], default: 'loose' },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_impact_set',
    description: 'Compute the impact set of changing a symbol: every transitively-affected (caller-side) symbol and the files containing them. Returns `{symbols: [name], files: [path], truncated, depth_used, scope, staleness}`. Use before refactoring to scope the work. The queried symbol is excluded from `symbols`. Default depth=3 covers the practical refactor scope (direct callers + 2 hops). Bump to 5+ only when you explicitly want transitive blast radius — foundational functions hit the 100-node cap fast. `scope` parameter same as cg_find_references; pass scope=strict to filter out same-name unrelated symbols.' + RESOLUTION_NOTE + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
        depth:     { type: 'integer', minimum: 1, maximum: 8, default: 3, description: 'BFS depth over the caller graph. depth=1 is direct callers only; depth=3 covers local refactor scope (default); depth=5+ is transitive blast radius.' },
        scope:     { type: 'string', enum: ['loose', 'strict'], default: 'loose' },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_dead_symbols',
    description: 'List symbols defined in the repo but never referenced anywhere else in the indexed code. Returns `{dead_symbols: [{name, kind, file, line}], filter, staleness, caveat}`. By default, applies two filters to reduce noise: (1) excludes symbols flagged is_exported (they have external consumers we can\'t see), (2) excludes names matching a known-dynamic-dispatch heuristic (`cg_*`/`vc_*`/`peek_*`/`handle*`, plugin contract methods like install/uninstall/mcpTools, lifecycle hooks like init/main, capitalized React components). Pass include_exported=true to surface exported symbols, include_likely_dispatched=true to surface heuristic-filtered names. The default-filtered list is the high-signal "real dead code" candidate set; the permissive output requires careful human review.' + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        include_exported: { type: 'boolean', default: false, description: 'Include symbols flagged is_exported (likely consumed externally).' },
        include_likely_dispatched: { type: 'boolean', default: false, description: 'Include names matching the dynamic-dispatch heuristic patterns (handlers, plugin methods, etc.).' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_class_hierarchy',
    description: 'Walk the class/interface inheritance graph from a symbol. direction=descendants finds subclasses (who extends/implements this?); direction=ancestors finds superclasses/interfaces (what does this extend/implement?). Returns `{symbol, direction, nodes: [{name, kind?}], edges: [{from, to, kind}], truncated, max_nodes, depth_used, staleness}`. Edge kind is "extends" (class:class or interface:interface) or "implements" (class:interface). Bounded by depth (max 8) and a 100-node cap. Use before refactoring a base class to scope which subclasses depend on its surface — the most common "I want to change X but who would break?" question for OO code.' + RESOLUTION_NOTE + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string', description: 'Class or interface name (bare identifier).' },
        direction: { type: 'string', enum: ['descendants', 'ancestors'], default: 'descendants', description: 'descendants: who extends/implements this? ancestors: what does this extend/implement?' },
        depth:     { type: 'integer', minimum: 1, maximum: 8, default: 3 },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_resolve_tool',
    description: 'Map an MCP tool name (e.g. `smart_submit_task`) to its handler function symbol(s) (e.g. `handleSmartSubmitTask`) by walking dispatcher case statements indexed at parse time. Returns `{tool_name, handlers: [{toolName, handlerName, file, line, column}], staleness}`. Use this when cg_find_references / cg_call_graph return empty for a name that\'s actually a tool name — the graph indexes only function declarations and call expressions, not the string-keyed dispatch in `switch (name) { case "X": return handleX() }`. Once you have the handler symbol, query it directly with cg_call_graph or cg_find_references.' + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        tool_name: { type: 'string', description: 'MCP tool name as it appears in a switch/case dispatcher (e.g. "smart_submit_task", "cg_reindex").' },
      },
      required: ['repo_path', 'tool_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_telemetry',
    description: 'Aggregate the shadow-mode usage telemetry for cg_* tools over a recent time window. Every cg_* call records one row in cg_tool_usage at handler time (best-effort, errors swallowed). Returns `{since_hours, tools: [{tool, calls, avg_duration_ms, max_duration_ms, avg_result_count, strict_pct, truncation_pct, staleness_pct, error_pct, last_call_at}], total_calls}`. Use to answer: is the planner integration paying off? Are loose vs strict scope ratios drifting? Are queries hitting truncation caps too often? Are consumers seeing stale results?',
    inputSchema: {
      type: 'object',
      properties: {
        since_hours: { type: 'integer', minimum: 1, maximum: 8760, default: 24, description: 'Look-back window in hours (default 24, max 8760 = 1 year).' },
        tool:        { type: 'string', description: 'Optional filter — return aggregate only for this cg_* tool name.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cg_diff',
    description: 'Compute the symbol-level delta between two git commits in a repo. Re-extracts symbols from each changed file at both shas (added files: extract at to_sha; deleted: extract at from_sha; modified: extract both and set-diff). Returns `{from_sha, to_sha, added_symbols: [{name, kind, file, line, container?}], removed_symbols: [...], changed_files: {added, modified, deleted}, skipped_files, truncated, max_files, total_files_changed}`. Symbol identity is (name, kind, container, file) — line numbers don\'t affect identity, so a function moved within a file won\'t appear as add+remove. Bounded to changed files only (fast for typical commits) and capped at max_files (default 500); over the cap returns truncated:true with no symbol diff. Reads from git object store directly — does NOT depend on cg_index_state, so it works on any reachable shas without reindexing.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        from_sha:  { type: 'string', description: 'Git sha to diff from (older).' },
        to_sha:    { type: 'string', description: 'Git sha to diff to (newer). Both shas must be reachable in the repo.' },
        max_files: { type: 'integer', minimum: 1, maximum: 5000, default: 500, description: 'Cap on number of indexable files in the diff scope. Over the cap, returns truncated:true with no symbol diff.' },
      },
      required: ['repo_path', 'from_sha', 'to_sha'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_search',
    description: 'Find symbols by name pattern in the indexed repo. Pattern uses SQLite GLOB syntax: `*` matches any chars, `?` matches one char, `[abc]` matches a class. Returns `{pattern, results: [{name, kind, file, line, column, container?, is_exported?, is_async?, is_generator?, is_static?}], truncated, limit, staleness}`. Filter by `kind` (function/class/method/constructor/getter/setter/interface/struct/enum), `container` (only return symbols inside this class/interface), or `is_exported`. Replaces grep-then-cg_find_references for many planner workflows — answer "what symbols match X" without touching source files. Defaults to limit=200 (max 1000); over the limit returns truncated:true. Examples: pattern="create*" finds all create* symbols; pattern="*Handler" finds all *Handler classes; pattern="cg_*"+kind="function" lists cg_* tool functions.' + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        pattern:   { type: 'string', description: 'Symbol name pattern. SQLite GLOB syntax: * = any chars, ? = one char, [abc] = char class. Use the literal name for an exact match.' },
        kind:      { type: 'string', description: 'Filter by symbol kind. Common values: function, class, method, constructor, getter, setter, interface, struct, enum.' },
        container: { type: 'string', description: 'Filter to symbols whose container_name equals this (e.g. "Animal" for methods on class Animal). Useful with kind="method".' },
        is_exported: { type: 'boolean', description: 'Filter to only exported (true) or only non-exported (false) symbols. Omit for both.' },
        limit:     { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Cap on result count. Over the cap, returns truncated:true.' },
      },
      required: ['repo_path', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_resolution_diagnostics',
    description: 'Explain why cg_find_references with scope="strict" returns fewer results than scope="loose" for a symbol. Walks every reference whose target_name matches the symbol that did NOT get a resolved_symbol_id during indexer pass 2, and classifies each by why binding analysis missed it. Returns `{symbol, loose_count, strict_count, unresolved_count, reasons: {<reason>: count}, unresolved_samples: [{file, line, column, callerSymbol, callerKind, receiver?, reason}], sample_size, truncated_samples, staleness}`. Reason buckets: `no_import_for_target` (no cg_imports row matches the bare identifier in the calling file), `import_to_unindexed_local_file` (relative import points at a file that exists but didn\'t produce a same-named symbol), `import_from_external_module` (import resolves to a third-party package not in cg_symbols), `method_no_local_binding` (method call but no cg_locals row records the receiver\'s type), `method_local_binding_to_unknown_type` (receiver type known but no method of this name on it), `this_enclosing_class_lacks_method` (`this.X()` but enclosing class has no `X`), `method_resolution_edge_case` (binding looks fine — likely indexer bug). Use to triage why a refactor query under-counts.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path:   { type: 'string' },
        symbol:      { type: 'string', description: 'Bare identifier name; same shape as cg_find_references.symbol.' },
        sample_size: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'Cap on unresolved-sample count returned. Reason counts always reflect the full unresolved set.' },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
];

module.exports = tools;
