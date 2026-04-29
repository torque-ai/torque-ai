'use strict';

const eventBus = require('../event-bus');
const { triggerWebhooks } = require('../handlers/webhook-handlers');
const logger = require('../logger').child({ component: 'factory-notifications' });

let digestBuffer = new Map(); // project_id -> [events]
let digestInterval = null;
let verifyFailStreaks = new Map(); // project_id|instance_id -> runtime streak state
let factoryStallAlerts = new Map(); // alert_key -> last progress signature
let factoryIdleAlerts = new Map(); // alert_key -> transition signature
let factoryAlertBadges = new Map(); // project_id -> Map(alert_type -> badge)

const ALERT_TYPES = Object.freeze({
  VERIFY_FAIL_STREAK: 'VERIFY_FAIL_STREAK',
  FACTORY_STALLED: 'FACTORY_STALLED',
  FACTORY_IDLE: 'FACTORY_IDLE',
});
const VERIFY_FAIL_STREAK_THRESHOLD = 3;
const FACTORY_STALL_THRESHOLD_MS = 30 * 60 * 1000;
const ALERT_BADGE_PRIORITY = Object.freeze({
  [ALERT_TYPES.VERIFY_FAIL_STREAK]: 30,
  [ALERT_TYPES.FACTORY_STALLED]: 20,
  [ALERT_TYPES.FACTORY_IDLE]: 10,
});
const ALERT_BADGE_LABELS = Object.freeze({
  [ALERT_TYPES.VERIFY_FAIL_STREAK]: 'Verify failures',
  [ALERT_TYPES.FACTORY_STALLED]: 'Factory stalled',
  [ALERT_TYPES.FACTORY_IDLE]: 'Factory idle',
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

function verifyFailStreakKey({ project_id, instance_id } = {}) {
  const projectId = normalizeAlertKeyPart(project_id) || 'unknown-project';
  const instanceId = normalizeAlertKeyPart(instance_id) || 'project';
  return `${projectId}|${instanceId}`;
}

function alertProjectKey(project_id) {
  return normalizeAlertKeyPart(project_id) || 'unknown-project';
}

function cloneJsonSafe(value) {
  return value && typeof value === 'object'
    ? JSON.parse(JSON.stringify(value))
    : value;
}

function buildAlertBadge(project_id, payload = {}) {
  const alertType = payload.alert_type || ALERT_TYPES.FACTORY_IDLE;
  return {
    project_id: alertProjectKey(project_id),
    alert_type: alertType,
    alert_key: payload.alert_key || dedupeAlertKey(alertType, { project_id }),
    dedupe_key: payload.dedupe_key || payload.alert_key || dedupeAlertKey(alertType, { project_id }),
    label: ALERT_BADGE_LABELS[alertType] || alertType,
    priority: ALERT_BADGE_PRIORITY[alertType] || 0,
    active: true,
    details: cloneJsonSafe(payload) || {},
  };
}

function setFactoryAlertBadge(project_id, payload = {}) {
  const projectKey = alertProjectKey(project_id);
  const alertType = payload.alert_type || ALERT_TYPES.FACTORY_IDLE;
  const badges = factoryAlertBadges.get(projectKey) || new Map();
  badges.set(alertType, buildAlertBadge(projectKey, payload));
  factoryAlertBadges.set(projectKey, badges);
}

function clearFactoryAlertBadge({ project_id, alert_type } = {}) {
  const projectKey = normalizeAlertKeyPart(project_id);
  if (!projectKey) {
    if (!alert_type) {
      factoryAlertBadges.clear();
      return;
    }
    for (const [key, badges] of factoryAlertBadges.entries()) {
      badges.delete(alert_type);
      if (badges.size === 0) {
        factoryAlertBadges.delete(key);
      }
    }
    return;
  }

  if (!alert_type) {
    factoryAlertBadges.delete(projectKey);
    return;
  }

  const badges = factoryAlertBadges.get(projectKey);
  if (!badges) return;
  badges.delete(alert_type);
  if (badges.size === 0) {
    factoryAlertBadges.delete(projectKey);
  }
}

function getFactoryAlertBadge({ project_id } = {}) {
  const badges = factoryAlertBadges.get(alertProjectKey(project_id));
  if (!badges || badges.size === 0) return null;

  const ordered = [...badges.values()].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return String(left.alert_type).localeCompare(String(right.alert_type));
  });
  return cloneJsonSafe(ordered[0]);
}

