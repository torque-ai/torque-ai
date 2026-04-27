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

function createHandlers({ db }) {
  return {
    async cg_index_status(args) {
      const repoPath = requireString(args, 'repo_path');
      const state = getIndexState({ db, repoPath });
      if (!state) return { indexed: false };
      return {
        indexed: true,
        commit_sha: state.commitSha,
        indexed_at: state.indexedAt,
        files: state.files,
        symbols: state.symbols,
        references: state.referencesCount,
      };
    },

    async cg_reindex(args) {
      const repoPath = requireString(args, 'repo_path');
      const force = args.force === true;
      // async path is enabled in Task 17 (worker-thread). For now always synchronous.
      return indexRepoAtHead({ db, repoPath, force });
    },

    async cg_find_references(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      return findReferences({ db, repoPath, symbol });
    },

    async cg_call_graph(args) {
      const repoPath  = requireString(args, 'repo_path');
      const symbol    = requireString(args, 'symbol');
      const direction = args.direction || 'callees';
      const depth     = args.depth ?? 2;
      return callGraph({ db, repoPath, symbol, direction, depth });
    },

    async cg_impact_set(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      const depth    = args.depth ?? 5;
      return impactSet({ db, repoPath, symbol, depth });
    },

    async cg_dead_symbols(args) {
      const repoPath = requireString(args, 'repo_path');
      return deadSymbols({ db, repoPath });
    },
  };
}

module.exports = { createHandlers };
