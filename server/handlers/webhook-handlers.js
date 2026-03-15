/**
 * Webhook, notification, budget alert, and maintenance handlers
 * Extracted from tools.js
 */

const { v4: uuidv4 } = require('uuid');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const db = require('../database');
const serverConfig = require('../config');
const logger = require('../logger').child({ component: 'webhook-handlers' });
const { TASK_TIMEOUTS } = require('../constants');
const shared = require('./shared');
const { isInternalHost, isValidWebhookUrl, VALID_WEBHOOK_EVENTS, VALID_ALERT_TYPES,
        MAX_PAYLOAD_SIZE, MAX_RESPONSE_SIZE, MAX_NAME_LENGTH, MAX_URL_LENGTH, safeLimit,
        requireString, requireEnum, requireTask, stripUrlAuth,
        ErrorCodes, makeError } = shared;



// ============================================
// WEBHOOK HANDLERS
// ============================================

/**
 * Trigger webhooks for a task event with retry logic
 * Catches all errors internally to prevent unhandled rejections
 */
async function triggerWebhooks(event, task) {
  try {
    const project = task?.project || null;
    const webhooks = db.getWebhooksForEvent(event, project);

    for (const webhook of webhooks) {
      const maxRetries = webhook.retry_count || 3;
      try {
        await sendWebhook(webhook, event, task, 0, maxRetries);
      } catch (error) {
        logger.error(`Webhook ${webhook.id} initial delivery failed for event ${event}: ${error.message}`);
      }
    }
  } catch (outerErr) {
    // Catch any unexpected errors (e.g., db.getWebhooksForEvent failing)
    logger.error(`Webhook trigger error for event ${event}: ${outerErr.message}`);
  }
}


/**
 * Determine if a webhook error is retryable
 */
function isRetryableWebhookError(error) {
  const message = error?.message || '';
  // Retry on network errors, timeouts, and 5xx errors
  if (message.includes('timeout') || message.includes('ECONNRESET') ||
      message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') || message.includes('HTTP 5')) {
    return true;
  }
  // Don't retry on 4xx errors (client errors)
  if (message.includes('HTTP 4')) {
    return false;
  }
  // Default to retrying on unknown errors
  return true;
}


/**
 * Sanitize payload for logging - remove potentially sensitive data
 */
function sanitizePayloadForLog(payload) {
  if (!payload) return null;
  const sanitized = { ...payload };
  // Redact task description which may contain API keys or sensitive commands
  if (sanitized.task_description && sanitized.task_description.length > 200) {
    sanitized.task_description = sanitized.task_description.substring(0, 200) + '...[truncated]';
  }
  // Redact output which may contain sensitive data
  if (sanitized.output && sanitized.output.length > 500) {
    sanitized.output = sanitized.output.substring(0, 500) + '...[truncated]';
  }
  if (sanitized.error_output && sanitized.error_output.length > 500) {
    sanitized.error_output = sanitized.error_output.substring(0, 500) + '...[truncated]';
  }
  // Remove any fields that might contain secrets
  delete sanitized.env;
  delete sanitized.environment;
  delete sanitized.secret;
  delete sanitized.api_key;
  delete sanitized.token;
  return sanitized;
}


/**
 * Send a webhook notification
 */
