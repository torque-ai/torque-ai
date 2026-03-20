'use strict';

const crypto = require('crypto');
const db = require('../database');
const { handleToolCall } = require('../tools');
const { sendJson } = require('./middleware');

const RAW_WEBHOOK_BODY_LIMIT_BYTES = 10 * 1024 * 1024; // 10MB

// Dependency-injected getter for FreeQuotaTracker (set by api-server.core.js)
let _freeTierTrackerGetter = null;
function setFreeTierTrackerGetter(getter) { _freeTierTrackerGetter = getter; }

/**
 * Verify HMAC-SHA256 signature using constant-time comparison.
 * Supports GitHub's X-Hub-Signature-256 and generic X-Webhook-Signature headers.
 */
function verifyWebhookSignature(secret, body, signatureHeader) {
  if (!signatureHeader) return false;
  if (!secret || secret.length === 0) return false;

  // Extract the hex digest (strip "sha256=" prefix if present)
  const parts = signatureHeader.split('=');
  let receivedHex;
  if (parts.length === 2 && parts[0] === 'sha256') {
    receivedHex = parts[1];
  } else {
    receivedHex = signatureHeader;
  }

  const expectedHmac = crypto.createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');

  // Both must be valid hex of the same length for timingSafeEqual
  if (receivedHex.length !== expectedHmac.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedHex, 'hex'),
      Buffer.from(expectedHmac, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Substitute {{payload.field}} placeholders in a template string with values from the payload.
 * Supports dot-notation for nested fields (e.g., {{payload.repository.name}}).
 */
function substitutePayload(template, payload) {
  return template.replace(/\{\{payload\.([^}]+)\}\}/g, (match, path) => {
    const keys = path.split('.');
    let value = payload;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return match;
      value = value[key];
    }
    return value != null ? String(value) : match;
  });
}

function parseRawWebhookBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let settled = false;

    req.on('data', chunk => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += chunkBuffer.length;
      if (totalSize > RAW_WEBHOOK_BODY_LIMIT_BYTES) {
        if (!settled) { settled = true; reject(new Error('Request body too large')); }
        req.destroy();
        return;
      }
      chunks.push(chunkBuffer);
    });
    req.on('end', () => {
      if (settled) return;
      const body = Buffer.concat(chunks).toString('utf8');
      settled = true;
      resolve(body);
    });
    req.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
  });
}

/**
 * POST /api/webhooks/inbound/:name
 * Handles inbound webhook triggers with HMAC signature verification.
 * This is NOT in the routes array — it uses its own auth (HMAC, not API key).
 */
