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
];

module.exports = tools;