async function sendWebhook(webhook, event, task, attempt = 0, maxRetries = 3) {
  const payload = buildPayload(webhook.type, event, task);
  const payloadStr = JSON.stringify(payload);

  // Validate payload size before sending
  if (payloadStr.length > MAX_PAYLOAD_SIZE) {
    const error = new Error(`Webhook payload exceeds maximum size (${payloadStr.length} > ${MAX_PAYLOAD_SIZE})`);
    db.logWebhookDelivery({
      webhookId: webhook.id,
      event,
      taskId: task?.id,
      payload: sanitizePayloadForLog(payload),
      responseStatus: null,
      responseBody: null,
      success: false,
      error: error.message,
      attempt,
      maxRetries,
      retryable: false,
    });
    throw error;
  }

  // Security: Blocklist of headers that cannot be overridden by user config
  const BLOCKED_HEADERS = new Set([
    'host', 'content-length', 'transfer-encoding', 'connection',
    'keep-alive', 'upgrade', 'http2-settings', 'te', 'trailer',
    'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
    'content-type', 'user-agent', 'x-webhook-event', 'x-webhook-signature'
  ]);

  // Filter user-supplied headers to prevent injection of sensitive headers
  const safeUserHeaders = {};
  if (webhook.headers && typeof webhook.headers === 'object') {
    for (const [key, value] of Object.entries(webhook.headers)) {
      const lowerKey = key.toLowerCase();
      // Block sensitive headers and validate header name/value
      if (!BLOCKED_HEADERS.has(lowerKey) &&
          /^[a-zA-Z0-9-]+$/.test(key) &&
          typeof value === 'string' &&
          value.length <= 8192 &&
          !/[\r\n]/.test(value)) {
        safeUserHeaders[key] = value;
      }
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'TORQUE-Webhook/1.0',
    'X-Webhook-Event': event,
    ...safeUserHeaders
  };

  // Add HMAC signature if secret is configured
  if (webhook.secret) {
    const signature = crypto
      .createHmac('sha256', webhook.secret)
      .update(payloadStr)
      .digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  return new Promise((resolve, reject) => {
    const url = new URL(webhook.url);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    // Security: SSRF protection - use centralized isInternalHost() check
    if (isInternalHost(webhook.url)) {
      const errorMsg = 'SSRF protection: internal/private hosts not allowed';
      db.logWebhookDelivery({
        webhookId: webhook.id,
        event,
        taskId: task?.id,
        payload: sanitizePayloadForLog(payload),
        responseStatus: null,
        responseBody: null,
        success: false,
        error: errorMsg,
        attempt,
        maxRetries,
        retryable: false,
      });
      return reject(new Error(errorMsg));
    }

    // Overall timeout covering DNS resolution + connection + request (Issue: DNS can hang indefinitely)
    const OVERALL_TIMEOUT_MS = 15000;
    const SOCKET_CONNECT_TIMEOUT_MS = 5000;
    let overallTimeoutId = null;
    let settled = false;
    let currentSocket = null; // Track socket for cleanup

    // Comprehensive cleanup function to prevent event listener leaks
    const cleanup = () => {
      if (overallTimeoutId) {
        clearTimeout(overallTimeoutId);
        overallTimeoutId = null;
      }
      // Clean up socket event listeners
      if (currentSocket) {
        currentSocket.removeAllListeners('timeout');
        currentSocket = null;
      }
      // Clean up request event listeners
      if (req) {
        req.removeAllListeners('socket');
        req.removeAllListeners('error');
        req.removeAllListeners('timeout');
      }
    };

    const safeReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const safeResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    // Set overall timeout to cover DNS + connection + request
    overallTimeoutId = setTimeout(() => {
      if (settled) return;
      if (req) {
        req.destroy();
      }
      db.logWebhookDelivery({
        webhookId: webhook.id,
        event,
        taskId: task?.id,
        payload: sanitizePayloadForLog(payload),
        responseStatus: null,
        responseBody: null,
        success: false,
        error: 'Overall request timeout (DNS/connection/request)',
        attempt,
        maxRetries,
        retryable: true,
      });
      safeReject(new Error('Overall request timeout (DNS/connection/request)'));
    }, OVERALL_TIMEOUT_MS);

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      timeout: TASK_TIMEOUTS.PROVIDER_CHECK,  // Socket inactivity timeout
      // Security: Explicitly enforce TLS certificate validation for HTTPS
      // This is the default, but making it explicit prevents accidental bypass
      rejectUnauthorized: isHttps ? true : undefined
    };

    const req = client.request(options, (res) => {
      let body = '';
      let responseTooLarge = false;

      res.on('data', chunk => {
        // Enforce response size limit to prevent memory exhaustion
        if (body.length + chunk.length > MAX_RESPONSE_SIZE) {
          responseTooLarge = true;
          body = body.substring(0, MAX_RESPONSE_SIZE);
          res.destroy(); // Stop receiving more data
          return;
        }
        body += chunk;
      });

      res.on('end', () => {
        const success = res.statusCode >= 200 && res.statusCode < 300 && !responseTooLarge;

        db.logWebhookDelivery({
          webhookId: webhook.id,
          event,
          taskId: task?.id,
          payload: sanitizePayloadForLog(payload),
          responseStatus: res.statusCode,
          responseBody: body.substring(0, 1000),
          success,
          error: responseTooLarge ? 'Response too large (truncated)' : (success ? null : `HTTP ${res.statusCode}`),
          attempt,
          maxRetries,
          retryable: isRetryableWebhookError(success ? null : new Error(`HTTP ${res.statusCode}`)),
        });

        if (responseTooLarge) {
          safeReject(new Error('Webhook response exceeded maximum size'));
        } else if (success) {
          safeResolve({ status: res.statusCode, body });
        } else {
          safeReject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
        }
      });
    });

    // Add socket connection timeout (handles slow TCP handshake)
    // Use .once() for socket event since we only need one socket per request
    req.once('socket', (socket) => {
      currentSocket = socket; // Track for cleanup
      socket.setTimeout(SOCKET_CONNECT_TIMEOUT_MS);
      // Use .once() for timeout since it should only fire once
      socket.once('timeout', () => {
        req.destroy();
        db.logWebhookDelivery({
          webhookId: webhook.id,
          event,
          taskId: task?.id,
          payload: sanitizePayloadForLog(payload),
          responseStatus: null,
          responseBody: null,
          success: false,
          error: 'Socket connection timeout',
          attempt,
          maxRetries,
          retryable: true,
        });
        safeReject(new Error('Socket connection timeout'));
      });
    });

    req.once('error', (error) => {
      db.logWebhookDelivery({
        webhookId: webhook.id,
        event,
        taskId: task?.id,
        payload: sanitizePayloadForLog(payload),
        responseStatus: null,
        responseBody: null,
        success: false,
        error: error.message,
        attempt,
        maxRetries,
        retryable: isRetryableWebhookError(error),
      });
      safeReject(error);
    });

    req.once('timeout', () => {
      req.destroy();
      db.logWebhookDelivery({
        webhookId: webhook.id,
        event,
        taskId: task?.id,
        payload: sanitizePayloadForLog(payload),
        responseStatus: null,
        responseBody: null,
        success: false,
        error: 'Socket inactivity timeout',
        attempt,
        maxRetries,
        retryable: true,
      });
      safeReject(new Error('Socket inactivity timeout'));
    });

    req.write(payloadStr);
    req.end();
  });
}

function executeWebhookDelivery({ webhookId, event, taskId, attempt = 0, maxRetries }) {
  const webhook = db.getWebhook(webhookId);
  if (!webhook) {
    return;
  }

  let resolvedEvent = event;
  let resolvedTaskId = taskId;
  let resolvedMaxRetries = Number.isFinite(maxRetries) ? maxRetries : webhook.retry_count || 3;
  if (resolvedMaxRetries <= 0) {
    resolvedMaxRetries = webhook.retry_count || 3;
  }

  if (!resolvedEvent || !resolvedTaskId) {
    const latestLog = db.getWebhookLogs(webhookId, 1).find(log => !log.success);
    if (latestLog) {
      resolvedEvent = resolvedEvent || latestLog.event;
      resolvedTaskId = resolvedTaskId || latestLog.task_id;
    }
  }

  if (!resolvedEvent) {
    return;
  }

  const task = resolvedTaskId ? db.getTask(resolvedTaskId) : null;

  sendWebhook(webhook, resolvedEvent, task, attempt, resolvedMaxRetries).catch((err) => {
    logger.debug('[webhook-handlers] async sendWebhook rejected during kickoff:', err.message || err);
  });
}

db.setWebhookDeliveryExecutor(executeWebhookDelivery);


/**
 * Build webhook payload based on type
 */
function buildPayload(type, event, task) {
  // Validate event is a string to prevent crashes on .toUpperCase()
  const safeEvent = typeof event === 'string' ? event : 'unknown';
  const duration = task && task.started_at
    ? Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000)
    : null;

  const basePayload = {
    event: safeEvent,
    timestamp: new Date().toISOString(),
    task: task ? {
      id: task.id,
      description: task.task_description?.substring(0, 200),
      status: task.status,
      project: task.project,
      progress: task.progress_percent,
      exit_code: task.exit_code,
      created_at: task.created_at,
      completed_at: task.completed_at
    } : null,
    notification: task ? {
      taskId: task.id,
      status: safeEvent,
      exitCode: task.exit_code ?? null,
      project: task.project || null,
      duration,
      description: (task.task_description || '').slice(0, 200),
    } : null,
  };

  switch (type) {
    case 'slack':
      return {
        text: `TORQUE Task ${safeEvent.toUpperCase()}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `Task ${safeEvent}` }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Task ID:*\n\`${task?.id?.substring(0, 8)}...\`` },
              { type: 'mrkdwn', text: `*Status:*\n${task?.status}` },
              { type: 'mrkdwn', text: `*Project:*\n${task?.project || 'Unknown'}` },
              { type: 'mrkdwn', text: `*Progress:*\n${task?.progress_percent || 0}%` }
            ]
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Description:*\n${task?.task_description?.substring(0, 200) || 'N/A'}` }
          }
        ]
      };

    case 'discord': {
      const color = safeEvent === 'completed' ? 0x00ff00 : safeEvent === 'failed' ? 0xff0000 : 0x0099ff;
      return {
        embeds: [{
          title: `Task ${safeEvent}`,
          color,
          fields: [
            { name: 'Task ID', value: `\`${task?.id?.substring(0, 8)}...\``, inline: true },
            { name: 'Status', value: task?.status || 'Unknown', inline: true },
            { name: 'Project', value: task?.project || 'Unknown', inline: true },
            { name: 'Progress', value: `${task?.progress_percent || 0}%`, inline: true },
            { name: 'Description', value: task?.task_description?.substring(0, 200) || 'N/A' }
          ],
          timestamp: new Date().toISOString()
        }]
      };
    }

    default: // 'http' - generic JSON
      return basePayload;
  }
}


