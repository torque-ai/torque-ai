'use strict';

const { indexRepoAtHead, getIndexState, getCurrentRepoSha } = require('./index-runner');
const { findReferences } = require('./queries/find-references');
const { callGraph }      = require('./queries/call-graph');
const { impactSet }      = require('./queries/impact-set');
const { deadSymbols }    = require('./queries/dead-symbols');
const { resolveTool }    = require('./queries/resolve-tool');
const { classHierarchy } = require('./queries/class-hierarchy');
const telemetry          = require('./telemetry');

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
      const ifTracked = args.if_tracked === true;
      // if_tracked guards against accidentally bootstrapping a brand-new repo
      // index from a fire-and-forget caller (e.g. the post-commit hook). When
      // set, we only reindex repos already in cg_index_state — so the hook
      // keeps existing indexes fresh without ever spending minutes on a full
      // first-time index of an unrelated worktree's commit.
      if (ifTracked) {
        const tracked = getIndexState({ db, repoPath });
        if (!tracked) {
          return asToolResult({ skipped: true, reason: 'not_tracked', repo_path: repoPath });
        }
      }
      const dbPath = db.name && db.name !== ':memory:' ? db.name : null;
      if (wantsAsync && dbPath) {
        return asToolResult(require('./index-runner').startReindexJob({ dbPath, repoPath, force }));
      }
      return asToolResult(await indexRepoAtHead({ db, repoPath, force }));
    },

    async cg_find_references(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      const scope    = args.scope || 'loose';
      const container = typeof args.container === 'string' && args.container ? args.container : null;
      if (scope !== 'loose' && scope !== 'strict') {
        throw new Error("scope must be 'loose' or 'strict'");
      }
      if (container && scope !== 'strict') {
        throw new Error("container filter requires scope='strict'");
      }
      return asToolResult({
        references: findReferences({ db, repoPath, symbol, scope, container }),
        scope,
        ...(container && { container }),
        staleness: staleness(db, repoPath),
      });
    },

    async cg_call_graph(args) {
      const repoPath  = requireString(args, 'repo_path');
      const symbol    = requireString(args, 'symbol');
      const direction = args.direction || 'callees';
      const depth     = args.depth ?? 2;
      const scope     = args.scope || 'loose';
      if (scope !== 'loose' && scope !== 'strict') {
        throw new Error("scope must be 'loose' or 'strict'");
      }
      const g = callGraph({ db, repoPath, symbol, direction, depth, scope });
      return asToolResult({
        nodes: g.nodes,
        edges: g.edges,
        truncated: g.truncated,
        max_nodes: g.max_nodes,
        scope,
        ...(g.truncated && { truncation_hint: `Result hit the ${g.max_nodes}-node cap. Narrow with smaller depth, or pivot to find_references / impact_set on a more specific symbol.` }),
        staleness: staleness(db, repoPath),
      });
    },

    async cg_impact_set(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      const depth    = args.depth ?? 3;
      const scope    = args.scope || 'loose';
      if (scope !== 'loose' && scope !== 'strict') {
        throw new Error("scope must be 'loose' or 'strict'");
      }
      const i = impactSet({ db, repoPath, symbol, depth, scope });
      return asToolResult({
        symbols: i.symbols,
        files: i.files,
        truncated: !!i.truncated,
        max_nodes: i.max_nodes,
        depth_used: depth,
        scope,
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

    async cg_class_hierarchy(args) {
      const repoPath  = requireString(args, 'repo_path');
      const symbol    = requireString(args, 'symbol');
      const direction = args.direction || 'descendants';
      if (direction !== 'descendants' && direction !== 'ancestors') {
        throw new Error("direction must be 'descendants' or 'ancestors'");
      }
      const depth = args.depth ?? 3;
      const h = classHierarchy({ db, repoPath, symbol, direction, depth });
      const otherDir = direction === 'descendants' ? 'ancestors' : 'descendants';
      return asToolResult({
        symbol,
        direction,
        nodes: h.nodes,
        edges: h.edges,
        truncated: h.truncated,
        max_nodes: h.max_nodes,
        depth_used: depth,
        ...(h.edges.length === 0 && {
          hint: `No ${direction} found for '${symbol}'. The class may not exist in the indexed repo, may be defined in a third-party package (only own-source classes are captured), or may use dynamic inheritance (e.g. mixin functions). Try cg_find_references on '${symbol}' to confirm it's reachable, and try direction='${otherDir}' to walk the other way.`,
        }),
        ...(h.truncated && { truncation_hint: `Result hit the ${h.max_nodes}-node cap. The hierarchy is larger than this query exposes. Reduce depth (try 1 or 2) for direct relationships, or query a more specific subclass.` }),
        staleness: staleness(db, repoPath),
      });
    },

    async cg_resolve_tool(args) {
      const repoPath = requireString(args, 'repo_path');
      const toolName = requireString(args, 'tool_name');
      const { handlers, candidates, convention_candidates } = resolveTool({ db, repoPath, toolName });
      const hasHandlers = handlers.length > 0;
      const hasCandidates = candidates.length > 0;
      const hasConvention = convention_candidates.length > 0;
      return asToolResult({
        tool_name: toolName,
        handlers,
        candidates,
        convention_candidates,
        ...(hasHandlers === false && hasCandidates && {
          hint: `No explicit dispatcher captured for '${toolName}', but ${candidates.length} symbol(s) with that exact name were found. In most JS/TS conventions (and TORQUE plugins), runtime dispatch handlers[toolName] resolves to a same-named method — these candidates are very likely the actual handler.`,
        }),
        ...(hasHandlers === false && hasCandidates === false && hasConvention && {
          hint: `No dispatcher and no exact-name symbol found for '${toolName}', but ${convention_candidates.length} symbol(s) match the TORQUE handle<PascalCase> convention (e.g. smart_submit_task → handleSmartSubmitTask). These are likely the handler — verify by inspecting the file/line.`,
        }),
        ...(hasHandlers === false && hasCandidates === false && hasConvention === false && {
          hint: `No dispatcher, no exact-name symbol, and no handle<PascalCase> convention match for '${toolName}'. The tool may be defined in a different repo, registered dynamically from a string interpolation, or misspelled. Try cg_find_references on '${toolName}' as a string symbol to find call sites that mention it.`,
        }),
        staleness: staleness(db, repoPath),
      });
    },

    async cg_telemetry(args) {
      const sinceHoursRaw = args?.since_hours;
      const sinceHours = Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0
        ? Math.min(sinceHoursRaw, 24 * 365)
        : 24;
      const tool = typeof args?.tool === 'string' && args.tool ? args.tool : null;
      const summary = telemetry.summarize(db, { sinceHours, tool });
      return asToolResult({
        since_hours: sinceHours,
        ...(tool && { tool_filter: tool }),
        tools: summary,
        total_calls: summary.reduce((acc, r) => acc + r.calls, 0),
      });
    },
  };
}

module.exports = { createHandlers };
