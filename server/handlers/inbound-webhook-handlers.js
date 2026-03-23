/**
 * Inbound Webhook Handlers
 *
 * MCP tool handlers for managing inbound webhooks that trigger task creation
 * when external services POST to TORQUE.
 */

const crypto = require('crypto');
const { makeError, ErrorCodes } = require('./error-codes');

let _inboundWebhooks;
function inboundWebhooks() { return _inboundWebhooks || (_inboundWebhooks = require('../db/inbound-webhooks')); }

// ============================================
// INBOUND WEBHOOK HANDLERS
// ============================================

/**
 * Create a new inbound webhook
 */
function handleCreateInboundWebhook(args) {
  const { name, source_type, task_description, provider, model, tags, working_directory, trigger_type } = args;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name is required and must be a non-empty string');
  }

  if (!task_description || typeof task_description !== 'string' || task_description.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_description is required and must be a non-empty string');
  }

  const validSourceTypes = ['generic', 'github', 'gitlab'];
  if (source_type && !validSourceTypes.includes(source_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, `source_type must be one of: ${validSourceTypes.join(', ')}`);
  }

  const validTriggerTypes = ['standard', 'quota_task'];
  if (trigger_type && !validTriggerTypes.includes(trigger_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, `trigger_type must be one of: ${validTriggerTypes.join(', ')}`);
  }

  // Check for duplicate name
  const existing = inboundWebhooks().getInboundWebhook(name.trim());
  if (existing) {
    return makeError(ErrorCodes.CONFLICT, `Inbound webhook with name '${name.trim()}' already exists`);
  }

  // Generate HMAC secret
  const secret = crypto.randomBytes(32).toString('hex');

  // Build action_config
  const action_config = {
    task_description: task_description.trim(),
  };
  if (trigger_type && trigger_type !== 'standard') action_config.trigger_type = trigger_type;
  if (provider) action_config.provider = provider;
  if (model) action_config.model = model;
  if (tags) action_config.tags = tags;
  if (working_directory) action_config.working_directory = working_directory;

  const webhook = inboundWebhooks().createInboundWebhook({
    name: name.trim(),
    source_type: source_type || 'generic',
    secret,
    action_config,
  });

  return {
    content: [{
      type: 'text',
      text: [
        '## Inbound Webhook Created',
        '',
        `**Name:** ${webhook.name}`,
        `**ID:** ${webhook.id}`,
        `**Source Type:** ${webhook.source_type}`,
        `**Secret:** ${secret}`,
        `**Endpoint:** POST /api/webhooks/inbound/${encodeURIComponent(webhook.name)}`,
        '',
        '### Signature Header',
        webhook.source_type === 'github'
          ? 'Use `X-Hub-Signature-256: sha256=<hmac>` (GitHub native)'
          : 'Use `X-Webhook-Signature: sha256=<hmac>`',
        '',
        '### Action Config',
        '```json',
        JSON.stringify(webhook.action_config, null, 2),
        '```',
        '',
        'Use `{{payload.field}}` in task_description to substitute webhook payload values.',
      ].join('\n'),
    }],
  };
}

/**
 * List all inbound webhooks
 */
