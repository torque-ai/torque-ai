/**
 * Tests for webhook free-tier trigger routing.
 *
 * Covers:
 * 1. Creating webhooks with trigger_type: free_tier_task (stored in action_config)
 * 2. Creating webhooks with trigger_type: standard (default, not stored)
 * 3. Rejecting invalid trigger_type values
 * 4. Free-tier trigger routes to best available free-tier provider via submit_task
 * 5. Fallback to smart_submit_task when no free-tier providers available
 * 6. Standard webhooks still use smart_submit_task (regression check)
 * 7. Response includes trigger_type and free_tier_provider fields
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db, handleToolCall;
let toolCallSpy;
let realHandleToolCall;
let handleInboundWebhook;
let setFreeTierTrackerGetter;

beforeAll(() => {
  // 1. Set up DB and load tools module
  ({ db, handleToolCall } = setupTestDb('wh-free-tier'));
  realHandleToolCall = handleToolCall;

  // 2. Spy on tools.handleToolCall BEFORE webhooks.js is required.
  //    webhooks.js does `const { handleToolCall } = require('../tools')` which
  //    captures whatever handleToolCall is at require-time. The spy replaces the
  //    export property, so the destructured capture grabs the spy wrapper.
  const toolsModule = require('../tools');
  toolCallSpy = vi.spyOn(toolsModule, 'handleToolCall');
  toolCallSpy.mockImplementation(realHandleToolCall);

  // 3. NOW require webhooks.js — it captures the spied handleToolCall
  const webhooksModule = require('../api/webhooks');
  handleInboundWebhook = webhooksModule.handleInboundWebhook;
  setFreeTierTrackerGetter = webhooksModule.setFreeTierTrackerGetter;
});

afterAll(() => {
  if (toolCallSpy) toolCallSpy.mockRestore();
  if (setFreeTierTrackerGetter) setFreeTierTrackerGetter(null);
  teardownTestDb();
});

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function signPayload(secret, body) {
  const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

beforeEach(() => {
  rawDb().prepare('DELETE FROM inbound_webhooks').run();
  rawDb().prepare('DELETE FROM webhook_deliveries').run();
  // Reset spy to pass-through between tests
  if (toolCallSpy) {
    toolCallSpy.mockReset();
    toolCallSpy.mockImplementation(realHandleToolCall);
  }
  if (setFreeTierTrackerGetter) setFreeTierTrackerGetter(null);
});

// ============================================
// 1-3: Handler-level trigger_type tests
// ============================================

describe('handleCreateInboundWebhook trigger_type', () => {
  it('stores trigger_type: free_tier_task in action_config', async () => {
    const result = await safeTool('create_inbound_webhook', {
      name: 'free-tier-hook',
      task_description: 'Run free-tier task',
      trigger_type: 'free_tier_task',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('Inbound Webhook Created');
    expect(text).toContain('free-tier-hook');

    const webhook = db.getInboundWebhook('free-tier-hook');
    expect(webhook).toBeTruthy();
    expect(webhook.action_config.trigger_type).toBe('free_tier_task');
    expect(webhook.action_config.task_description).toBe('Run free-tier task');
  });

  it('does not store trigger_type for standard (default)', async () => {
    const result = await safeTool('create_inbound_webhook', {
      name: 'standard-hook',
      task_description: 'Standard task',
      trigger_type: 'standard',
    });

    expect(result.isError).toBeFalsy();

    const webhook = db.getInboundWebhook('standard-hook');
    expect(webhook).toBeTruthy();
    // standard trigger_type is not stored in action_config (line 54 of handlers)
    expect(webhook.action_config.trigger_type).toBeUndefined();
    expect(webhook.action_config.task_description).toBe('Standard task');
  });

  it('does not store trigger_type when omitted (implicit standard)', async () => {
    const result = await safeTool('create_inbound_webhook', {
      name: 'no-trigger-hook',
      task_description: 'Default trigger type',
    });

    expect(result.isError).toBeFalsy();

    const webhook = db.getInboundWebhook('no-trigger-hook');
    expect(webhook).toBeTruthy();
    expect(webhook.action_config.trigger_type).toBeUndefined();
  });

  it('rejects invalid trigger_type values', async () => {
    const result = await safeTool('create_inbound_webhook', {
      name: 'bad-trigger',
      task_description: 'Invalid trigger',
      trigger_type: 'premium',
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('trigger_type');
  });

  it('rejects another invalid trigger_type', async () => {
    const result = await safeTool('create_inbound_webhook', {
      name: 'bad-trigger-2',
      task_description: 'Invalid trigger 2',
      trigger_type: 'free_tier',
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('trigger_type');
  });

  it('stores trigger_type alongside provider and tags', async () => {
    const result = await safeTool('create_inbound_webhook', {
      name: 'full-free-hook',
      task_description: 'Full free-tier',
      trigger_type: 'free_tier_task',
      tags: 'free,overflow',
      working_directory: '/tmp/free-tier',
    });

    expect(result.isError).toBeFalsy();

    const webhook = db.getInboundWebhook('full-free-hook');
    expect(webhook.action_config).toMatchObject({
      trigger_type: 'free_tier_task',
      task_description: 'Full free-tier',
      tags: 'free,overflow',
      working_directory: '/tmp/free-tier',
    });
  });
});

describe('handleListInboundWebhooks trigger_type display', () => {
  it('shows trigger_type for free_tier_task webhooks', async () => {
    await safeTool('create_inbound_webhook', {
      name: 'list-free-hook',
      task_description: 'Free tier listed',
      trigger_type: 'free_tier_task',
    });

    const result = await safeTool('list_inbound_webhooks', {});
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('list-free-hook');
    expect(text).toContain('Trigger Type:');
    expect(text).toContain('free_tier_task');
  });

  it('does not show trigger_type for standard webhooks', async () => {
    await safeTool('create_inbound_webhook', {
      name: 'list-std-hook',
      task_description: 'Standard listed',
    });

    const result = await safeTool('list_inbound_webhooks', {});
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('list-std-hook');
    expect(text).not.toContain('Trigger Type:');
  });
});

// ============================================
// 4-7: Webhook trigger endpoint routing tests
// ============================================

describe('handleInboundWebhook free-tier routing', () => {
  function createMockRes() {
    let resolvePromise;
    const done = new Promise((resolve) => { resolvePromise = resolve; });
    const resObj = {
      statusCode: null,
      _body: null,
      _headers: {},
      setHeader: vi.fn((name, val) => { resObj._headers[name.toLowerCase()] = val; }),
      getHeader: vi.fn((name) => resObj._headers[name.toLowerCase()]),
      writeHead: vi.fn((code, hdrs) => {
        resObj.statusCode = code;
        if (hdrs) Object.assign(resObj._headers, hdrs);
      }),
      end: vi.fn((body) => {
        resObj._body = body;
        resolvePromise();
      }),
    };
    return { res: resObj, done };
  }

  async function triggerWebhook(webhookName, payload, extraHeaders = {}) {
    const webhook = db.getInboundWebhook(webhookName);
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(webhook.secret, rawBody);

    const req = new EventEmitter();
    req.method = 'POST';
    req.url = `/api/webhooks/inbound/${encodeURIComponent(webhookName)}`;
    req.headers = {
      'x-webhook-signature': signature,
      ...extraHeaders,
    };
    req.destroy = vi.fn();
    req.socket = { remoteAddress: '127.0.0.1' };
    req.connection = { remoteAddress: '127.0.0.1' };

    const { res, done } = createMockRes();

    const handlerPromise = handleInboundWebhook(req, res, webhookName);
    process.nextTick(() => {
      req.emit('data', rawBody);
      req.emit('end');
    });

    await handlerPromise;
    await done;

    return {
      statusCode: res.statusCode,
      body: res._body ? JSON.parse(res._body) : null,
    };
  }

  function mockToolCallForRouting() {
    toolCallSpy.mockReset();
    toolCallSpy.mockImplementation(async (name, args) => {
      if (name === 'smart_submit_task' || name === 'submit_task') {
        return {
          content: [{ type: 'text', text: `Task submitted via ${name}` }],
          __subscribe_task_id: `task-${name}-001`,
        };
      }
      return realHandleToolCall(name, args);
    });
  }

  beforeEach(() => {
    mockToolCallForRouting();
    setFreeTierTrackerGetter(null);
  });

  // --- Test 4: Free-tier trigger routes to best free-tier provider via submit_task ---

  it('routes free_tier_task trigger to submit_task with best free-tier provider', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'free-trigger-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Free-tier job: {{payload.job}}',
        trigger_type: 'free_tier_task',
        tags: 'free',
        working_directory: '/tmp/free',
      },
    });

    const mockTracker = {
      getAvailableProvidersSmart: vi.fn(() => [
        { provider: 'groq', dailyRemainingPct: 80, score: 9.5, avgLatencyMs: 200, estimatedTokens: 500 },
        { provider: 'cerebras', dailyRemainingPct: 60, score: 8.0, avgLatencyMs: 300, estimatedTokens: 500 },
      ]),
    };
    setFreeTierTrackerGetter(() => mockTracker);

    const { statusCode, body } = await triggerWebhook('free-trigger-hook', { job: 'lint-check' });

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.task_id).toBe('task-submit_task-001');

    // Should call submit_task (not smart_submit_task) with the best free-tier provider
    expect(toolCallSpy).toHaveBeenCalledWith('submit_task', expect.objectContaining({
      task: 'Free-tier job: lint-check',
      provider: 'groq',
      working_directory: '/tmp/free',
      tags: 'free',
    }));

    // Should NOT call smart_submit_task
    const smartCalls = toolCallSpy.mock.calls.filter(c => c[0] === 'smart_submit_task');
    expect(smartCalls).toHaveLength(0);

    // FreeQuotaTracker was consulted with task metadata
    expect(mockTracker.getAvailableProvidersSmart).toHaveBeenCalledWith(
      expect.objectContaining({
        complexity: 'normal',
        descriptionLength: expect.any(Number),
      })
    );
  });

  it('passes complexity from action_config to FreeQuotaTracker', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'complex-free-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Complex free task',
        trigger_type: 'free_tier_task',
        complexity: 'complex',
      },
    });

    const mockTracker = {
      getAvailableProvidersSmart: vi.fn(() => [
        { provider: 'deepinfra', dailyRemainingPct: 70, score: 8.0, avgLatencyMs: 400, estimatedTokens: 2000 },
      ]),
    };
    setFreeTierTrackerGetter(() => mockTracker);

    const { statusCode } = await triggerWebhook('complex-free-hook', {});

    expect(statusCode).toBe(200);
    expect(mockTracker.getAvailableProvidersSmart).toHaveBeenCalledWith(
      expect.objectContaining({ complexity: 'complex' })
    );
  });

  // --- Test 5: Fallback to smart_submit_task when no free-tier providers available ---

  it('falls back to smart_submit_task when FreeQuotaTracker returns no providers', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'no-free-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Needs fallback',
        trigger_type: 'free_tier_task',
        tags: 'overflow',
      },
    });

    const mockTracker = {
      getAvailableProvidersSmart: vi.fn(() => []),
    };
    setFreeTierTrackerGetter(() => mockTracker);

    const { statusCode, body } = await triggerWebhook('no-free-hook', {});

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.task_id).toBe('task-smart_submit_task-001');

    expect(toolCallSpy).toHaveBeenCalledWith('smart_submit_task', expect.objectContaining({
      task: 'Needs fallback',
      free_tier_preferred: true,
    }));

    const submitCalls = toolCallSpy.mock.calls.filter(c => c[0] === 'submit_task');
    expect(submitCalls).toHaveLength(0);
  });

  it('falls back to smart_submit_task when FreeQuotaTracker getter is null', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'null-tracker-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'No tracker',
        trigger_type: 'free_tier_task',
      },
    });

    setFreeTierTrackerGetter(null);

    const { statusCode, body } = await triggerWebhook('null-tracker-hook', {});

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);

    expect(toolCallSpy).toHaveBeenCalledWith('smart_submit_task', expect.objectContaining({
      task: 'No tracker',
      free_tier_preferred: true,
    }));
  });

  it('falls back to smart_submit_task when tracker getter returns null', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'null-tracker-result-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Tracker returns null',
        trigger_type: 'free_tier_task',
      },
    });

    setFreeTierTrackerGetter(() => null);

    const { statusCode } = await triggerWebhook('null-tracker-result-hook', {});

    expect(statusCode).toBe(200);
    expect(toolCallSpy).toHaveBeenCalledWith('smart_submit_task', expect.objectContaining({
      task: 'Tracker returns null',
      free_tier_preferred: true,
    }));
  });

  // --- Test 6: Standard webhooks still use smart_submit_task (regression check) ---

  it('standard webhook (no trigger_type) uses smart_submit_task', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'standard-trigger-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Standard job: {{payload.action}}',
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
      },
    });

    const mockTracker = {
      getAvailableProvidersSmart: vi.fn(() => [
        { provider: 'groq', dailyRemainingPct: 90, score: 10, avgLatencyMs: 100, estimatedTokens: 200 },
      ]),
    };
    setFreeTierTrackerGetter(() => mockTracker);

    const { statusCode, body } = await triggerWebhook('standard-trigger-hook', { action: 'push' });

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.task_id).toBe('task-smart_submit_task-001');

    expect(toolCallSpy).toHaveBeenCalledWith('smart_submit_task', expect.objectContaining({
      task_description: 'Standard job: push',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
    }));

    // FreeQuotaTracker should NOT have been consulted
    expect(mockTracker.getAvailableProvidersSmart).not.toHaveBeenCalled();
  });

  it('standard webhook with trigger_type=standard uses smart_submit_task', async () => {
    // When created via handler, trigger_type: standard is stripped from action_config
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'explicit-std-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Explicit standard',
      },
    });

    const webhook = db.getInboundWebhook('explicit-std-hook');
    expect(webhook.action_config.trigger_type).toBeUndefined();

    const { statusCode, body } = await triggerWebhook('explicit-std-hook', {});

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);

    expect(toolCallSpy).toHaveBeenCalledWith('smart_submit_task', expect.objectContaining({
      task_description: 'Explicit standard',
    }));
  });

  // --- Test 7: Response includes trigger_type and free_tier_provider fields ---

  it('free-tier response includes trigger_type and free_tier_provider when provider found', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'resp-fields-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Check response fields',
        trigger_type: 'free_tier_task',
      },
    });

    const mockTracker = {
      getAvailableProvidersSmart: vi.fn(() => [
        { provider: 'cerebras', dailyRemainingPct: 50, score: 7.5, avgLatencyMs: 250, estimatedTokens: 800 },
      ]),
    };
    setFreeTierTrackerGetter(() => mockTracker);

    const { statusCode, body } = await triggerWebhook('resp-fields-hook', {});

    expect(statusCode).toBe(200);
    expect(body.trigger_type).toBe('free_tier_task');
    expect(body.free_tier_provider).toBe('cerebras');
    expect(body.success).toBe(true);
    expect(body.webhook).toBe('resp-fields-hook');
  });

  it('free-tier response includes trigger_type with null free_tier_provider on fallback', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'resp-fallback-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Fallback response fields',
        trigger_type: 'free_tier_task',
      },
    });

    const mockTracker = {
      getAvailableProvidersSmart: vi.fn(() => []),
    };
    setFreeTierTrackerGetter(() => mockTracker);

    const { statusCode, body } = await triggerWebhook('resp-fallback-hook', {});

    expect(statusCode).toBe(200);
    expect(body.trigger_type).toBe('free_tier_task');
    expect(body.free_tier_provider).toBeNull();
    expect(body.success).toBe(true);
  });

  it('standard response does NOT include trigger_type or free_tier_provider', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'resp-std-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Standard response check',
      },
    });

    const { statusCode, body } = await triggerWebhook('resp-std-hook', {});

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.trigger_type).toBeUndefined();
    expect(body.free_tier_provider).toBeUndefined();
  });

  // --- Error handling ---

  it('returns 500 when submit_task fails for free-tier route', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'fail-free-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Will fail',
        trigger_type: 'free_tier_task',
      },
    });

    const mockTracker = {
      getAvailableProvidersSmart: vi.fn(() => [
        { provider: 'groq', dailyRemainingPct: 90, score: 10, avgLatencyMs: 100, estimatedTokens: 200 },
      ]),
    };
    setFreeTierTrackerGetter(() => mockTracker);

    toolCallSpy.mockReset();
    toolCallSpy.mockImplementation(async (name) => {
      if (name === 'submit_task') {
        throw new Error('Provider unavailable');
      }
      return realHandleToolCall(name, {});
    });

    const { statusCode, body } = await triggerWebhook('fail-free-hook', {});

    expect(statusCode).toBe(500);
    expect(body.error).toContain('Failed to create free-tier task');
    expect(body.error).toContain('Provider unavailable');
  });

  it('returns 500 when smart_submit_task fails on free-tier fallback', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'fail-fallback-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Will fail on fallback',
        trigger_type: 'free_tier_task',
      },
    });

    setFreeTierTrackerGetter(() => ({
      getAvailableProvidersSmart: vi.fn(() => []),
    }));

    toolCallSpy.mockReset();
    toolCallSpy.mockImplementation(async (name) => {
      if (name === 'smart_submit_task') {
        throw new Error('All providers exhausted');
      }
      return realHandleToolCall(name, {});
    });

    const { statusCode, body } = await triggerWebhook('fail-fallback-hook', {});

    expect(statusCode).toBe(500);
    expect(body.error).toContain('no free-tier providers available');
    expect(body.error).toContain('All providers exhausted');
  });

  // --- Payload substitution in free-tier path ---

  it('substitutes payload variables in free-tier task description', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    db.createInboundWebhook({
      name: 'subst-free-hook',
      source_type: 'generic',
      secret,
      action_config: {
        task_description: 'Lint {{payload.repo}} on {{payload.branch}}',
        trigger_type: 'free_tier_task',
      },
    });

    const mockTracker = {
      getAvailableProvidersSmart: vi.fn(() => [
        { provider: 'groq', dailyRemainingPct: 80, score: 9.0, avgLatencyMs: 200, estimatedTokens: 500 },
      ]),
    };
    setFreeTierTrackerGetter(() => mockTracker);

    const { statusCode } = await triggerWebhook('subst-free-hook', { repo: 'torque', branch: 'develop' });

    expect(statusCode).toBe(200);
    expect(toolCallSpy).toHaveBeenCalledWith('submit_task', expect.objectContaining({
      task: 'Lint torque on develop',
    }));
  });
});
