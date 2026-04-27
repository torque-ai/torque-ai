'use strict';

const { indexRepoAtHead, getIndexState, getCurrentRepoSha } = require('./index-runner');
const { findReferences } = require('./queries/find-references');
const { callGraph }      = require('./queries/call-graph');
const { impactSet }      = require('./queries/impact-set');
const { deadSymbols }    = require('./queries/dead-symbols');

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
        staleness: staleness(db, repoPath),
      });
    },

    async cg_impact_set(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      const depth    = args.depth ?? 5;
      const i = impactSet({ db, repoPath, symbol, depth });
      return asToolResult({
        symbols: i.symbols,
        files: i.files,
        staleness: staleness(db, repoPath),
      });
    },

    async cg_dead_symbols(args) {
      const repoPath = requireString(args, 'repo_path');
      const dead = deadSymbols({ db, repoPath });
      return asToolResult({
        dead_symbols: dead,
        staleness: staleness(db, repoPath),
        caveat: 'MVP uses identifier-only resolution. Dynamic dispatch (string-keyed handler lookup, plugin contract methods called by loaders, dependency-injection containers) will appear here as false positives. Treat results as deletion candidates requiring human verification, not facts.',
      });
    },
  };
}

module.exports = { createHandlers };
