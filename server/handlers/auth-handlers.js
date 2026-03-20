'use strict';

/**
 * Handlers for API key management MCP tools.
 * Thin wrappers around key-manager — all business logic lives there.
 */

const keyManager = require('../auth/key-manager');
const { makeError } = require('./error-codes');

function handleCreateApiKey(args) {
  if (!args.name) return makeError('name is required');

  let result;
  try {
    result = keyManager.createKey({
      name: args.name,
      role: args.role || 'admin',
    });
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }

  const text = [
    '## API Key Created',
    '',
    `**Key:** \`${result.key}\``,
    '',
    '> Save this key now — it will never be shown again.',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| ID | ${result.id} |`,
    `| Name | ${result.name} |`,
    `| Role | ${result.role} |`,
  ].join('\n');

  return { content: [{ type: 'text', text }] };
}

function handleListApiKeys(args) {
  let keys;
  try {
    keys = keyManager.listKeys();
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }

  if (keys.length === 0) {
    return { content: [{ type: 'text', text: 'No API keys configured. Use `create_api_key` to create one.' }] };
  }

  const header = '| ID | Name | Role | Created | Last Used | Status |';
  const divider = '|------|------|------|---------|-----------|--------|';
  const rows = keys.map(k => {
    const status = k.revoked_at ? 'Revoked' : 'Active';
    return `| ${k.id.slice(0, 8)} | ${k.name} | ${k.role} | ${k.created_at ? k.created_at.slice(0, 10) : '-'} | ${k.last_used_at ? k.last_used_at.slice(0, 10) : 'Never'} | ${status} |`;
  });

  return {
    content: [{ type: 'text', text: `## API Keys\n\n${header}\n${divider}\n${rows.join('\n')}` }],
  };
}

function handleRevokeApiKey(args) {
  if (!args.id) return makeError('id is required');

  try {
    keyManager.revokeKey(args.id);
    return { content: [{ type: 'text', text: `API key ${args.id} has been revoked.` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

module.exports = {
  handleCreateApiKey,
  handleListApiKeys,
  handleRevokeApiKey,
};
