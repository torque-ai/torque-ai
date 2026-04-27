'use strict';

const tools = [
  {
    name: 'cg_index_status',
    description: 'Return index state for a repo: commit_sha, indexed_at, file/symbol/reference counts, and whether the index is stale relative to current HEAD.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string', description: 'Absolute path to the repository.' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_reindex',
    description: 'Index the repository at HEAD into the code graph. Idempotent unless force=true. Returns counts.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        force:     { type: 'boolean', default: false },
        async:     { type: 'boolean', default: true,  description: 'Run in worker thread; set false for synchronous indexing.' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_find_references',
    description: 'Find every call site of a symbol in the indexed repo. Returns file/line/column/callerSymbol for each reference.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_call_graph',
    description: 'Walk the call graph from a symbol. direction=callers|callees|both, depth bounded.',
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
    description: 'Compute the impact set of changing a symbol: every transitively-affected symbol and the files containing them.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
        depth:     { type: 'integer', minimum: 1, maximum: 8, default: 5 },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_dead_symbols',
    description: 'List symbols defined in the repo but never referenced. Hint for dead-code sweeps.',
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
