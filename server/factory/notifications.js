'use strict';

const eventBus = require('../event-bus');
const { triggerWebhooks } = require('../handlers/webhook-handlers');
const logger = require('../logger').child({ component: 'factory-notifications' });

let digestBuffer = new Map(); // project_id -> [events]
let digestInterval = null;

const ALERT_TYPES = Object.freeze({
  VERIFY_FAIL_STREAK: 'VERIFY_FAIL_STREAK',
  FACTORY_STALLED: 'FACTORY_STALLED',
  FACTORY_IDLE: 'FACTORY_IDLE',
});

function normalizeAlertKeyPart(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function dedupeAlertKey(alert_type, scope = {}) {
  const alertType = normalizeAlertKeyPart(alert_type) || 'UNKNOWN_ALERT';
  const projectId = normalizeAlertKeyPart(scope.project_id) || 'unknown-project';
  const keyParts = [alertType, `project:${projectId}`];

  for (const field of ['instance_id', 'work_item_id', 'batch_id', 'stage']) {
    const value = normalizeAlertKeyPart(scope[field]);
    if (value) {
      keyParts.push(`${field}:${value}`);
    }
  }

  return keyParts.join('|');
}

function notifyFactoryAlert(alert_type, { project_id, data = {}, key_scope = {} } = {}) {
  const alert_key = dedupeAlertKey(alert_type, { project_id, ...key_scope });
  const payload = {
    ...data,
    alert_type,
    alert_key,
    dedupe_key: alert_key,
  };

  notify({
    project_id,
    event_type: alert_type,
    data: payload,
  });

  return payload;
}

function notifyVerifyFailStreak({
  project_id,
  streak_count,
  threshold,
  work_item_id,
  batch_id,
  instance_id,
  last_failure_at,
  reason,
} = {}) {
  return notifyFactoryAlert(ALERT_TYPES.VERIFY_FAIL_STREAK, {
    project_id,
    key_scope: { work_item_id, batch_id, instance_id },
    data: {
      streak_count,
      threshold,
      work_item_id,
      batch_id,
      instance_id,
      last_failure_at,
      reason,
    },
  });
}

function notifyFactoryStalled({
  project_id,
  stalled_minutes,
  threshold_minutes,
  stage,
  instance_id,
  batch_id,
  last_action_at,
  reason,
} = {}) {
  return notifyFactoryAlert(ALERT_TYPES.FACTORY_STALLED, {
    project_id,
    key_scope: { stage, instance_id, batch_id },
    data: {
      stalled_minutes,
      threshold_minutes,
      stage,
      instance_id,
      batch_id,
      last_action_at,
      reason,
    },
  });
}

function notifyFactoryIdle({
  project_id,
  idle_minutes,
  threshold_minutes,
  last_action_at,
  reason,
} = {}) {
  return notifyFactoryAlert(ALERT_TYPES.FACTORY_IDLE, {
    project_id,
    data: {
      idle_minutes,
      threshold_minutes,
      last_action_at,
      reason,
    },
  });
}

function notify({ project_id, event_type, data = {} } = {}) {
  const timestamp = new Date().toISOString();

  eventBus.emitTaskEvent({
    type: 'factory_notification',
    project_id,
    event_type,
    data,
    timestamp,
  });

  triggerWebhooks(`factory_${event_type}`, {
    project_id,
    event_type,
    ...data,
  }).catch((err) => logger.warn('Webhook delivery failed', { err, event_type }));

  const events = digestBuffer.get(project_id) || [];
  events.push({ event_type, data, timestamp });
  digestBuffer.set(project_id, events);

  logger.debug('Factory notification dispatched', {
    project_id,
    event_type,
    channels: listChannels(),
  });
}

function getDigest(project_id) {
  const events = digestBuffer.get(project_id) || [];
  digestBuffer.delete(project_id);

  return {
    project_id,
    events: [...events],
    generated_at: new Date().toISOString(),
  };
}

function flushAllDigests() {
  const pendingDigests = digestBuffer;
  digestBuffer = new Map();

  let flushedProjects = 0;
  for (const [project_id, events] of pendingDigests.entries()) {
    eventBus.emitTaskEvent({
      type: 'factory_digest',
      project_id,
      event_count: events.length,
      timestamp: new Date().toISOString(),
    });
    flushedProjects += 1;
  }

  return flushedProjects;
}

function startDigestTimer(intervalMs = 3600000) {
  stopDigestTimer();
  digestInterval = setInterval(() => {
    flushAllDigests();
  }, intervalMs);
  return digestInterval;
}

function stopDigestTimer() {
  if (digestInterval) {
    clearInterval(digestInterval);
    digestInterval = null;
  }
}

function listChannels() {
  return ['sse', 'webhook', 'digest'];
}

module.exports = {
  ALERT_TYPES,
  dedupeAlertKey,
  notify,
  notifyVerifyFailStreak,
  notifyFactoryStalled,
  notifyFactoryIdle,
  getDigest,
  flushAllDigests,
  startDigestTimer,
  stopDigestTimer,
  listChannels,
};
