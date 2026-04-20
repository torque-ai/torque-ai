import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));
vi.mock('../handlers/webhook-handlers', () => ({
  triggerWebhooks: vi.fn().mockResolvedValue(undefined),
}));

const notifications = require('../factory/notifications');
const eventBus = require('../event-bus');
const { triggerWebhooks } = require('../handlers/webhook-handlers');

const PROJECT_ID = 'factory-project-alerts';

beforeEach(() => {
  notifications.stopDigestTimer();
  notifications.flushAllDigests();
  vi.clearAllMocks();
});

afterEach(() => {
  notifications.stopDigestTimer();
  notifications.flushAllDigests();
});

function expectAlertDelivery({ alert_type, payload, expected_key }) {
  expect(payload.alert_key).toBe(expected_key);
  expect(payload.dedupe_key).toBe(expected_key);

  expect(eventBus.emitTaskEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'factory_notification',
      project_id: PROJECT_ID,
      event_type: alert_type,
      data: expect.objectContaining({
        alert_type,
        alert_key: expected_key,
        dedupe_key: expected_key,
      }),
      timestamp: expect.any(String),
    })
  );

  expect(triggerWebhooks).toHaveBeenCalledWith(
    `factory_${alert_type}`,
    expect.objectContaining({
      project_id: PROJECT_ID,
      event_type: alert_type,
      alert_type,
      alert_key: expected_key,
      dedupe_key: expected_key,
    })
  );

  const digest = notifications.getDigest(PROJECT_ID);
  expect(digest.events).toEqual([
    expect.objectContaining({
      event_type: alert_type,
      data: expect.objectContaining({
        alert_type,
        alert_key: expected_key,
        dedupe_key: expected_key,
      }),
      timestamp: expect.any(String),
    }),
  ]);
}

describe('factory alert notification primitives', () => {
  it('notifies VERIFY_FAIL_STREAK through notify channels and digest with a stable key', () => {
    const payload = notifications.notifyVerifyFailStreak({
      project_id: PROJECT_ID,
      streak_count: 3,
      threshold: 3,
      work_item_id: 42,
      batch_id: 'batch-verify',
      instance_id: 'loop-verify',
      last_failure_at: '2026-04-20T12:00:00.000Z',
      reason: 'verification failed three times',
    });
    const expectedKey = notifications.dedupeAlertKey(
      notifications.ALERT_TYPES.VERIFY_FAIL_STREAK,
      {
        project_id: PROJECT_ID,
        work_item_id: 42,
        batch_id: 'batch-verify',
        instance_id: 'loop-verify',
      }
    );

    expect(payload).toMatchObject({
      alert_type: notifications.ALERT_TYPES.VERIFY_FAIL_STREAK,
      streak_count: 3,
      threshold: 3,
      work_item_id: 42,
      batch_id: 'batch-verify',
      instance_id: 'loop-verify',
    });
    expectAlertDelivery({
      alert_type: notifications.ALERT_TYPES.VERIFY_FAIL_STREAK,
      payload,
      expected_key: expectedKey,
    });
  });

  it('notifies FACTORY_STALLED through notify channels and digest with a stable key', () => {
    const payload = notifications.notifyFactoryStalled({
      project_id: PROJECT_ID,
      stalled_minutes: 61,
      threshold_minutes: 30,
      stage: 'VERIFY',
      instance_id: 'loop-stalled',
      batch_id: 'batch-stalled',
      last_action_at: '2026-04-20T11:00:00.000Z',
      reason: 'no loop progress',
    });
    const expectedKey = notifications.dedupeAlertKey(
      notifications.ALERT_TYPES.FACTORY_STALLED,
      {
        project_id: PROJECT_ID,
        stage: 'VERIFY',
        instance_id: 'loop-stalled',
        batch_id: 'batch-stalled',
      }
    );

    expect(payload).toMatchObject({
      alert_type: notifications.ALERT_TYPES.FACTORY_STALLED,
      stalled_minutes: 61,
      threshold_minutes: 30,
      stage: 'VERIFY',
      instance_id: 'loop-stalled',
      batch_id: 'batch-stalled',
    });
    expectAlertDelivery({
      alert_type: notifications.ALERT_TYPES.FACTORY_STALLED,
      payload,
      expected_key: expectedKey,
    });
  });

  it('notifies FACTORY_IDLE through notify channels and digest with a stable project key', () => {
    const payload = notifications.notifyFactoryIdle({
      project_id: PROJECT_ID,
      idle_minutes: 45,
      threshold_minutes: 30,
      last_action_at: '2026-04-20T10:30:00.000Z',
      reason: 'no eligible work items',
    });
    const expectedKey = notifications.dedupeAlertKey(
      notifications.ALERT_TYPES.FACTORY_IDLE,
      { project_id: PROJECT_ID }
    );

    expect(payload).toMatchObject({
      alert_type: notifications.ALERT_TYPES.FACTORY_IDLE,
      idle_minutes: 45,
      threshold_minutes: 30,
    });
    expectAlertDelivery({
      alert_type: notifications.ALERT_TYPES.FACTORY_IDLE,
      payload,
      expected_key: expectedKey,
    });
  });
});
