import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

const originalModuleCache = new Map();

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  if (!originalModuleCache.has(resolved)) {
    originalModuleCache.set(resolved, require.cache[resolved]);
  }
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreCjsModuleMocks() {
  for (const [resolved, cached] of originalModuleCache.entries()) {
    if (cached) {
      require.cache[resolved] = cached;
    } else {
      delete require.cache[resolved];
    }
  }
  originalModuleCache.clear();
  delete require.cache[require.resolve('../factory/notifications')];
}

installCjsModuleMock('../event-bus', { emitTaskEvent: vi.fn() });
installCjsModuleMock('../handlers/webhook-handlers', {
  triggerWebhooks: vi.fn().mockResolvedValue(undefined),
});
delete require.cache[require.resolve('../factory/notifications')];

const notifications = require('../factory/notifications');
const eventBus = require('../event-bus');
const { triggerWebhooks } = require('../handlers/webhook-handlers');

const PROJECT_ID = 'factory-project-alerts';

beforeEach(() => {
  notifications.stopDigestTimer();
  notifications.flushAllDigests();
  notifications._testing.resetAlertRuntimeState();
  vi.clearAllMocks();
});

afterEach(() => {
  notifications.stopDigestTimer();
  notifications.flushAllDigests();
  notifications._testing.resetAlertRuntimeState();
  vi.useRealTimers();
});