/**
 * Add a new webhook
 */
function handleAddWebhook(args) {
  // Input validation
  const nameErr = requireString(args, 'name');
  if (nameErr) return nameErr;
  if (args.name.length > MAX_NAME_LENGTH) {
    return makeError(ErrorCodes.PARAM_TOO_LONG, `name must be ${MAX_NAME_LENGTH} characters or less`);
  }
  const urlErr = requireString(args, 'url');
  if (urlErr) return urlErr;
  if (args.url.length > MAX_URL_LENGTH) {
    return makeError(ErrorCodes.PARAM_TOO_LONG, `url must be ${MAX_URL_LENGTH} characters or less`);
  }
  const urlValidation = isValidWebhookUrl(args.url);
  if (!urlValidation.valid) {
    return makeError(ErrorCodes.INVALID_URL, `Invalid webhook URL: ${urlValidation.reason}`);
  }
  if (args.events !== undefined) {
    if (!Array.isArray(args.events)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'events must be an array');
    }
    for (const event of args.events) {
      if (!VALID_WEBHOOK_EVENTS.includes(event)) {
        return makeError(ErrorCodes.INVALID_PARAM, `Invalid event type: ${event}. Valid types: ${VALID_WEBHOOK_EVENTS.join(', ')}`);
      }
    }
  }
  if (args.type !== undefined && !['http', 'slack', 'discord'].includes(args.type)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'type must be "http", "slack", or "discord"');
  }

  const webhookId = uuidv4();

  const webhook = db.createWebhook({
    id: webhookId,
    name: args.name.trim(),
    url: args.url,
    type: args.type || 'http',
    events: args.events || ['completed', 'failed'],
    project: args.project || null,
    headers: args.headers || null,
    secret: args.secret || null,
    retryCount: 3
  });

  let result = `## Webhook Created\n\n`;
  result += `**ID:** \`${webhook.id}\`\n`;
  result += `**Name:** ${webhook.name}\n`;
  result += `**URL:** ${stripUrlAuth(webhook.url)}\n`;
  result += `**Type:** ${webhook.type}\n`;
  result += `**Events:** ${webhook.events.join(', ')}\n`;
  result += `**Project Filter:** ${webhook.project || 'All projects'}\n`;
  result += `**Secret:** ${webhook.secret ? 'Configured ✓' : 'Not set'}\n\n`;
  result += `Test with: \`test_webhook({webhook_id: "${webhook.id}"})\``;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * List webhooks
 */
