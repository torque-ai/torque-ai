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
  let projectConfigCore;
  let webhooksStreaming;
  let webhookHandlers;
  let _checkBudgetAlertsSpy;
  let _updateBudgetAlertSpy;
  let _getWebhookSpy;
  let _getDataDirSpy;
  let sendWebhookSpy;
  let triggerWebhooksSpy;

  function loadIndex() {
    vi.resetModules();
    index = require('../index');
    db = require('../database');
    projectConfigCore = require('../db/project-config-core');
    webhooksStreaming = require('../db/webhooks-streaming');
    webhookHandlers = require('../handlers/webhook-handlers');
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    loadIndex();
    _checkBudgetAlertsSpy = vi.spyOn(projectConfigCore, 'checkBudgetAlerts').mockReturnValue([]);
    _updateBudgetAlertSpy = vi.spyOn(projectConfigCore, 'updateBudgetAlert').mockReturnValue();
    _getWebhookSpy = vi.spyOn(webhooksStreaming, 'getWebhook').mockReturnValue();
    sendWebhookSpy = vi.spyOn(webhookHandlers, 'sendWebhook').mockResolvedValue();
    triggerWebhooksSpy = vi.spyOn(webhookHandlers, 'triggerWebhooks').mockResolvedValue();
    if (typeof db.getDataDir === 'function') {
      _getDataDirSpy = vi.spyOn(db, 'getDataDir').mockReturnValue(path.join(os.tmpdir(), 'torque-budget-alerts-test'));
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

    projectConfigCore.checkBudgetAlerts.mockReturnValue([{
      alert,
      currentValue: 120,
      thresholdValue: 100,
      percentUsed: 120,
    }]);
    webhooksStreaming.getWebhook.mockReturnValue(webhook);

    index._testing.checkBudgetAlerts();

    expect(projectConfigCore.updateBudgetAlert).toHaveBeenCalledWith(alert.id, expect.any(Object));
    expect(webhooksStreaming.getWebhook).toHaveBeenCalledWith(webhookId);
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

    projectConfigCore.checkBudgetAlerts.mockReturnValue([{
      alert,
      currentValue: 120,
      thresholdValue: 100,
      percentUsed: 120,
    }]);

    index._testing.checkBudgetAlerts();

    expect(webhooksStreaming.getWebhook).not.toHaveBeenCalled();
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