afterAll(() => {
  restoreCjsModuleMocks();
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

  it('records FACTORY_IDLE once per exhausted queue transition and clears when pending work arrives', () => {
    const first = notifications.recordFactoryIdleState({
      project_id: PROJECT_ID,
      pending_count: 0,
      running_count: 0,
      last_action_at: '2026-04-20T12:00:00.000Z',
      now_ms: Date.parse('2026-04-20T12:08:00.000Z'),
      reason: 'no_work_item_selected',
    });
    const expectedKey = notifications.dedupeAlertKey(
      notifications.ALERT_TYPES.FACTORY_IDLE,
      { project_id: PROJECT_ID }
    );

    expect(first).toMatchObject({
      alerted: true,
      idle: true,
      pending_count: 0,
      running_count: 0,
    });
    expect(first.alert).toMatchObject({
      alert_type: notifications.ALERT_TYPES.FACTORY_IDLE,
      idle_minutes: 8,
      threshold_minutes: 0,
      reason: 'no_work_item_selected',
    });
    expect(notifications.getFactoryAlertBadge({ project_id: PROJECT_ID })).toMatchObject({
      alert_type: notifications.ALERT_TYPES.FACTORY_IDLE,
      alert_key: expectedKey,
      label: 'Factory idle',
      active: true,
    });
    expectAlertDelivery({
      alert_type: notifications.ALERT_TYPES.FACTORY_IDLE,
      payload: first.alert,
      expected_key: expectedKey,
    });

    const duplicate = notifications.recordFactoryIdleState({
      project_id: PROJECT_ID,
      pending_count: 0,
      running_count: 0,
      reason: 'no_work_item_selected',
    });
    expect(duplicate).toMatchObject({
      alerted: false,
      idle: true,
    });
    expect(eventBus.emitTaskEvent).toHaveBeenCalledTimes(1);

    const cleared = notifications.recordFactoryIdleState({
      project_id: PROJECT_ID,
      pending_count: 1,
      running_count: 0,
    });
    expect(cleared).toMatchObject({
      alerted: false,
      idle: false,
      pending_count: 1,
    });
    expect(notifications.getFactoryAlertBadge({ project_id: PROJECT_ID })).toBeNull();

    const afterWorkExhausted = notifications.recordFactoryIdleState({
      project_id: PROJECT_ID,
      pending_count: 0,
      running_count: 0,
      reason: 'no_work_item_selected',
    });
    expect(afterWorkExhausted).toMatchObject({
      alerted: true,
      idle: true,
    });
    expect(eventBus.emitTaskEvent).toHaveBeenCalledTimes(2);
  });

  it('emits VERIFY_FAIL_STREAK after three consecutive auto-rejected VERIFY_FAIL results and resets on success', () => {
    for (let i = 1; i <= 2; i += 1) {
      const result = notifications.recordVerifyFailTerminalResult({
        project_id: PROJECT_ID,
        terminal_result: 'VERIFY_FAIL',
        auto_rejected: true,
        work_item_id: i,
        batch_id: `batch-${i}`,
        instance_id: 'loop-verify',
        occurred_at: `2026-04-20T12:0${i}:00.000Z`,
      });

      expect(result).toMatchObject({
        alerted: false,
        reset: false,
        streak_count: i,
        threshold: 3,
      });
    }
    expect(eventBus.emitTaskEvent).not.toHaveBeenCalled();

    const third = notifications.recordVerifyFailTerminalResult({
      project_id: PROJECT_ID,
      terminal_result: 'VERIFY_FAIL',
      auto_rejected: true,
      work_item_id: 3,
      batch_id: 'batch-3',
      instance_id: 'loop-verify',
      occurred_at: '2026-04-20T12:03:00.000Z',
    });
    const firstExpectedKey = notifications.dedupeAlertKey(
      notifications.ALERT_TYPES.VERIFY_FAIL_STREAK,
      {
        project_id: PROJECT_ID,
        work_item_id: 3,
        batch_id: 'batch-3',
        instance_id: 'loop-verify',
      }
    );

    expect(third).toMatchObject({
      alerted: true,
      reset: false,
      streak_count: 3,
      threshold: 3,
    });
    expectAlertDelivery({
      alert_type: notifications.ALERT_TYPES.VERIFY_FAIL_STREAK,
      payload: third.alert,
      expected_key: firstExpectedKey,
    });

    const duplicate = notifications.recordVerifyFailTerminalResult({
      project_id: PROJECT_ID,
      terminal_result: 'VERIFY_FAIL',
      auto_rejected: true,
      work_item_id: 4,
      batch_id: 'batch-4',
      instance_id: 'loop-verify',
    });
    expect(duplicate).toMatchObject({
      alerted: false,
      reset: false,
      streak_count: 4,
    });
    expect(eventBus.emitTaskEvent).toHaveBeenCalledTimes(1);

    const reset = notifications.recordVerifyFailTerminalResult({
      project_id: PROJECT_ID,
      terminal_result: 'VERIFY_PASS',
      auto_rejected: false,
      instance_id: 'loop-verify',
    });
    expect(reset).toMatchObject({
      alerted: false,
      reset: true,
      streak_count: 0,
    });

    vi.clearAllMocks();
    for (let i = 5; i <= 6; i += 1) {
      notifications.recordVerifyFailTerminalResult({
        project_id: PROJECT_ID,
        terminal_result: 'VERIFY_FAIL',
        auto_rejected: true,
        work_item_id: i,
        batch_id: `batch-${i}`,
        instance_id: 'loop-verify',
      });
    }
    const afterReset = notifications.recordVerifyFailTerminalResult({
      project_id: PROJECT_ID,
      terminal_result: 'VERIFY_FAIL',
      auto_rejected: true,
      work_item_id: 7,
      batch_id: 'batch-7',
      instance_id: 'loop-verify',
      occurred_at: '2026-04-20T12:07:00.000Z',
    });
    const resetExpectedKey = notifications.dedupeAlertKey(
      notifications.ALERT_TYPES.VERIFY_FAIL_STREAK,
      {
        project_id: PROJECT_ID,
        work_item_id: 7,
        batch_id: 'batch-7',
        instance_id: 'loop-verify',
      }
    );

    expect(afterReset).toMatchObject({
      alerted: true,
      reset: false,
      streak_count: 3,
    });
    expectAlertDelivery({
      alert_type: notifications.ALERT_TYPES.VERIFY_FAIL_STREAK,
      payload: afterReset.alert,
      expected_key: resetExpectedKey,
    });
  });

  it('emits FACTORY_STALLED once for a stale running instance and ignores stopped instances', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T13:00:00.000Z'));
    const staleActionAt = '2026-04-20T12:20:00.000Z';

    const stopped = notifications.recordFactoryTickState({
      project_id: PROJECT_ID,
      project_status: 'stopped',
      stage: 'VERIFY',
      instance_id: 'loop-stalled',
      batch_id: 'batch-stalled',
      last_action_at: staleActionAt,
    });

    expect(stopped).toMatchObject({
      alerted: false,
      stalled: false,
    });
    expect(eventBus.emitTaskEvent).not.toHaveBeenCalled();

    const alertResult = notifications.recordFactoryTickState({
      project_id: PROJECT_ID,
      project_status: 'running',
      stage: 'VERIFY',
      instance_id: 'loop-stalled',
      batch_id: 'batch-stalled',
      last_action_at: staleActionAt,
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

    expect(alertResult).toMatchObject({
      alerted: true,
      stalled: true,
      stalled_ms: 40 * 60 * 1000,
      threshold_ms: 30 * 60 * 1000,
    });
    expect(alertResult.alert).toMatchObject({
      alert_type: notifications.ALERT_TYPES.FACTORY_STALLED,
      stalled_minutes: 40,
      threshold_minutes: 30,
      stage: 'VERIFY',
      instance_id: 'loop-stalled',
      batch_id: 'batch-stalled',
      last_action_at: staleActionAt,
    });
    expectAlertDelivery({
      alert_type: notifications.ALERT_TYPES.FACTORY_STALLED,
      payload: alertResult.alert,
      expected_key: expectedKey,
    });

    const duplicate = notifications.recordFactoryTickState({
      project_id: PROJECT_ID,
      project_status: 'running',
      stage: 'VERIFY',
      instance_id: 'loop-stalled',
      batch_id: 'batch-stalled',
      last_action_at: staleActionAt,
    });

    expect(duplicate).toMatchObject({
      alerted: false,
      stalled: true,
    });
    expect(eventBus.emitTaskEvent).toHaveBeenCalledTimes(1);
  });

  it('emits FACTORY_STALLED at the threshold and ignores gate-paused loops', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T13:00:00.000Z'));

    const atThreshold = notifications.recordFactoryTickState({
      project_id: PROJECT_ID,
      project_status: 'running',
      stage: 'VERIFY',
      instance_id: 'loop-threshold',
      batch_id: 'batch-threshold',
      last_action_at: '2026-04-20T12:30:00.000Z',
    });
    const expectedKey = notifications.dedupeAlertKey(
      notifications.ALERT_TYPES.FACTORY_STALLED,
      {
        project_id: PROJECT_ID,
        stage: 'VERIFY',
        instance_id: 'loop-threshold',
        batch_id: 'batch-threshold',
      }
    );

    expect(atThreshold).toMatchObject({
      alerted: true,
      stalled: true,
      stalled_ms: 30 * 60 * 1000,
      threshold_ms: 30 * 60 * 1000,
    });
    expect(atThreshold.alert).toMatchObject({
      alert_type: notifications.ALERT_TYPES.FACTORY_STALLED,
      stalled_minutes: 30,
      threshold_minutes: 30,
    });
    expectAlertDelivery({
      alert_type: notifications.ALERT_TYPES.FACTORY_STALLED,
      payload: atThreshold.alert,
      expected_key: expectedKey,
    });

    notifications._testing.resetAlertRuntimeState();
    vi.clearAllMocks();

    const gatePaused = notifications.recordFactoryTickState({
      project_id: PROJECT_ID,
      project_status: 'running',
      stage: 'VERIFY',
      paused_at_stage: 'PLAN_REVIEW',
      instance_id: 'loop-gate-paused',
      batch_id: 'batch-gate-paused',
      last_action_at: '2026-04-20T12:00:00.000Z',
    });

    expect(gatePaused).toMatchObject({
      alerted: false,
      stalled: false,
    });
    expect(eventBus.emitTaskEvent).not.toHaveBeenCalled();
    expect(notifications.getFactoryAlertBadge({ project_id: PROJECT_ID })).toBeNull();
  });
});