function handleListWebhooks(args) {
  const webhooks = db.listWebhooks(args.project);

  if (webhooks.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Webhooks\n\nNo webhooks configured.\n\nAdd one with:\n\`\`\`\nadd_webhook({\n  name: "My Webhook",\n  url: "https://example.com/webhook",\n  events: ["completed", "failed"]\n})\n\`\`\``
      }]
    };
  }

  let result = `## Webhooks (${webhooks.length})\n\n`;
  result += `| Name | Type | Events | Project | Status | Success/Fail |\n`;
  result += `|------|------|--------|---------|--------|-------------|\n`;

  for (const w of webhooks) {
    result += `| ${w.name} | ${w.type} | ${w.events.join(', ')} | ${w.project || '*'} | ${w.enabled ? '✓' : '✗'} | ${w.success_count}/${w.failure_count} |\n`;
  }

  result += `\n### Webhook IDs\n`;
  for (const w of webhooks) {
    result += `- **${w.name}:** \`${w.id}\`\n`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Remove a webhook
 */
function handleRemoveWebhook(args) {
  const webhook = db.getWebhook(args.webhook_id);

  if (!webhook) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Webhook not found: ${args.webhook_id}`);
  }

  db.deleteWebhook(args.webhook_id);

  return {
    content: [{
      type: 'text',
      text: `## Webhook Removed\n\n**Name:** ${webhook.name}\n**ID:** \`${webhook.id}\``
    }]
  };
}


/**
 * Test a webhook by sending a test notification
 */