function handleListInboundWebhooks() {
  const webhooks = inboundWebhooks().listInboundWebhooks();

  if (webhooks.length === 0) {
    return {
      content: [{ type: 'text', text: '## Inbound Webhooks\n\nNo inbound webhooks configured.' }],
    };
  }

  const lines = ['## Inbound Webhooks', '', `${webhooks.length} webhook(s) configured:`, ''];

  for (const wh of webhooks) {
    lines.push(`### ${wh.name}`);
    lines.push(`- **ID:** ${wh.id}`);
    lines.push(`- **Source:** ${wh.source_type}`);
    if (wh.action_config && wh.action_config.trigger_type) {
      lines.push(`- **Trigger Type:** ${wh.action_config.trigger_type}`);
    }
    lines.push(`- **Enabled:** ${wh.enabled ? 'Yes' : 'No'}`);
    lines.push(`- **Triggers:** ${wh.trigger_count}`);
    lines.push(`- **Last Triggered:** ${wh.last_triggered_at || 'Never'}`);
    lines.push(`- **Created:** ${wh.created_at}`);
    lines.push('');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

/**
 * Delete an inbound webhook by name
 */
function handleDeleteInboundWebhook(args) {
  const { name } = args;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name is required and must be a non-empty string');
  }

  const existing = inboundWebhooks().getInboundWebhook(name.trim());
  if (!existing) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Inbound webhook '${name.trim()}' not found`);
  }

  inboundWebhooks().deleteInboundWebhook(name.trim());

  return {
    content: [{
      type: 'text',
      text: `## Inbound Webhook Deleted\n\nWebhook '${name.trim()}' has been deleted.`,
    }],
  };
}

/**
 * Test an inbound webhook (dry-run)
 * Shows what WOULD happen when triggered, without actually creating a task.
 */
function handleTestInboundWebhook(args) {
  const { webhook_name, payload } = args;

  if (!webhook_name || typeof webhook_name !== 'string' || webhook_name.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'webhook_name is required and must be a non-empty string');
  }

  const webhook = inboundWebhooks().getInboundWebhook(webhook_name.trim());
  if (!webhook) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Inbound webhook '${webhook_name.trim()}' not found`);
  }

  if (!webhook.enabled) {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Inbound webhook '${webhook_name.trim()}' is disabled. Enable it before testing.`);
  }

  // Parse action_config
  let actionConfig;
  if (typeof webhook.action_config === 'string') {
    try { actionConfig = JSON.parse(webhook.action_config); } catch { actionConfig = {}; }
  } else {
    actionConfig = webhook.action_config || {};
  }

  // Build test payload with defaults
  const testPayload = payload || {
    repository: 'example/repo',
    branch: 'main',
    commit: 'abc1234',
    author: 'test-user',
    message: 'Test commit message',
  };

  // Apply {{payload.*}} variable substitution
  let resolvedDescription = actionConfig.task_description || '(no task_description in action_config)';
  resolvedDescription = resolvedDescription.replace(/\{\{payload\.([^}]+)\}\}/g, (match, key) => {
    // Support nested keys like payload.repository.name via dot notation
    const parts = key.split('.');
    let value = testPayload;
    for (const part of parts) {
      if (value && typeof value === 'object') {
        value = value[part];
      } else {
        value = undefined;
        break;
      }
    }
    return value !== undefined ? String(value) : match;
  });

  const lines = [
    '## Inbound Webhook Test (Dry Run)',
    '',
    `**Webhook:** ${webhook.name}`,
    `**Source Type:** ${webhook.source_type}`,
    `**Trigger Type:** ${actionConfig.trigger_type || 'standard'}`,
    `**Enabled:** Yes`,
    '',
    '### Resolved Task Description',
    '```',
    resolvedDescription,
    '```',
    '',
    '### Action Config',
    `- **Provider:** ${actionConfig.provider || '(smart routing)'}`,
    `- **Model:** ${actionConfig.model || '(default)'}`,
    `- **Tags:** ${actionConfig.tags || '(none)'}`,
    `- **Working Directory:** ${actionConfig.working_directory || '(none)'}`,
    '',
    '### Test Payload Used',
    '```json',
    JSON.stringify(testPayload, null, 2),
    '```',
    '',
    '*This is a dry run. No task was created.*',
  ];

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
}

function createInboundWebhookHandlers() {
  return {
    handleCreateInboundWebhook,
    handleListInboundWebhooks,
    handleDeleteInboundWebhook,
    handleTestInboundWebhook,
  };
}

module.exports = {
  handleCreateInboundWebhook,
  handleListInboundWebhooks,
  handleDeleteInboundWebhook,
  handleTestInboundWebhook,
  createInboundWebhookHandlers,
};
