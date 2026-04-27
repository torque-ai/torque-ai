'use strict';

const { indexRepoAtHead, getIndexState, getCurrentRepoSha } = require('./index-runner');
const { findReferences } = require('./queries/find-references');
const { callGraph }      = require('./queries/call-graph');
const { impactSet }      = require('./queries/impact-set');
const { deadSymbols }    = require('./queries/dead-symbols');
const { resolveTool }    = require('./queries/resolve-tool');

function requireString(args, key) {
  if (typeof args?.[key] !== 'string' || args[key].length === 0) {
    throw new Error(`missing required argument: ${key}`);
  }
  return args[key];
}

// MCP tool response envelope. The REST passthrough at api-server.core.js reads
// result.content[0].text — bare object returns surface as empty `result: ""`.
function asToolResult(payload) {
  return {
    content: [{
      type: 'text',
      text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
    }],
    structuredData: typeof payload === 'object' && payload !== null ? payload : undefined,
  };
}

// Snapshot of how trustworthy the indexed data is right now.
// LLM consumers should check `staleness.stale` before acting on results;
// when stale, either call cg_reindex or treat the data as historical.
function staleness(db, repoPath) {
  const state = getIndexState({ db, repoPath });
  const currentSha = getCurrentRepoSha(repoPath);
  if (!state) {
    return {
      indexed: false,
      current_sha: currentSha,
      stale: true,
      message: 'Repo has not been indexed. Call cg_reindex first.',
    };
  }
  const isStale = currentSha != null && state.commitSha !== currentSha;
  return {
    indexed: true,
    indexed_sha: state.commitSha,
    indexed_at: state.indexedAt,
    current_sha: currentSha,
    stale: isStale,
    ...(isStale && { message: 'Index is older than current HEAD. Results reflect a previous commit; call cg_reindex with force=true to refresh.' }),
  };
}

function createHandlers({ db }) {
  return {
    async cg_index_status(args) {
      const repoPath = requireString(args, 'repo_path');
      const state = getIndexState({ db, repoPath });
      if (!state) {
        return asToolResult({
          indexed: false,
          staleness: staleness(db, repoPath),
        });
      }
      return asToolResult({
        indexed: true,
        commit_sha: state.commitSha,
        indexed_at: state.indexedAt,
        files: state.files,
        symbols: state.symbols,
        references: state.referencesCount,
        staleness: staleness(db, repoPath),
      });
    },

    async cg_reindex(args) {
      const repoPath = requireString(args, 'repo_path');
      const force = args.force === true;
      const wantsAsync = args.async !== false;
      const dbPath = db.name && db.name !== ':memory:' ? db.name : null;
      if (wantsAsync && dbPath) {
        return asToolResult(require('./index-runner').startReindexJob({ dbPath, repoPath, force }));
      }
      return asToolResult(await indexRepoAtHead({ db, repoPath, force }));
    },

    async cg_find_references(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      return asToolResult({
        references: findReferences({ db, repoPath, symbol }),
        staleness: staleness(db, repoPath),
      });
    },

    async cg_call_graph(args) {
      const repoPath  = requireString(args, 'repo_path');
      const symbol    = requireString(args, 'symbol');
      const direction = args.direction || 'callees';
      const depth     = args.depth ?? 2;
      const g = callGraph({ db, repoPath, symbol, direction, depth });
      return asToolResult({
        nodes: g.nodes,
        edges: g.edges,
        truncated: g.truncated,
        max_nodes: g.max_nodes,
        ...(g.truncated && { truncation_hint: `Result hit the ${g.max_nodes}-node cap. Narrow with smaller depth, or pivot to find_references / impact_set on a more specific symbol.` }),
        staleness: staleness(db, repoPath),
      });
    },

    async cg_impact_set(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      const depth    = args.depth ?? 3;
      const i = impactSet({ db, repoPath, symbol, depth });
      return asToolResult({
        symbols: i.symbols,
        files: i.files,
        truncated: !!i.truncated,
        max_nodes: i.max_nodes,
        depth_used: depth,
        ...(i.truncated && { truncation_hint: `Result hit the ${i.max_nodes}-node cap. The blast radius is wider than this query exposes. Reduce depth (try 2) for direct impact, or query specific call sites with find_references.` }),
        staleness: staleness(db, repoPath),
      });
    },

    async cg_dead_symbols(args) {
      const repoPath = requireString(args, 'repo_path');
      const includeExported = args.include_exported === true;
      const includeLikelyDispatched = args.include_likely_dispatched === true;
      const dead = deadSymbols({ db, repoPath, includeExported, includeLikelyDispatched });
      return asToolResult({
        dead_symbols: dead,
        filter: {
          include_exported: includeExported,
          include_likely_dispatched: includeLikelyDispatched,
        },
        staleness: staleness(db, repoPath),
        caveat: includeLikelyDispatched
          ? 'Permissive mode: dynamic-dispatch heuristic disabled. Many results will be tool handlers, plugin contract methods, or framework hooks called by name — not actually dead.'
          : 'Identifier-only resolution. Symbols dispatched via dynamic lookups beyond the heuristic are still false-positive risk. Verify before deletion.',
      });
    },

    async cg_resolve_tool(args) {
      const repoPath = requireString(args, 'repo_path');
      const toolName = requireString(args, 'tool_name');
      const { handlers, candidates } = resolveTool({ db, repoPath, toolName });
      return asToolResult({
        tool_name: toolName,
        handlers,
        candidates,
        ...(handlers.length === 0 && candidates.length > 0 && {
          hint: `No explicit dispatcher captured for '${toolName}', but ${candidates.length} symbol(s) with that exact name were found in the index. In most JS/TS conventions (and TORQUE plugins specifically), the runtime dispatch handlers[toolName] resolves to a same-named method or function — these candidate symbols are very likely the actual handler. Verify by inspecting the file/line.`,
        }),
        ...(handlers.length === 0 && candidates.length === 0 && {
          hint: `No dispatcher captured AND no symbol named '${toolName}' was found in the indexed repo. The tool may be defined in a different repo, registered dynamically from a string interpolation, or misspelled. Try cg_find_references on the tool name as a string symbol to find call sites that mention it.`,
        }),
        staleness: staleness(db, repoPath),
      });
    },
  };
}

module.exports = { createHandlers };
