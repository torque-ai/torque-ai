'use strict';

/**
 * Inbound Webhooks Module
 *
 * CRUD operations for inbound webhook triggers that create tasks
 * when external services (GitHub, GitLab, generic) POST to TORQUE.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const crypto = require('crypto');
const credCrypto = require('../utils/credential-crypto');
const { safeJsonParse } = require('../utils/json');

let db;

function setDb(dbInstance) { db = dbInstance; }

/**
 * Encrypt a webhook secret for storage using ENC: prefix pattern.
 * @param {string} secret - Plaintext secret
 * @returns {string} Encrypted string with ENC: prefix, or plaintext on failure
 */
function encryptSecret(secret) {
  if (!secret || secret.startsWith('ENC:')) return secret;
  try {
    const encKey = credCrypto.getOrCreateKey();
    const { encrypted_value, iv, auth_tag } = credCrypto.encrypt(secret, encKey);
    return `ENC:${encrypted_value}:${iv}:${auth_tag}`;
  } catch {
    return secret; // Fall back to plaintext if encryption unavailable
  }
}

/**
 * Decrypt a webhook secret from storage using ENC: prefix pattern.
 * @param {string} storedSecret - Stored secret (may be ENC: prefixed or plaintext)
 * @returns {string} Decrypted plaintext secret
 */
function decryptSecret(storedSecret) {
  if (!storedSecret || !storedSecret.startsWith('ENC:')) return storedSecret;
  try {
    const encKey = credCrypto.getOrCreateKey();
    const parts = storedSecret.slice(4).split(':');
    if (parts.length === 3) {
      return credCrypto.decrypt(parts[0], parts[1], parts[2], encKey);
    }
  } catch {
    // Fall through to return raw value
  }
  return storedSecret;
}

/**
 * Create a new inbound webhook
 * @param {Object} params
 * @param {string} params.name - Unique name for the webhook
 * @param {string} [params.source_type='generic'] - Source type: generic, github, gitlab
 * @param {string} params.secret - HMAC secret for signature verification
 * @param {Object|string} params.action_config - Task creation config (JSON stringified)
 * @returns {Object} The created webhook row
 */
function createInboundWebhook({ name, source_type = 'generic', secret, action_config }) {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const actionConfigStr = typeof action_config === 'string' ? action_config : JSON.stringify(action_config);

  const stmt = db.prepare(`
    INSERT INTO inbound_webhooks (id, name, source_type, secret, action_config, enabled, trigger_count, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?)
  `);

  // SECURITY: encrypt secret before storing
  const encryptedSecret = encryptSecret(secret);
  stmt.run(id, name, source_type, encryptedSecret, actionConfigStr, created_at);
  return getInboundWebhook(name);
}

/**
 * Get an inbound webhook by name
 * @param {string} name
 * @returns {Object|null}
 */
function getInboundWebhook(name) {
  const stmt = db.prepare('SELECT * FROM inbound_webhooks WHERE name = ?');
  const row = stmt.get(name);
  if (!row) return null;

  return {
    ...row,
    secret: decryptSecret(row.secret),
    action_config: safeJsonParse(row.action_config, {}),
    enabled: !!row.enabled,
  };
}

/**
 * List all inbound webhooks
 * @returns {Array}
 */
function listInboundWebhooks() {
  const stmt = db.prepare('SELECT * FROM inbound_webhooks ORDER BY created_at DESC');
  const rows = stmt.all();

  return rows.map(row => ({
    ...row,
    secret: row.secret ? '••••••••' : null,
    action_config: safeJsonParse(row.action_config, {}),
    enabled: !!row.enabled,
  }));
}

/**
 * Delete an inbound webhook by name
 * @param {string} name
 * @returns {boolean} true if deleted
 */
function deleteInboundWebhook(name) {
  const stmt = db.prepare('DELETE FROM inbound_webhooks WHERE name = ?');
  const result = stmt.run(name);
  return result.changes > 0;
}

/**
 * Record a webhook trigger (updates last_triggered_at and increments trigger_count)
 * @param {string} name
 * @returns {boolean} true if updated
 */
function recordWebhookTrigger(name) {
  const stmt = db.prepare(`
    UPDATE inbound_webhooks
    SET last_triggered_at = ?, trigger_count = trigger_count + 1
    WHERE name = ?
  `);
  const result = stmt.run(new Date().toISOString(), name);
  return result.changes > 0;
}

function checkDeliveryExists(deliveryId) {
  return db.prepare('SELECT delivery_id, task_id FROM webhook_deliveries WHERE delivery_id = ?').get(deliveryId);
}

function recordDelivery(deliveryId, webhookName, taskId) {
  db.prepare('INSERT OR IGNORE INTO webhook_deliveries (delivery_id, webhook_name, task_id) VALUES (?, ?, ?)').run(deliveryId, webhookName, taskId || null);
}

function cleanupOldDeliveries(maxAgeDays = 7) {
  return db.prepare("DELETE FROM webhook_deliveries WHERE received_at < datetime('now', '-' || ? || ' days')").run(maxAgeDays);
}

module.exports = {
  setDb,
  createInboundWebhook,
  getInboundWebhook,
  listInboundWebhooks,
  deleteInboundWebhook,
  recordWebhookTrigger,
  checkDeliveryExists,
  recordDelivery,
  cleanupOldDeliveries,
};
