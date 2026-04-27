# Codegraph

`codegraph` is a TORQUE plugin that maintains a per-repository symbol/reference index, exposing call graph and find-references queries via REST and MCP.

## Status

- **Languages:** JavaScript, TypeScript, TSX, Python, Go, C#, PowerShell (parsed via native `tree-sitter@0.25` + per-language grammars: `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `tree-sitter-c-sharp`, `tree-sitter-powershell`)
- **Storage:** SQLite tables prefixed `cg_*` in a dedicated `<DATA_DIR>/codegraph.db` file (separate from the main TORQUE db so reindex transactions don't lock task scheduling)
- **Off by default.** Set `TORQUE_CODEGRAPH_ENABLED=1` and restart to enable.

## REST endpoints

| Method | Path | Body / Query |
|--------|------|--------------|
| `GET`  | `/api/v2/codegraph/index-status?repo_path=...` | — |
| `POST` | `/api/v2/codegraph/reindex` | `{ repo_path, force?, async? }` |
| `POST` | `/api/v2/codegraph/find-references` | `{ repo_path, symbol }` |
| `POST` | `/api/v2/codegraph/call-graph` | `{ repo_path, symbol, direction?, depth? }` |
| `POST` | `/api/v2/codegraph/impact-set` | `{ repo_path, symbol, depth? }` |
| `GET`  | `/api/v2/codegraph/dead-symbols?repo_path=...` | — |
| `POST` | `/api/v2/codegraph/resolve-tool` | `{ repo_path, tool_name }` |
| `POST` | `/api/v2/codegraph/class-hierarchy` | `{ repo_path, symbol, direction?, depth? }` |

Every endpoint has a 1:1 MCP tool with the same name (`cg_index_status`, `cg_reindex`, `cg_find_references`, `cg_call_graph`, `cg_impact_set`, `cg_dead_symbols`, `cg_resolve_tool`, `cg_class_hierarchy`). REST is the source of truth — MCP tools are thin shims dispatching through `handleToolCall()` to the same handlers.

## Indexing semantics

The indexer **only reads files at the current `git HEAD`** of the repo. Dirty worktree files are ignored. Each `cg_reindex` call:

1. Reads `git rev-parse HEAD`
2. Compares against `cg_index_state.commit_sha`; if equal and `force=false`, returns `{ skipped: true }`
3. Otherwise enumerates `git ls-tree -r HEAD`, materializes each indexable file via `git show` into a temp directory, parses, and replaces `cg_files` / `cg_symbols` / `cg_references` in a single SQLite transaction
4. The temp directory is deleted in a `finally` block — never leaks even on failure

For file-backed databases, `cg_reindex` defaults to running in a `worker_threads` Worker (`indexer-worker.js`) so the main event loop isn't blocked during a large repo index. Pass `async: false` to force a synchronous run. In-memory databases always run synchronously since Workers can't share an in-memory SQLite handle.

## Architecture

```
server/plugins/codegraph/
├── index.js              # Plugin factory + lifecycle (install/uninstall/mcpTools/diagnostics)
├── schema.js             # CREATE TABLE for cg_files/cg_symbols/cg_references/cg_index_state
├── parser.js             # Native tree-sitter parser pool (cached per language)
├── extractors/
│   ├── index.js          # extractorFor(filePath) dispatch by file extension
│   └── javascript.js     # AST walker for JS/TS/TSX → {symbols, references}
├── indexer.js            # runIndex({db, repoPath, files, ...}) — pure, transactional
├── index-runner.js       # indexRepoAtHead + worker job lifecycle (startReindexJob/getJobStatus)
├── indexer-worker.js     # worker_threads entrypoint
├── queries/
│   ├── find-references.js
│   ├── call-graph.js     # BFS bounded at depth 8, MAX_NODES 100
│   ├── impact-set.js     # transitive caller closure + file rollup
│   ├── dead-symbols.js   # symbols never appearing as a target_name
│   ├── resolve-tool.js   # MCP tool name → handler symbol via dispatch edges
│   └── class-hierarchy.js # extends/implements BFS for ancestors / descendants
├── handlers.js           # 8 async tool handlers (createHandlers({db}))
├── tool-defs.js          # MCP tool descriptors with inputSchema
├── test-helpers.js       # setupTinyRepo / destroyTinyRepo (real git via execFileSync)
├── fixtures/tiny-repo/   # a.js + b.js used by deterministic tests
└── tests/                # vitest suite (~30 tests across 8 files)
```

## Limitations (MVP)

- JS/TS only. Native grammars for Python, Go, Rust, C# and others are available as separate npm packages and can be added by writing one extractor per language behind the same `extractorFor(filePath)` interface.
- No cross-repo references.
- Identifier-based call resolution only — no scope or import-aware binding. `foo()` in two files maps to the same target name. Consumers should treat results as candidate impact, not proof.
- No incremental commit-by-commit updates; `cg_reindex` always re-indexes from scratch (idempotent — runs no-op if HEAD is unchanged).
- The `installed` flag on the plugin is set at the END of `install()`, so a thrown error during schema bootstrap, diagnostics walk, or handler creation leaves the plugin in `installed: false` — `mcpTools()` will return `[]` rather than half-wired tools.

## Validation plan

After cutover, the plugin loads inert (no tools registered) until `TORQUE_CODEGRAPH_ENABLED=1` is set in the TORQUE environment. Once enabled, run a one-week shadow-mode validation: serve queries via the REST endpoints manually but do not wire the Planner or scouts to consume them. Track:

- Reindex success rate per repo
- Query result quality (sample 10 known refactors per week, compare `cg_impact_set` against ground truth)
- Stale-index incidents (queries returning data from before the latest commit)

If staleness rate < 1% and impact-set recall > 80% after the validation window, write a follow-up plan integrating `cg_*` queries into the Planner's plan-generation prompt context.
