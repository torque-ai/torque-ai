const path = require('path');
const os = require('os');

const { randomUUID } = require('crypto');

vi.mock('../logger', () => ({
  child: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('RB-045: budget alert webhook targeting', () => {
  const testDataDir = path.join(os.tmpdir(), 'torque-budget-alerts-test');
  const originalTorqueDataDir = process.env.TORQUE_DATA_DIR;
  let db;
  let index;
  let webhookHandlers;
  let _checkBudgetAlertsSpy;
  let _updateBudgetAlertSpy;
  let _getWebhookSpy;
  let sendWebhookSpy;
  let triggerWebhooksSpy;

  function loadIndex() {
    vi.resetModules();
    process.env.TORQUE_DATA_DIR = testDataDir;
    index = require('../index');
    db = require('../database');
    webhookHandlers = require('../handlers/webhook-handlers');
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    loadIndex();
    _checkBudgetAlertsSpy = vi.spyOn(db, 'checkBudgetAlerts').mockReturnValue([]);
    _updateBudgetAlertSpy = vi.spyOn(db, 'updateBudgetAlert').mockReturnValue();
    _getWebhookSpy = vi.spyOn(db, 'getWebhook').mockReturnValue();
    sendWebhookSpy = vi.spyOn(webhookHandlers, 'sendWebhook').mockResolvedValue();
    triggerWebhooksSpy = vi.spyOn(webhookHandlers, 'triggerWebhooks').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalTorqueDataDir === undefined) {
      delete process.env.TORQUE_DATA_DIR;
    } else {
      process.env.TORQUE_DATA_DIR = originalTorqueDataDir;
    }
  });

  it('fires only the webhook assigned in alert.webhook_id', () => {
    const webhookId = `wh-${randomUUID()}`;
    const alert = {
      id: `al-${randomUUID()}`,
      alert_type: 'daily_cost',
      webhook_id: webhookId,
    };
    const webhook = {
      id: webhookId,
      url: 'https://example.com/webhook',
      type: 'http',
      retry_count: 3,
    };

    db.checkBudgetAlerts.mockReturnValue([{
      alert,
      currentValue: 120,
      thresholdValue: 100,
      percentUsed: 120,
    }]);
    db.getWebhook.mockReturnValue(webhook);

    index._testing.checkBudgetAlerts();

    expect(db.updateBudgetAlert).toHaveBeenCalledWith(alert.id, expect.any(Object));
    expect(db.getWebhook).toHaveBeenCalledWith(webhookId);
    expect(sendWebhookSpy).toHaveBeenCalledTimes(1);
    expect(sendWebhookSpy).toHaveBeenCalledWith(webhook, 'budget_alert', {
      alert,
      currentValue: 120,
      thresholdValue: 100,
      percentUsed: 120,
    });
    expect(triggerWebhooksSpy).not.toHaveBeenCalled();
  });

  it('falls back to triggerWebhooks when webhook_id is null', () => {
    const alert = {
      id: `al-${randomUUID()}`,
      alert_type: 'daily_cost',
      webhook_id: null,
    };

    db.checkBudgetAlerts.mockReturnValue([{
      alert,
      currentValue: 120,
      thresholdValue: 100,
      percentUsed: 120,
    }]);

    index._testing.checkBudgetAlerts();

    expect(db.getWebhook).not.toHaveBeenCalled();
    expect(sendWebhookSpy).not.toHaveBeenCalled();
    expect(triggerWebhooksSpy).toHaveBeenCalledTimes(1);
    expect(triggerWebhooksSpy).toHaveBeenCalledWith('budget_alert', {
      alert,
      currentValue: 120,
      thresholdValue: 100,
      percentUsed: 120,
    });
  });
});
