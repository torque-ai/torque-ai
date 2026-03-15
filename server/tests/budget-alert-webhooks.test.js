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
  let index;
  let db;
  let webhookHandlers;
  let checkBudgetAlertsSpy;
  let updateBudgetAlertSpy;
  let getWebhookSpy;
  let getDataDirSpy;
  let sendWebhookSpy;
  let triggerWebhooksSpy;

  function loadIndex() {
    vi.resetModules();
    index = require('../index');
    db = require('../database');
    webhookHandlers = require('../handlers/webhook-handlers');
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    loadIndex();
    checkBudgetAlertsSpy = vi.spyOn(db, 'checkBudgetAlerts').mockReturnValue([]);
    updateBudgetAlertSpy = vi.spyOn(db, 'updateBudgetAlert').mockReturnValue();
    getWebhookSpy = vi.spyOn(db, 'getWebhook').mockReturnValue();
    sendWebhookSpy = vi.spyOn(webhookHandlers, 'sendWebhook').mockResolvedValue();
    triggerWebhooksSpy = vi.spyOn(webhookHandlers, 'triggerWebhooks').mockResolvedValue();
    if (typeof db.getDataDir === 'function') {
      getDataDirSpy = vi.spyOn(db, 'getDataDir').mockReturnValue(path.join(os.tmpdir(), 'torque-budget-alerts-test'));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
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
