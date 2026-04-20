'use strict';

const eventBus = require('../event-bus');
const { triggerWebhooks } = require('../handlers/webhook-handlers');
const logger = require('../logger').child({ component: 'factory-notifications' });

let digestBuffer = new Map(); // project_id -> [events]
let digestInterval = null;
let verifyFailStreaks = new Map(); // project_id|instance_id -> runtime streak state
let factoryStallAlerts = new Map(); // alert_key -> last progress signature

const ALERT_TYPES = Object.freeze({
  VERIFY_FAIL_STREAK: 'VERIFY_FAIL_STREAK',
  FACTORY_STALLED: 'FACTORY_STALLED',
  FACTORY_IDLE: 'FACTORY_IDLE',
});
const VERIFY_FAIL_STREAK_THRESHOLD = 3;
const FACTORY_STALL_THRESHOLD_MS = 30 * 60 * 1000;

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

function verifyFailStreakKey({ project_id, instance_id } = {}) {
  const projectId = normalizeAlertKeyPart(project_id) || 'unknown-project';
  const instanceId = normalizeAlertKeyPart(instance_id) || 'project';
  return `${projectId}|${instanceId}`;
}

function clearVerifyFailStreak({ project_id, instance_id } = {}) {
  const projectId = normalizeAlertKeyPart(project_id);
  const instanceId = normalizeAlertKeyPart(instance_id);
  if (!projectId) {
    verifyFailStreaks.clear();
    return;
  }
  if (instanceId) {
    verifyFailStreaks.delete(verifyFailStreakKey({ project_id: projectId, instance_id: instanceId }));
    return;
  }
  const prefix = `${projectId}|`;
  for (const key of verifyFailStreaks.keys()) {
    if (key.startsWith(prefix)) {
      verifyFailStreaks.delete(key);
    }
  }
}

function isVerifyFailTerminalResult({ terminal_result, action, reason, auto_rejected } = {}) {
  if (auto_rejected === false) {
    return false;
  }
  const normalizedResult = normalizeAlertKeyPart(terminal_result)?.toUpperCase();
  const normalizedAction = normalizeAlertKeyPart(action);
  const normalizedReason = normalizeAlertKeyPart(reason);
  return normalizedResult === 'VERIFY_FAIL'
    || normalizedAction === 'auto_rejected_verify_fail'
    || normalizedReason === 'auto_rejected_after_max_retries';
}

function recordVerifyFailTerminalResult({
  project_id,
  terminal_result,
  action,
  reason,
  auto_rejected = true,
  work_item_id,
  batch_id,
  instance_id,
  occurred_at,
  threshold = VERIFY_FAIL_STREAK_THRESHOLD,
} = {}) {
  if (!isVerifyFailTerminalResult({ terminal_result, action, reason, auto_rejected })) {
    clearVerifyFailStreak({ project_id, instance_id });
    return {
      alert: null,
      alerted: false,
      reset: true,
      streak_count: 0,
      threshold,
    };
  }

  const key = verifyFailStreakKey({ project_id, instance_id });
  const current = verifyFailStreaks.get(key) || { count: 0, alerted: false };
  const next = {
    count: current.count + 1,
    alerted: current.alerted === true,
  };
  let alert = null;

  if (next.count >= threshold && !next.alerted) {
    alert = notifyVerifyFailStreak({
      project_id,
      streak_count: next.count,
      threshold,
      work_item_id,
      batch_id,
      instance_id,
      last_failure_at: occurred_at || new Date().toISOString(),
      reason: reason || action || terminal_result || 'verify_fail',
    });
    next.alerted = true;
  }

  verifyFailStreaks.set(key, next);
  return {
    alert,
    alerted: Boolean(alert),
    reset: false,
    streak_count: next.count,
    threshold,
  };
}

function recordFactoryTickState({
  project_id,
  project_status,
  status,
  stage,
  loop_state,
  instance_id,
  batch_id,
  last_action_at,
  now_ms = Date.now(),
  threshold_ms = FACTORY_STALL_THRESHOLD_MS,
  reason = 'no recorded factory progress',
} = {}) {
  const projectStatus = normalizeAlertKeyPart(project_status || status)?.toLowerCase();
  const currentStage = normalizeAlertKeyPart(stage || loop_state)?.toUpperCase();
  const lastActionMs = Date.parse(last_action_at || '');
  const alertKey = dedupeAlertKey(ALERT_TYPES.FACTORY_STALLED, {
    project_id,
    stage: currentStage,
    instance_id,
    batch_id,
  });

  if (
    projectStatus !== 'running'
    || !currentStage
    || currentStage === 'IDLE'
    || currentStage === 'PAUSED'
    || !Number.isFinite(lastActionMs)
  ) {
    factoryStallAlerts.delete(alertKey);
    return {
      alert: null,
      alerted: false,
      stalled: false,
      stalled_ms: 0,
      threshold_ms,
    };
  }

  const stalledMs = now_ms - lastActionMs;
  if (stalledMs <= threshold_ms) {
    factoryStallAlerts.delete(alertKey);
    return {
      alert: null,
      alerted: false,
      stalled: false,
      stalled_ms: Math.max(0, stalledMs),
      threshold_ms,
    };
  }

  const progressSignature = [
    currentStage,
    normalizeAlertKeyPart(instance_id) || '',
    normalizeAlertKeyPart(batch_id) || '',
    last_action_at,
  ].join('|');
  if (factoryStallAlerts.get(alertKey) === progressSignature) {
    return {
      alert: null,
      alerted: false,
      stalled: true,
      stalled_ms: stalledMs,
      threshold_ms,
    };
  }

  const alert = notifyFactoryStalled({
    project_id,
    stalled_minutes: Math.floor(stalledMs / (60 * 1000)),
    threshold_minutes: Math.floor(threshold_ms / (60 * 1000)),
    stage: currentStage,
    instance_id,
    batch_id,
    last_action_at,
    reason,
  });
  factoryStallAlerts.set(alertKey, progressSignature);
  return {
    alert,
    alerted: true,
    stalled: true,
    stalled_ms: stalledMs,
    threshold_ms,
  };
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

function resetAlertRuntimeState() {
  verifyFailStreaks = new Map();
  factoryStallAlerts = new Map();
}

function listChannels() {
  return ['sse', 'webhook', 'digest'];
}

module.exports = {
  ALERT_TYPES,
  VERIFY_FAIL_STREAK_THRESHOLD,
  FACTORY_STALL_THRESHOLD_MS,
  normalizeAlertKeyPart,
  dedupeAlertKey,
  notifyFactoryAlert,
  notify,
  notifyVerifyFailStreak,
  notifyFactoryStalled,
  notifyFactoryIdle,
  recordVerifyFailTerminalResult,
  recordFactoryTickState,
  getDigest,
  flushAllDigests,
  startDigestTimer,
  stopDigestTimer,
  listChannels,
  _testing: {
    resetAlertRuntimeState,
    getVerifyFailStreaks: () => new Map(verifyFailStreaks),
    getFactoryStallAlerts: () => new Map(factoryStallAlerts),
  },
};