async function handleTestWebhook(args) {
  try {
  
  const webhook = db.getWebhook(args.webhook_id);

  if (!webhook) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Webhook not found: ${args.webhook_id}`);
  }
  

  const testTask = {
    id: 'test-' + Date.now(),
    task_description: 'This is a test webhook notification from TORQUE',
    status: 'completed',
    project: 'test',
    progress_percent: 100,
    exit_code: 0,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString()
  };

  try {
    const response = await sendWebhook(webhook, 'test', testTask);

    return {
      content: [{
        type: 'text',
        text: `## Webhook Test: SUCCESS ✓\n\n**Name:** ${webhook.name}\n**URL:** ${stripUrlAuth(webhook.url)}\n**Response Status:** ${response.status}\n\nWebhook is working correctly!`
      }]
    };
  } catch (error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `## Webhook Test: FAILED ✗\n\n**Name:** ${webhook.name}\n**URL:** ${stripUrlAuth(webhook.url)}\n**Error:** ${error.message}\n\nCheck the URL and try again.`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Get webhook delivery logs
 */
function handleWebhookLogs(args) {
  const webhook = db.getWebhook(args.webhook_id);

  if (!webhook) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Webhook not found: ${args.webhook_id}`);
  }

  const logs = db.getWebhookLogs(args.webhook_id, safeLimit(args.limit, 20));

  if (logs.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Webhook Logs: ${webhook.name}\n\nNo delivery logs found. Webhook hasn't been triggered yet.`
      }]
    };
  }

  let result = `## Webhook Logs: ${webhook.name}\n\n`;
  result += `| Time | Event | Task | Status | Result |\n`;
  result += `|------|-------|------|--------|--------|\n`;

  for (const log of logs) {
    const time = new Date(log.triggered_at).toLocaleString();
    result += `| ${time} | ${log.event} | ${log.task_id?.substring(0, 8) || '-'}... | ${log.response_status || 'ERR'} | ${log.success ? '✓' : '✗ ' + (log.error || '')} |\n`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Get webhook statistics
 */
function handleWebhookStats(_args) {
  const stats = db.getWebhookStats();

  let result = `## Webhook Statistics\n\n`;
  result += `### Webhooks\n`;
  result += `- **Total:** ${stats.webhooks.total}\n`;
  result += `- **Active:** ${stats.webhooks.active}\n\n`;
  result += `### Deliveries (24h)\n`;
  result += `- **Total:** ${stats.deliveries_24h.total}\n`;
  result += `- **Successful:** ${stats.deliveries_24h.successful}\n`;
  result += `- **Failed:** ${stats.deliveries_24h.failed}\n`;

  if (stats.deliveries_24h.total > 0) {
    const successRate = ((stats.deliveries_24h.successful / stats.deliveries_24h.total) * 100).toFixed(1);
    result += `- **Success Rate:** ${successRate}%`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


// ============ Phase 1: Smart Automation Core Handlers ============

/**
 * Configure retry policy
 */
function handleConfigureRetries(args) {
  if (args.task_id) {
    // Configure specific task
    const { error: taskErr } = requireTask(db, args.task_id);
    if (taskErr) return taskErr;

    const task = db.configureTaskRetry(args.task_id, {
      max_retries: args.max_retries,
      retry_strategy: args.strategy,
      retry_delay_seconds: args.base_delay_seconds
    });

    return {
      content: [{
        type: 'text',
        text: `Retry policy configured for task ${args.task_id}:\n` +
          `- Max retries: ${task.max_retries}\n` +
          `- Strategy: ${task.retry_strategy}\n` +
          `- Base delay: ${task.retry_delay_seconds}s`
      }]
    };
  } else {
    // Set defaults
    if (args.max_retries !== undefined) {
      db.setConfig('default_max_retries', String(args.max_retries));
    }
    if (args.strategy) {
      db.setConfig('default_retry_strategy', args.strategy);
    }
    if (args.base_delay_seconds !== undefined) {
      db.setConfig('default_retry_delay', String(args.base_delay_seconds));
    }

    return {
      content: [{
        type: 'text',
        text: `Default retry policy updated:\n` +
          `- Max retries: ${serverConfig.get('default_max_retries') || '0'}\n` +
          `- Strategy: ${serverConfig.get('default_retry_strategy') || 'exponential'}\n` +
          `- Base delay: ${serverConfig.get('default_retry_delay') || '30'}s`
      }]
    };
  }
}


/**
 * Get retry history
 */
function handleGetRetryHistory(args) {
  const { task_id, limit = 50 } = args;

  let history;
  if (task_id) {
    history = db.getRetryAttempts(task_id);
  } else {
    // Get all recent retry attempts by querying the retry_attempts table directly
    // For now, return empty if no task_id specified
    return {
      content: [{
        type: 'text',
        text: `## Retry History\n\nPlease specify a task_id to view retry history.`
      }]
    };
  }

  // Apply limit
  if (history.length > limit) {
    history = history.slice(0, limit);
  }

  if (history.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Retry History\n\nNo retry attempts found for task ${task_id}.`
      }]
    };
  }

  let output = `## Retry History for ${task_id}\n\n`;
  history.forEach(h => {
    output += `- **Task:** ${h.task_id} → **Retry Task:** ${h.retry_task_id || 'N/A'}\n`;
    output += `  Rule: ${h.rule_id} | Outcome: ${h.outcome || 'pending'} | ${h.attempted_at}\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Add a budget alert
 */
function handleAddBudgetAlert(args) {
  // Input validation
  const alertErr = requireEnum(args, 'alert_type', VALID_ALERT_TYPES);
  if (alertErr) return alertErr;
  if (args.threshold_value === undefined || typeof args.threshold_value !== 'number') {
    return makeError(ErrorCodes.INVALID_PARAM, 'threshold_value must be a number');
  }
  if (args.threshold_value <= 0) {
    return makeError(ErrorCodes.INVALID_PARAM, 'threshold_value must be a positive number');
  }
  if (args.threshold_percent !== undefined) {
    if (typeof args.threshold_percent !== 'number' || args.threshold_percent < 0 || args.threshold_percent > 100) {
      return makeError(ErrorCodes.INVALID_PARAM, 'threshold_percent must be a number between 0 and 100');
    }
  }
  if (args.cooldown_minutes !== undefined && (typeof args.cooldown_minutes !== 'number' || args.cooldown_minutes < 1)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'cooldown_minutes must be a positive number');
  }

  const alertId = uuidv4();

  const alert = db.createBudgetAlert({
    id: alertId,
    alert_type: args.alert_type,
    threshold_value: args.threshold_value,
    threshold_percent: args.threshold_percent ?? 80,
    project: args.project || null,
    webhook_id: args.webhook_id || null,
    cooldown_minutes: args.cooldown_minutes ?? 60
  });

  return {
    content: [{
      type: 'text',
      text: `Budget alert created!\n` +
        `- **ID:** ${alertId}\n` +
        `- **Type:** ${alert.alert_type}\n` +
        `- **Threshold:** ${alert.threshold_value} (alert at ${alert.threshold_percent}%)\n` +
        `- **Project:** ${alert.project || 'All projects'}\n` +
        `- **Cooldown:** ${alert.cooldown_minutes} minutes`
    }]
  };
}


/**
 * List budget alerts
 */
function handleListBudgetAlerts(args) {
  const alerts = db.listBudgetAlerts({
    project: args.project,
    alert_type: args.alert_type
  });

  if (alerts.length === 0) {
    return { content: [{ type: 'text', text: 'No budget alerts configured.' }] };
  }

  let result = `## Budget Alerts\n\n`;
  result += `| ID | Type | Threshold | Alert At | Project | Status |\n`;
  result += `|----|------|-----------|----------|---------|--------|\n`;

  for (const a of alerts) {
    result += `| ${a.id.substring(0, 8)}... | ${a.alert_type} | ${a.threshold_value} | ${a.threshold_percent}% | ${a.project || 'All'} | ${a.enabled ? '✓' : '✗'} |\n`;
  }

  return { content: [{ type: 'text', text: result }] };
}


/**
 * Remove a budget alert
 */
function handleRemoveBudgetAlert(args) {
  const deleted = db.deleteBudgetAlert(args.alert_id);

  if (!deleted) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Budget alert not found: ${args.alert_id}`);
  }

  return { content: [{ type: 'text', text: `Budget alert ${args.alert_id} deleted.` }] };
}


/**
 * Configure auto cleanup
 */
function getAutoArchiveStatuses() {
  const raw = serverConfig.get('auto_archive_status');
  if (!raw) return ['completed', 'failed', 'cancelled'];

  const parsed = db.safeJsonParse(raw, null);
  if (Array.isArray(parsed)) return parsed;

  const fromCsv = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return fromCsv.length > 0 ? fromCsv : ['completed', 'failed', 'cancelled'];
}

function handleConfigureAutoCleanup(args) {
  if (args.auto_archive_days !== undefined) {
    db.setConfig('auto_archive_days', String(args.auto_archive_days));
  }
  if (args.auto_archive_status) {
    db.setConfig('auto_archive_status', JSON.stringify(args.auto_archive_status));
  }
  if (args.cleanup_log_days !== undefined) {
    db.setConfig('cleanup_log_days', String(args.cleanup_log_days));
  }

  const config = {
    auto_archive_days: serverConfig.get('auto_archive_days'),
    auto_archive_status: serverConfig.get('auto_archive_status'),
    cleanup_log_days: serverConfig.get('cleanup_log_days')
  };

  return {
    content: [{
      type: 'text',
      text: `## Auto-Cleanup Configuration\n\n` +
        `- **Archive tasks older than:** ${config.auto_archive_days} days ${config.auto_archive_days === '0' ? '(disabled)' : ''}\n` +
        `- **Archive statuses:** ${config.auto_archive_status}\n` +
        `- **Delete logs older than:** ${config.cleanup_log_days} days ${config.cleanup_log_days === '0' ? '(disabled)' : ''}`
    }]
  };
}


/**
 * Run maintenance tasks
 */
function handleRunMaintenance(args) {
  const results = [];
  const taskType = args.task_type || 'all';

  // Handle schedule configuration
  if (args.schedule) {
    const scheduleId = 'maintenance-' + (taskType === 'all' ? 'full' : taskType);
    db.setMaintenanceSchedule({
      id: scheduleId,
      task_type: taskType,
      schedule_type: 'interval',
      interval_minutes: args.schedule.interval_minutes || 60,
      enabled: args.schedule.enabled !== false
    });

    return {
      content: [{
        type: 'text',
        text: `Maintenance scheduled:\n` +
          `- Task: ${taskType}\n` +
          `- Interval: ${args.schedule.interval_minutes || 60} minutes\n` +
          `- Enabled: ${args.schedule.enabled !== false ? 'Yes' : 'No'}`
      }]
    };
  }

  // Run maintenance immediately
  if (taskType === 'all' || taskType === 'archive_old_tasks') {
    const days = serverConfig.getInt('auto_archive_days', 0);
    if (days > 0) {
      const statuses = getAutoArchiveStatuses();
      const archived = db.archiveTasks({ days_old: days, statuses });
      results.push(`Archived ${archived} old tasks`);
    } else {
      results.push('Archive: skipped (disabled)');
    }
  }

  if (taskType === 'all' || taskType === 'cleanup_logs') {
    const days = serverConfig.getInt('cleanup_log_days', 0);
    if (days > 0) {
      db.cleanupHealthHistory(days * 24);
      db.cleanupWebhookLogs(days);
      results.push(`Cleaned up logs older than ${days} days`);
    } else {
      results.push('Log cleanup: skipped (disabled)');
    }
  }

  if (taskType === 'all' || taskType === 'aggregate_metrics') {
    const metrics = db.aggregateSuccessMetrics('day');
    results.push(`Aggregated metrics for ${metrics.length} projects`);
  }

  return {
    content: [{
      type: 'text',
      text: `## Maintenance Results\n\n` + results.map(r => `- ${r}`).join('\n')
    }]
  };
}


/**
 * Send Slack notification
 */
async function handleNotifySlack(args) {
  try {
  
  const { channel, message, task_id, blocks } = args;
  

  // Input validation
  const err = requireString(args, 'message');
  if (err) return err;

  // Get Slack integration config
  const integration = db.getEnabledIntegration('slack');
  if (!integration) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'Slack integration not configured. Use configure_integration first.');
  }

  const webhookUrl = integration.config.webhook_url;
  if (!webhookUrl) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Slack webhook URL not configured');
  }

  // Build message
  let text = message;
  if (task_id) {
    const task = db.getTask(task_id);
    if (task) {
      text += `\n\n*Task:* \`${task_id}\`\n*Status:* ${task.status}`;
    }
  }

  const payload = {
    channel: channel || integration.config.default_channel,
    text,
    blocks: blocks || undefined
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Failed to send Slack notification: Slack API error: ${response.status}`);
    }

    return {
      content: [{ type: 'text', text: `## Slack Notification Sent\n\n**Channel:** ${payload.channel || 'default'}\n**Message:** ${message.substring(0, 100)}...` }]
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to send Slack notification: ${err.message}`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Send Discord notification
 */
async function handleNotifyDiscord(args) {
  try {
  
  const { message, task_id, embed } = args;
  

  // Input validation
  const err = requireString(args, 'message');
  if (err) return err;

  // Get Discord integration config
  const integration = db.getEnabledIntegration('discord');
  if (!integration) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'Discord integration not configured. Use configure_integration first.');
  }

  const webhookUrl = integration.config.webhook_url;
  if (!webhookUrl) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Discord webhook URL not configured');
  }

  // Build message
  let content = message;
  if (task_id) {
    const task = db.getTask(task_id);
    if (task) {
      content += `\n\n**Task:** \`${task_id}\`\n**Status:** ${task.status}`;
    }
  }

  const payload = {
    content,
    embeds: embed ? [embed] : undefined
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Failed to send Discord notification: Discord API error: ${response.status}`);
    }

    return {
      content: [{ type: 'text', text: `## Discord Notification Sent\n\n**Message:** ${message.substring(0, 100)}...` }]
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to send Discord notification: ${err.message}`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

/**
 * Quick-setup convenience handler: creates a Slack or Discord webhook
 * with sensible defaults in a single call.
 */
function handleQuickSetupNotifications(args) {
  const urlErr = requireString(args, 'webhook_url');
  if (urlErr) return urlErr;
  const url = args.webhook_url;
  const type = (args.type || '').toLowerCase();

  // Auto-detect type from URL if not specified
  let webhookType = type;
  if (!webhookType) {
    if (url.includes('hooks.slack.com') || url.includes('slack.com/api')) {
      webhookType = 'slack';
    } else if (url.includes('discord.com/api/webhooks') || url.includes('discordapp.com')) {
      webhookType = 'discord';
    } else {
      webhookType = 'http';
    }
  }

  if (!['slack', 'discord', 'http'].includes(webhookType)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid type: ${webhookType}. Use slack, discord, or http.`);
  }

  const name = args.name || `${webhookType}-notifications`;
  const events = args.events || ['completed', 'failed'];
  const project = args.project || null;

  // Validate events
  for (const e of events) {
    if (!VALID_WEBHOOK_EVENTS.includes(e) && e !== '*') {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid event: ${e}. Valid: ${VALID_WEBHOOK_EVENTS.join(', ')}, *`);
    }
  }

  // Delegate to handleAddWebhook
  const result = handleAddWebhook({
    name,
    url,
    type: webhookType,
    events,
    project,
  });

  // Also configure as integration if Slack/Discord
  if (webhookType === 'slack' || webhookType === 'discord') {
    try {
      db.upsertIntegration(webhookType, { webhook_url: url }, true);
    } catch (err) {
      // Integration config is best-effort — webhook still works via triggerWebhooks
      logger.debug('[webhook-handlers] non-critical error updating webhook integration:', err.message || err);
    }
  }

  return result;
}

// ── Unified webhook dispatcher (Phase 3.2 consolidation) ──

const inboundHandlers = require('./inbound-webhook-handlers');

const MANAGE_WEBHOOK_DISPATCH = {
  add:             (args) => handleAddWebhook(args),
  list:            (args) => handleListWebhooks(args),
  remove:          (args) => handleRemoveWebhook(args),
  test:            (args) => handleTestWebhook(args),
  logs:            (args) => handleWebhookLogs(args),
  stats:           (args) => handleWebhookStats(args),
  quick_setup:     (args) => handleQuickSetupNotifications(args),
  notify_slack:    (args) => handleNotifySlack(args),
  notify_discord:  (args) => handleNotifyDiscord(args),
  create_inbound:  (args) => inboundHandlers.handleCreateInboundWebhook(args),
  list_inbound:    (args) => inboundHandlers.handleListInboundWebhooks(args),
  delete_inbound:  (args) => inboundHandlers.handleDeleteInboundWebhook(args),
};

async function handleManageWebhook(args) {
  try {
    const { action } = args;
    if (!action) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'action is required for manage_webhook');
    const dispatcher = MANAGE_WEBHOOK_DISPATCH[action];
    if (!dispatcher) {
      const validActions = Object.keys(MANAGE_WEBHOOK_DISPATCH).join(', ');
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown action: ${action}. Valid: ${validActions}`);
    }
    return await dispatcher(args);
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, `manage_webhook failed: ${err.message}`);
  }
}

module.exports = {
  triggerWebhooks,
  sendWebhook,
  handleAddWebhook,
  handleListWebhooks,
  handleRemoveWebhook,
  handleTestWebhook,
  handleWebhookLogs,
  handleWebhookStats,
  handleConfigureRetries,
  handleGetRetryHistory,
  handleAddBudgetAlert,
  handleListBudgetAlerts,
  handleRemoveBudgetAlert,
  handleConfigureAutoCleanup,
  handleRunMaintenance,
  handleNotifySlack,
  handleNotifyDiscord,
  handleQuickSetupNotifications,
  handleManageWebhook
};
