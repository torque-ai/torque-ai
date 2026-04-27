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
    description: 'Build (or rebuild) the code graph index for a repo by parsing every JS/TS/TSX file at git HEAD. Idempotent: returns {skipped: true} if the index already matches the current HEAD SHA, unless force=true. Reads from HEAD only — uncommitted changes in the working tree are ignored. By default runs in a worker thread (returns immediately with a jobId; poll cg_index_status to detect completion). Pass async=false to block until indexing finishes (use only for small repos — TORQUE itself takes a few seconds).',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        force:     { type: 'boolean', default: false, description: 'Re-index even if the indexed SHA matches current HEAD.' },
        async:     { type: 'boolean', default: true,  description: 'Run in worker thread (returns jobId immediately). Set false for blocking sync indexing.' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_find_references',
    description: 'Find every call site of a named symbol in the indexed repo. Returns `{references: [{file, line, column, callerSymbol}], staleness}` — callerSymbol is the function/method enclosing the call site, or null for file-scope calls.' + RESOLUTION_NOTE + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string', description: 'Bare identifier name (no namespacing, no parens). For methods like `foo.bar()` this matches any symbol named `bar`.' },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_call_graph',
    description: 'Walk the call graph from a symbol. direction=callees follows what the symbol calls; direction=callers follows what calls it; direction=both unions both. Returns `{nodes: [{name}], edges: [{from, to}], staleness}`. Bounded by depth (max 8) and a hard cap of 100 nodes to keep responses LLM-context-friendly. Use for understanding "what does this function depend on" (callees) or "what relies on this function" (callers).' + RESOLUTION_NOTE + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
        direction: { type: 'string', enum: ['callers', 'callees', 'both'], default: 'callees' },
        depth:     { type: 'integer', minimum: 1, maximum: 8, default: 2 },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_impact_set',
    description: 'Compute the impact set of changing a symbol: every transitively-affected (caller-side) symbol and the files containing them. Returns `{symbols: [name], files: [path], staleness}`. Use before refactoring to scope the work and identify all files that need updates. The queried symbol is excluded from `symbols` (you already know that one is changing).' + RESOLUTION_NOTE + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
        depth:     { type: 'integer', minimum: 1, maximum: 8, default: 5, description: 'BFS depth over the caller graph. Default 5 covers most real refactors.' },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_dead_symbols',
    description: 'List symbols defined in the repo but never referenced anywhere else in the indexed code. Returns `{dead_symbols: [{name, kind, file, line}], staleness, caveat}`. ⚠ The `caveat` field in every response explicitly warns that MVP-grade identifier-only resolution produces false positives for dynamic dispatch, plugin contract methods, exported APIs, and framework lifecycle hooks. Read the caveat. Use this for dead-code investigation, never for unattended deletion.' + STALENESS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
];

module.exports = tools;
