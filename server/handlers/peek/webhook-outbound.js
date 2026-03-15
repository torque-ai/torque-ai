'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const db = require('../../database');
const logger = require('../../logger').child({ component: 'peek-webhook-outbound' });
const { isInternalHost } = require('../shared');

const WEBHOOK_TIMEOUT_MS = 10000;
const BLOCKED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'http2-settings',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'content-type',
  'user-agent',
  'x-webhook-event',
  'x-webhook-signature',
  'x-torque-signature',
]);

const PEEK_WEBHOOK_EVENTS = Object.freeze([
  'peek.recovery.executed',
  'peek.bundle.created',
  'peek.compliance.generated',
]);

function computeHmacSignature(payload, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return `sha256=${hmac.digest('hex')}`;
}

function buildWebhookPayload(event, data) {
  return {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
}

function eventSubscriptionMatches(subscription, event) {
  if (typeof subscription !== 'string') {
    return false;
  }

  const normalizedSubscription = subscription.trim();
  if (!normalizedSubscription) {
    return false;
  }

  if (normalizedSubscription === '*' || normalizedSubscription === event) {
    return true;
  }

  if (!normalizedSubscription.endsWith('.*')) {
    return false;
  }

  return event.startsWith(normalizedSubscription.slice(0, -1));
}

function webhookMatchesEvent(webhook, event) {
  if (!webhook || webhook.enabled === false) {
    return false;
  }

  const events = Array.isArray(webhook.events) ? webhook.events : [];
  return events.some((subscription) => eventSubscriptionMatches(subscription, event));
}

function getSubscribedPeekWebhooks(event) {
  if (typeof db.listWebhooks === 'function') {
    const webhooks = db.listWebhooks();
    return Array.isArray(webhooks)
      ? webhooks.filter((webhook) => webhookMatchesEvent(webhook, event))
      : [];
  }

  if (typeof db.getWebhooksForEvent === 'function') {
    const webhooks = db.getWebhooksForEvent(event);
    return Array.isArray(webhooks)
      ? webhooks.filter((webhook) => webhookMatchesEvent(webhook, event))
      : [];
  }

  return [];
}

function buildSafeHeaders(headers) {
  const safeHeaders = {};
  if (!headers || typeof headers !== 'object') {
    return safeHeaders;
  }

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = String(key).toLowerCase();
    if (BLOCKED_HEADERS.has(lowerKey)) {
      continue;
    }
    if (!/^[a-zA-Z0-9-]+$/.test(key)) {
      continue;
    }
    if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) {
      continue;
    }

    safeHeaders[key] = value;
  }

  return safeHeaders;
}

function logWebhookDelivery(details) {
  if (typeof db.logWebhookDelivery !== 'function') {
    return;
  }

  try {
    db.logWebhookDelivery(details);
  } catch (error) {
    logger.debug(`Webhook delivery log failed for ${details?.webhookId || 'unknown'}: ${error.message}`);
  }
}

function dispatchWebhook(webhook, event, payload, payloadStr) {
  const taskId = payload?.data?.task_id || null;

  try {
    if (isInternalHost(webhook.url)) {
      const errorMessage = 'SSRF protection: internal/private hosts not allowed';
      logWebhookDelivery({
        webhookId: webhook.id,
        event,
        taskId,
        payload,
        responseStatus: null,
        responseBody: null,
        success: false,
        error: errorMessage,
      });
      logger.warn(`Webhook delivery blocked for ${webhook.id}: ${errorMessage}`);
      return;
    }

    const url = new URL(webhook.url);
    const client = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'TORQUE-Peek-Webhook/1.0',
      'X-Webhook-Event': event,
      ...buildSafeHeaders(webhook.headers),
    };

    if (webhook.secret) {
      const signature = computeHmacSignature(payloadStr, webhook.secret);
      headers['X-Torque-Signature'] = signature;
      headers['X-Webhook-Signature'] = signature;
    }

    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(payloadStr),
        },
        timeout: WEBHOOK_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          logWebhookDelivery({
            webhookId: webhook.id,
            event,
            taskId,
            payload,
            responseStatus: res.statusCode || null,
            responseBody: null,
            success: Number(res.statusCode || 0) < 400,
            error: Number(res.statusCode || 0) >= 400 ? `HTTP ${res.statusCode}` : null,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });

    req.on('error', (error) => {
      logger.warn(`Webhook delivery failed for ${webhook.id}: ${error.message}`);
      logWebhookDelivery({
        webhookId: webhook.id,
        event,
        taskId,
        payload,
        responseStatus: null,
        responseBody: null,
        success: false,
        error: error.message,
      });
    });

    req.write(payloadStr);
    req.end();
  } catch (error) {
    logger.warn(`Webhook fire error for ${webhook?.id || 'unknown'}: ${error.message}`);
    logWebhookDelivery({
      webhookId: webhook?.id || null,
      event,
      taskId,
      payload,
      responseStatus: null,
      responseBody: null,
      success: false,
      error: error.message,
    });
  }
}

async function fireWebhookForEvent(event, data) {
  if (!PEEK_WEBHOOK_EVENTS.includes(event)) {
    logger.warn(`Unknown peek webhook event: ${event}`);
    return { fired: 0 };
  }

  let webhooks = [];
  try {
    webhooks = getSubscribedPeekWebhooks(event);
  } catch (error) {
    logger.warn(`Failed to list webhooks for ${event}: ${error.message}`);
    return { fired: 0, error: error.message };
  }

  if (webhooks.length === 0) {
    return { fired: 0 };
  }

  const payload = buildWebhookPayload(event, data);
  const payloadStr = JSON.stringify(payload);

  for (const webhook of webhooks) {
    setImmediate(() => {
      dispatchWebhook(webhook, event, payload, payloadStr);
    });
  }

  return { fired: webhooks.length };
}

module.exports = {
  PEEK_WEBHOOK_EVENTS,
  computeHmacSignature,
  buildWebhookPayload,
  fireWebhookForEvent,
};
