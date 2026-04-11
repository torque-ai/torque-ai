'use strict';

const eventBus = require('../event-bus');
const { triggerWebhooks } = require('../handlers/webhook-handlers');
const logger = require('../logger').child({ component: 'factory-notifications' });

let digestBuffer = new Map(); // project_id -> [events]
let digestInterval = null;

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
  notify,
  getDigest,
  flushAllDigests,
  startDigestTimer,
  stopDigestTimer,
  listChannels,
};
