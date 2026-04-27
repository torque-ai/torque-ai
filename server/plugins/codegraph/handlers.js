'use strict';

const { indexRepoAtHead, getIndexState } = require('./index-runner');
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
// Mirror the version-control plugin's pattern.
function asToolResult(payload) {
  return {
    content: [{
      type: 'text',
      text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
    }],
    structuredData: typeof payload === 'object' && payload !== null ? payload : undefined,
  };
}

function createHandlers({ db }) {
  return {
    async cg_index_status(args) {
      const repoPath = requireString(args, 'repo_path');
      const state = getIndexState({ db, repoPath });
      if (!state) return asToolResult({ indexed: false });
      return asToolResult({
        indexed: true,
        commit_sha: state.commitSha,
        indexed_at: state.indexedAt,
        files: state.files,
        symbols: state.symbols,
        references: state.referencesCount,
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
      return asToolResult(findReferences({ db, repoPath, symbol }));
    },

    async cg_call_graph(args) {
      const repoPath  = requireString(args, 'repo_path');
      const symbol    = requireString(args, 'symbol');
      const direction = args.direction || 'callees';
      const depth     = args.depth ?? 2;
      return asToolResult(callGraph({ db, repoPath, symbol, direction, depth }));
    },

    async cg_impact_set(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      const depth    = args.depth ?? 5;
      return asToolResult(impactSet({ db, repoPath, symbol, depth }));
    },

    async cg_dead_symbols(args) {
      const repoPath = requireString(args, 'repo_path');
      return asToolResult(deadSymbols({ db, repoPath }));
    },
  };
}

module.exports = { createHandlers };