async function handleInboundWebhook(req, res, webhookName, _context = {}) {
  void _context;
  // Look up webhook by name
  let webhook;
  try {
    webhook = db.getInboundWebhook(webhookName);
  } catch (_err) {
    void _err;
    sendJson(res, { error: 'Internal error' }, 500, req);
    return;
  }

  if (!webhook) {
    sendJson(res, { error: 'Webhook not found' }, 404, req);
    return;
  }

  if (!webhook.enabled) {
    sendJson(res, { error: 'Webhook is disabled' }, 403, req);
    return;
  }

  // Parse body as raw string for HMAC verification
  let rawBody;
  try {
    rawBody = await parseRawWebhookBody(req);
  } catch (err) {
    sendJson(res, { error: err.message }, 400, req);
    return;
  }

  // Verify HMAC signature
  const signatureHeader = req.headers['x-hub-signature-256'] || req.headers['x-webhook-signature'];
  if (!verifyWebhookSignature(webhook.secret, rawBody, signatureHeader)) {
    sendJson(res, { error: 'Invalid signature' }, 401, req);
    return;
  }

  // Parse JSON payload
  let payload = {};
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      sendJson(res, { error: 'Invalid JSON payload' }, 400, req);
      return;
    }
  }

  // Substitute {{payload.*}} in task description
  const actionConfig = webhook.action_config;
  const taskDescription = substitutePayload(
    (actionConfig?.task_description || ''),
    payload
  );

  // Build task args
  const taskArgs = {
    task_description: taskDescription,
  };
  if (actionConfig.provider) taskArgs.provider = actionConfig.provider;
  if (actionConfig.model) taskArgs.model = actionConfig.model;
  if (actionConfig.tags) taskArgs.tags = actionConfig.tags;
  if (actionConfig.working_directory) taskArgs.working_directory = actionConfig.working_directory;

  // Extract delivery ID from standard webhook headers
  const deliveryId = req.headers['x-webhook-delivery'] || req.headers['x-hub-delivery'] || req.headers['x-github-delivery'];
  if (deliveryId) {
    const existing = db.checkDeliveryExists(deliveryId);
    if (existing) {
      sendJson(res, { success: true, message: 'Duplicate delivery ignored', task_id: existing.task_id, delivery_id: deliveryId }, 200, req);
      return;
    }
  }

  // Route based on trigger_type
  const isFreeTierTrigger = actionConfig.trigger_type === 'free_tier_task';
  let result;
  let freeTierProvider = null;

  if (isFreeTierTrigger) {
    // Free-tier routing: pick best available free-tier provider, skip Codex/smart routing

    if (typeof _freeTierTrackerGetter === 'function') {
      const tracker = _freeTierTrackerGetter();
      if (tracker) {
        const taskMeta = {
          complexity: actionConfig.complexity || 'normal',
          descriptionLength: taskDescription.length,
        };
        const available = tracker.getAvailableProvidersSmart(taskMeta);
        if (available.length > 0) {
          freeTierProvider = available[0].provider;
        }
      }
    }

    if (freeTierProvider) {
      // Submit directly to the free-tier provider via submit_task
      const freeTierArgs = {
        task: taskDescription,
        provider: freeTierProvider,
        working_directory: actionConfig.working_directory || undefined,
      };
      if (actionConfig.tags) freeTierArgs.tags = actionConfig.tags;

      try {
        result = await handleToolCall('submit_task', freeTierArgs);
      } catch (err) {
        sendJson(res, { error: `Failed to create free-tier task: ${err.message}` }, 500, req);
        return;
      }
    } else {
      // No free-tier provider available — fall back to smart_submit_task with metadata hint
      taskArgs.task = taskArgs.task_description;
      delete taskArgs.task_description;
      taskArgs.free_tier_preferred = true;

      try {
        result = await handleToolCall('smart_submit_task', taskArgs);
      } catch (err) {
        sendJson(res, { error: `Failed to create task (no free-tier providers available): ${err.message}` }, 500, req);
        return;
      }
    }
  } else {
    // Standard routing via smart_submit_task
    try {
      result = await handleToolCall('smart_submit_task', taskArgs);
    } catch (err) {
      sendJson(res, { error: `Failed to create task: ${err.message}` }, 500, req);
      return;
    }
  }

  // Check for MCP structured errors (parity with main API route)
  if (result.isError) {
    sendJson(res, { error: result.content?.[0]?.text || 'Task creation failed', webhook: webhookName }, 400, req);
    return;
  }

  // Extract task_id from structured result field (preferred) or text fallback
  const taskId = result.__subscribe_task_id || null;

  if (deliveryId) {
    db.recordDelivery(deliveryId, webhookName, taskId);
  }

  // Record trigger
  try {
    db.recordWebhookTrigger(webhookName);
  } catch {
    // Non-fatal — task was already created
  }

  const responseBody = {
    success: true,
    task_id: taskId,
    webhook: webhookName,
    trigger_count: (webhook.trigger_count || 0) + 1,
  };
  if (isFreeTierTrigger) {
    responseBody.trigger_type = 'free_tier_task';
    responseBody.free_tier_provider = freeTierProvider || null;
  }

  sendJson(res, responseBody, 200, req);
}

module.exports = {
  handleInboundWebhook,
  verifyWebhookSignature,
  substitutePayload,
  setFreeTierTrackerGetter,
};
