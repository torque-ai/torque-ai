'use strict';

const tools = [
  {
    name: 'start_oauth_flow',
    description: 'Begin an OAuth flow for a toolkit. Returns an authorize_url the user must visit.',
    inputSchema: {
      type: 'object',
      properties: {
        toolkit: {
          type: 'string',
          description: 'Toolkit identifier, for example github or slack',
        },
        user_id: {
          type: 'string',
          description: 'User identity that owns the connected account',
        },
      },
      required: ['toolkit', 'user_id'],
    },
  },
  {
    name: 'complete_oauth_flow',
    description: 'Exchange an authorization code for tokens and create a connected_account.',
    inputSchema: {
      type: 'object',
      properties: {
        toolkit: {
          type: 'string',
          description: 'Toolkit identifier, for example github or slack',
        },
        user_id: {
          type: 'string',
          description: 'User identity that owns the connected account',
        },
        code: {
          type: 'string',
          description: 'Authorization code returned by the OAuth provider',
        },
      },
      required: ['toolkit', 'user_id', 'code'],
    },
  },
  {
    name: 'list_connected_accounts',
    description: 'List connected_accounts for a user (optionally filtered by toolkit).',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'User identity that owns the connected accounts',
        },
        toolkit: {
          type: 'string',
          description: 'Optional toolkit filter',
        },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'disable_account',
    description: 'Disable a connected_account without deleting tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Connected account identifier',
        },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'delete_account',
    description: 'Hard-delete a connected_account.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Connected account identifier',
        },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'list_tools_by_hints',
    description: 'Filter registered tools by behavioral hints (readOnlyHint, destructiveHint, idempotentHint, openWorldHint).',
    inputSchema: {
      type: 'object',
      properties: {
        readOnlyHint: {
          type: 'boolean',
          description: 'Require tools marked read-only',
        },
        destructiveHint: {
          type: 'boolean',
          description: 'Require tools marked destructive',
        },
        idempotentHint: {
          type: 'boolean',
          description: 'Require tools marked idempotent',
        },
        openWorldHint: {
          type: 'boolean',
          description: 'Require tools that can trigger external or open-world effects',
        },
      },
    },
  },
];

module.exports = tools;