function clearVerifyFailStreak({ project_id, instance_id } = {}) {
  const projectId = normalizeAlertKeyPart(project_id);
  const instanceId = normalizeAlertKeyPart(instance_id);
  if (!projectId) {
    verifyFailStreaks.clear();
    clearFactoryAlertBadge({ alert_type: ALERT_TYPES.VERIFY_FAIL_STREAK });
    return;
  }
  if (instanceId) {
    verifyFailStreaks.delete(verifyFailStreakKey({ project_id: projectId, instance_id: instanceId }));
    clearFactoryAlertBadge({ project_id: projectId, alert_type: ALERT_TYPES.VERIFY_FAIL_STREAK });
    return;
  }
  const prefix = `${projectId}|`;
  for (const key of verifyFailStreaks.keys()) {
    if (key.startsWith(prefix)) {
      verifyFailStreaks.delete(key);
    }
  }
  clearFactoryAlertBadge({ project_id: projectId, alert_type: ALERT_TYPES.VERIFY_FAIL_STREAK });
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
  paused_at_stage,
  instance_id,
  batch_id,
  last_action_at,
  has_non_terminal_batch_tasks = false,
  now_ms = Date.now(),
  threshold_ms = FACTORY_STALL_THRESHOLD_MS,
  reason = 'no recorded factory progress',
} = {}) {
  const projectStatus = normalizeAlertKeyPart(project_status || status)?.toLowerCase();
  const currentStage = normalizeAlertKeyPart(stage || loop_state)?.toUpperCase();
  const pausedStage = normalizeAlertKeyPart(paused_at_stage)?.toUpperCase();
  const lastActionMs = Date.parse(last_action_at || '');
  const alertKey = dedupeAlertKey(ALERT_TYPES.FACTORY_STALLED, {
    project_id,
    stage: currentStage,
    instance_id,
    batch_id,
  });
  const pausedAtGate = pausedStage
    && !pausedStage.startsWith('READY_FOR_')
    && pausedStage !== 'EXECUTE';

  if (
    projectStatus !== 'running'
    || !currentStage
    || currentStage === 'IDLE'
    || currentStage === 'PAUSED'
    || pausedAtGate
    || has_non_terminal_batch_tasks === true
    || !Number.isFinite(lastActionMs)
  ) {
    factoryStallAlerts.delete(alertKey);
    clearFactoryAlertBadge({ project_id, alert_type: ALERT_TYPES.FACTORY_STALLED });
    return {
      alert: null,
      alerted: false,
      stalled: false,
      stalled_ms: 0,
      threshold_ms,
    };
  }

  const stalledMs = now_ms - lastActionMs;
  if (stalledMs < threshold_ms) {
    factoryStallAlerts.delete(alertKey);
    clearFactoryAlertBadge({ project_id, alert_type: ALERT_TYPES.FACTORY_STALLED });
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

function recordFactoryIdleState({
  project_id,
  has_pending_work,
  has_running_item,
  pending_count,
  running_count,
  last_action_at,
  now_ms = Date.now(),
  reason = 'pending work exhausted',
} = {}) {
  const normalizedPendingCount = Number.isFinite(Number(pending_count))
    ? Math.max(0, Number(pending_count))
    : (has_pending_work ? 1 : 0);
  const normalizedRunningCount = Number.isFinite(Number(running_count))
    ? Math.max(0, Number(running_count))
    : (has_running_item ? 1 : 0);
  const hasPending = has_pending_work === true || normalizedPendingCount > 0;
  const hasRunning = has_running_item === true || normalizedRunningCount > 0;
  const alertKey = dedupeAlertKey(ALERT_TYPES.FACTORY_IDLE, { project_id });

  if (hasPending || hasRunning) {
    factoryIdleAlerts.delete(alertKey);
    clearFactoryAlertBadge({ project_id, alert_type: ALERT_TYPES.FACTORY_IDLE });
    return {
      alert: null,
      alerted: false,
      idle: false,
      pending_count: normalizedPendingCount,
      running_count: normalizedRunningCount,
    };
  }

  if (factoryIdleAlerts.has(alertKey)) {
    return {
      alert: null,
      alerted: false,
      idle: true,
      pending_count: 0,
      running_count: 0,
      badge: getFactoryAlertBadge({ project_id }),
    };
  }

  const lastActionMs = Date.parse(last_action_at || '');
  const idleMinutes = Number.isFinite(lastActionMs)
    ? Math.max(0, Math.floor((now_ms - lastActionMs) / (60 * 1000)))
    : 0;
  const alert = notifyFactoryIdle({
    project_id,
    idle_minutes: idleMinutes,
    threshold_minutes: 0,
    last_action_at,
    reason,
  });

  factoryIdleAlerts.set(alertKey, [
    alertProjectKey(project_id),
    normalizeAlertKeyPart(last_action_at) || '',
    reason,
  ].join('|'));

  return {
    alert,
    alerted: true,
    idle: true,
    pending_count: 0,
    running_count: 0,
    badge: getFactoryAlertBadge({ project_id }),
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
  setFactoryAlertBadge(project_id, payload);

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
  factoryIdleAlerts = new Map();
  factoryAlertBadges = new Map();
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
  recordFactoryIdleState,
  getFactoryAlertBadge,
  clearFactoryAlertBadge,
  getDigest,
  flushAllDigests,
  startDigestTimer,
  stopDigestTimer,
  listChannels,
  _testing: {
    resetAlertRuntimeState,
    getVerifyFailStreaks: () => new Map(verifyFailStreaks),
    getFactoryStallAlerts: () => new Map(factoryStallAlerts),
    getFactoryIdleAlerts: () => new Map(factoryIdleAlerts),
    getFactoryAlertBadges: () => new Map(
      [...factoryAlertBadges.entries()].map(([projectId, badges]) => [
        projectId,
        new Map([...badges.entries()].map(([alertType, badge]) => [alertType, cloneJsonSafe(badge)])),
      ])
    ),
  },
};
