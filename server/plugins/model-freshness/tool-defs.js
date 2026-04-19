'use strict';

module.exports = [
  {
    name: 'model_watchlist_list',
    description: 'List active (or all) entries on the model freshness watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        include_inactive: { type: 'boolean', description: 'Include deactivated entries.' },
      },
    },
  },
  {
    name: 'model_watchlist_add',
    description: 'Add a model family:tag to the freshness watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: 'Model family, e.g. qwen3-coder.' },
        tag: { type: 'string', description: 'Model tag, e.g. 30b.' },
      },
      required: ['family', 'tag'],
    },
  },
  {
    name: 'model_watchlist_remove',
    description: 'Soft-delete an entry from the freshness watchlist (preserves history).',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string' },
        tag: { type: 'string' },
      },
      required: ['family', 'tag'],
    },
  },
  {
    name: 'model_freshness_scan_now',
    description: 'Run a freshness scan synchronously and return pending events.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'model_freshness_events',
    description: 'List pending freshness events. Set include_acknowledged=true for full history.',
    inputSchema: {
      type: 'object',
      properties: {
        include_acknowledged: { type: 'boolean' },
      },
    },
  },
];
