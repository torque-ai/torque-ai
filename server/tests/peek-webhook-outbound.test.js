'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const Database = require('better-sqlite3');

function loadInjectedModule(filePath, injectedModules = {}) {
  const resolvedPath = path.resolve(filePath);
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const requireFromModule = createRequire(resolvedPath);
  const exportedModule = { exports: {} };
  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    source,
  );

  const customRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(injectedModules, request)) {
      return injectedModules[request];
    }
    return requireFromModule(request);
  };

  compiled(customRequire, exportedModule, exportedModule.exports, resolvedPath, path.dirname(resolvedPath));
  return exportedModule.exports;
}

function loadWebhookOutbound(injectedModules = {}) {
  return loadInjectedModule(path.resolve(__dirname, '../plugins/snapscope/handlers/webhook-outbound.js'), injectedModules);
}

function loadPeekRecovery(injectedModules = {}) {
  return loadInjectedModule(path.resolve(__dirname, '../plugins/snapscope/handlers/recovery.js'), injectedModules);
}

function loadPeekArtifacts(injectedModules = {}) {
  return loadInjectedModule(path.resolve(__dirname, '../plugins/snapscope/handlers/artifacts.js'), injectedModules);
}

function loadPeekCompliance(injectedModules = {}) {
  return loadInjectedModule(path.resolve(__dirname, '../plugins/snapscope/handlers/compliance.js'), injectedModules);
}

function createLoggerMock() {
  const instance = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    instance,
    module: {
      child: vi.fn(() => instance),
    },
  };
}

function createRequestModule(options = {}) {
  const calls = [];
  const request = vi.fn((url, requestOptions, onResponse) => {
    const req = new EventEmitter();
    const callRecord = {
      url,
      options: requestOptions,
      req,
      response: null,
    };

    req.write = vi.fn((body) => {
      callRecord.body = body;
    });

    req.end = vi.fn(() => {
      if (options.error) {
        req.emit('error', options.error);
        return;
      }

      if (options.respond === false || typeof onResponse !== 'function') {
        return;
      }

      const res = new EventEmitter();
      res.statusCode = options.statusCode ?? 202;
      res.resume = vi.fn();
      callRecord.response = res;
      onResponse(res);
      res.emit('end');
    });

    req.destroy = vi.fn((error) => {
      if (error) {
        req.emit('error', error);
      }
    });

    calls.push(callRecord);
    return req;
  });

  return {
    request,
    calls,
    module: { request },
  };
}

function eventMatchesSubscription(subscription, event) {
  if (typeof subscription !== 'string') {
    return false;
  }

  if (subscription === '*' || subscription === event) {
    return true;
  }

  return subscription.endsWith('.*') && event.startsWith(subscription.slice(0, -1));
}

function createSubject({ webhooks = [], httpOptions = {}, httpsOptions = {}, internalHost = false } = {}) {
  const logger = createLoggerMock();
  const database = {
    listWebhooks: vi.fn(() => webhooks),
    getWebhooksForEvent: vi.fn((event) => webhooks.filter((webhook) => {
      if (!webhook || webhook.enabled === false) {
        return false;
      }

      const events = Array.isArray(webhook.events) ? webhook.events : [];
      return events.some((subscription) => eventMatchesSubscription(subscription, event));
    })),
    logWebhookDelivery: vi.fn(),
  };
  const shared = {
    isInternalHost: vi.fn(() => internalHost),
  };
  const http = createRequestModule(httpOptions);
  const https = createRequestModule(httpsOptions);
  const mod = loadWebhookOutbound({
    '../../db/webhooks-streaming': database,
    '../../logger': logger.module,
    '../shared': shared,
    http: http.module,
    https: https.module,
  });

  return {
    mod,
    logger,
    database,
    shared,
    http,
    https,
  };
}

function createRecoveryHandlerSubject({ fireWebhookForEvent = vi.fn(() => Promise.resolve({ fired: 1 })) } = {}) {
  const logger = createLoggerMock();
  const database = {
    getConfig: vi.fn(() => null),
    recordRecoveryMetric: vi.fn(),
  };
  const handlerShared = {
    peekHttpGetWithRetry: vi.fn(),
    peekHttpPostWithRetry: vi.fn(async (url) => {
      if (url.endsWith('/recovery/is-allowed-action')) {
        return {
          data: {
            allowed: true,
            action_spec: {
              name: 'restart_service',
              max_retries: 0,
            },
          },
        };
      }

      if (url.endsWith('/recovery/execute')) {
        return {
          data: {
            success: true,
            attempts: 1,
            audit_entry: {
              attempts: 1,
              success: true,
            },
          },
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }),
    resolvePeekHost: vi.fn(() => ({
      hostName: 'peek-host',
      hostUrl: 'http://peek-host',
    })),
    resolvePeekTaskContext: vi.fn(() => ({
      task: { id: 'task-1', requested_by: 'user@example.com' },
      taskId: 'task-1',
      workflowId: null,
      taskLabel: null,
    })),
  };
  const rollback = {
    attachRollbackData: vi.fn((entry) => entry),
    RISK_CLASSIFICATION: {},
    classifyActionRisk: vi.fn(() => ({ level: 'low' })),
    createRollbackPlan: vi.fn(() => null),
    formatPolicyProof: vi.fn(() => ({
      blocked: false,
      passed: 1,
      failed: 0,
    })),
  };
  const liveAutonomy = {
    buildLiveEligibilityRecord: vi.fn((action, riskClassification, mode) => ({
      action,
      risk_level: riskClassification?.level || null,
      live_eligible: false,
      resolved_mode: mode,
      risk_justification: 'mock eligibility',
    })),
  };
  const taskHooks = {
    evaluateAtStage: vi.fn(() => ({
      blocked: false,
      shadow: false,
      summary: { passed: 1, failed: 0, blocked: 0 },
      results: [],
    })),
  };

  const mod = loadPeekRecovery({
    '../shared': {
      ErrorCodes: {
        MISSING_REQUIRED_PARAM: 'missing_required_param',
        INVALID_PARAM: 'invalid_param',
        OPERATION_FAILED: 'operation_failed',
        INTERNAL_ERROR: 'internal_error',
      },
      makeError: (code, message) => ({
        success: false,
        error: { code, message },
      }),
    },
    './shared': handlerShared,
    './rollback': rollback,
    './live-autonomy': liveAutonomy,
    '../../policy-engine/task-hooks': taskHooks,
    './webhook-outbound': { fireWebhookForEvent },
    '../../logger': logger.module,
    '../../db/config-core': database,
    '../../db/peek-recovery-approvals': database,
    '../../db/recovery-metrics': database,
  });

  return {
    mod,
    fireWebhookForEvent,
    database,
    handlerShared,
    logger,
  };
}

function createArtifactsHandlerSubject({ fireWebhookForEvent = vi.fn(() => Promise.resolve({ fired: 1 })) } = {}) {
  const logger = createLoggerMock();
  const fsMock = {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isFile: () => true, size: 256 })),
    readFileSync: vi.fn(() => Buffer.from('{}', 'utf8')),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
  const database = {
    storeArtifact: vi.fn((artifact) => ({
      ...artifact,
      mime_type: artifact.mime_type,
      file_path: artifact.file_path,
    })),
    getWorkflow: vi.fn(() => null),
    updateTask: vi.fn(),
    updateWorkflow: vi.fn(),
  };
  const contracts = {
    attachPeekArtifactReferences: vi.fn((container, refs) => ({
      ...(container || {}),
      peek_bundle_artifacts: refs,
    })),
    mergePeekArtifactReferences: vi.fn((existing, refs) => [
      ...(existing || []),
      ...(refs || []),
    ]),
    normalizePeekArtifactReference: vi.fn((ref) => ref),
  };
  const shared = {
    getTorqueArtifactStorageRoot: vi.fn(() => '/tmp/torque-artifacts'),
    inferPeekArtifactMimeType: vi.fn(() => 'application/json'),
    sanitizePeekTargetKey: vi.fn((value) => value),
  };

  const mod = loadPeekArtifacts({
    fs: fsMock,
    '../../db/task-core': database,
    '../../db/task-metadata': database,
    '../../db/workflow-engine': database,
    '../../db/peek-policy-audit': database,
    '../../contracts/peek': contracts,
    './shared': shared,
    './webhook-outbound': { fireWebhookForEvent },
    '../../logger': logger.module,
  });

  return {
    mod,
    fireWebhookForEvent,
    database,
    fsMock,
    logger,
  };
}

function createComplianceSchema(db) {
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT DEFAULT 'system',
      old_value TEXT,
      new_value TEXT,
      metadata TEXT,
      previous_hash TEXT,
      chain_hash TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE policy_evaluations (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      profile_id TEXT,
      stage TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      project TEXT,
      mode TEXT NOT NULL,
      outcome TEXT NOT NULL,
      severity TEXT,
      message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE policy_proof_audit (
      id TEXT PRIMARY KEY,
      surface TEXT NOT NULL,
      proof_hash TEXT,
      policy_family TEXT,
      decision TEXT,
      context_json TEXT,
      task_id TEXT,
      workflow_id TEXT,
      action TEXT,
      mode TEXT,
      policies_checked INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      warned INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 0,
      proof_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function computeStructuredAuditHash(entry) {
  const payload = {
    entityType: entry.entity_type ?? null,
    entityId: entry.entity_id ?? null,
    action: entry.action ?? null,
    actor: entry.actor ?? 'system',
    oldValue: entry.old_value ?? null,
    newValue: entry.new_value ?? null,
    metadata: entry.metadata ?? null,
    previousHash: entry.previous_hash ?? null,
    timestamp: entry.timestamp || entry.created_at || null,
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function seedComplianceDatabase(db) {
  const auditRow = {
    entity_type: 'task',
    entity_id: 'task-1',
    action: 'peek_recovery',
    actor: 'system',
    old_value: null,
    new_value: null,
    metadata: null,
    previous_hash: null,
    timestamp: '2026-02-01T00:00:00.000Z',
  };
  const chainHash = computeStructuredAuditHash(auditRow);

  db.prepare(`
    INSERT INTO audit_log (
      entity_type, entity_id, action, actor, old_value, new_value, metadata, previous_hash, chain_hash, timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    auditRow.entity_type,
    auditRow.entity_id,
    auditRow.action,
    auditRow.actor,
    auditRow.old_value,
    auditRow.new_value,
    auditRow.metadata,
    auditRow.previous_hash,
    chainHash,
    auditRow.timestamp,
  );

  db.prepare(`
    INSERT INTO policy_evaluations (
      id, policy_id, profile_id, stage, target_type, target_id, project, mode, outcome, severity, message, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    'policy-1',
    null,
    'task_pre_execute',
    'task',
    'task-1',
    'alpha',
    'enforce',
    'pass',
    'low',
    'ok',
    '2026-02-01T00:05:00.000Z',
  );

  db.prepare(`
    INSERT INTO policy_proof_audit (
      id, surface, proof_hash, policy_family, decision, context_json, task_id, workflow_id,
      action, mode, policies_checked, passed, warned, failed, blocked, proof_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    'peek_recovery',
    'proof-hash',
    'peek',
    'allow',
    JSON.stringify({ project: 'alpha' }),
    'task-1',
    null,
    'restart_service',
    'shadow',
    1,
    1,
    0,
    0,
    0,
    JSON.stringify({ blocked: false }),
    '2026-02-01T00:10:00.000Z',
  );
}

function createComplianceHandlerSubject({ fireWebhookForEvent = vi.fn(() => Promise.resolve({ fired: 1 })) } = {}) {
  const logger = createLoggerMock();
  const databaseHandle = new Database(':memory:');
  createComplianceSchema(databaseHandle);
  seedComplianceDatabase(databaseHandle);

  const mod = loadPeekCompliance({
    '../../database': databaseHandle,
    './webhook-outbound': { fireWebhookForEvent },
    './rollback': {
      classifyActionRisk: vi.fn(() => ({ level: 'low' })),
    },
    '../../logger': logger.module,
  });

  return {
    mod,
    fireWebhookForEvent,
    databaseHandle,
    logger,
    dispose() {
      databaseHandle.close();
    },
  };
}

function flushImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('peek/webhook-outbound helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports the expected peek events', () => {
    const { mod } = createSubject();

    expect(mod.PEEK_WEBHOOK_EVENTS).toEqual([
      'peek.recovery.executed',
      'peek.bundle.created',
      'peek.compliance.generated',
    ]);
  });

  it('computeHmacSignature returns a sha256-prefixed HMAC', () => {
    const { mod } = createSubject();
    const expected = `sha256=${crypto.createHmac('sha256', 'secret-key').update('payload').digest('hex')}`;

    expect(mod.computeHmacSignature('payload', 'secret-key')).toBe(expected);
  });

  it('buildWebhookPayload includes event, timestamp, and data', () => {
    const { mod } = createSubject();
    const payload = mod.buildWebhookPayload('peek.bundle.created', { task_id: 'task-1' });

    expect(payload.event).toBe('peek.bundle.created');
    expect(payload.data).toEqual({ task_id: 'task-1' });
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  });

  it('fires matching exact, prefix, and wildcard subscriptions', async () => {
    const { mod, http } = createSubject({
      webhooks: [
        { id: 'wh-exact', url: 'http://example.test/exact', enabled: true, events: ['peek.bundle.created'] },
        { id: 'wh-prefix', url: 'http://example.test/prefix', enabled: true, events: ['peek.*'] },
        { id: 'wh-wild', url: 'http://example.test/wild', enabled: true, events: ['*'] },
        { id: 'wh-disabled', url: 'http://example.test/disabled', enabled: false, events: ['peek.bundle.created'] },
        { id: 'wh-other', url: 'http://example.test/other', enabled: true, events: ['task.completed'] },
      ],
    });

    const result = await mod.fireWebhookForEvent('peek.bundle.created', { task_id: 'task-1' });

    expect(result).toEqual({ fired: 3 });
    await flushImmediate();
    expect(http.request).toHaveBeenCalledTimes(3);
  });

  it('ignores unknown events', async () => {
    const { mod, database, http, logger } = createSubject({
      webhooks: [
        { id: 'wh-1', url: 'http://example.test/hook', enabled: true, events: ['*'] },
      ],
    });

    const result = await mod.fireWebhookForEvent('peek.unknown', { ok: true });

    expect(result).toEqual({ fired: 0 });
    expect(database.listWebhooks).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
    expect(logger.instance.warn).toHaveBeenCalled();
  });

  it('includes a valid X-Torque-Signature header when the webhook has a secret', async () => {
    const { mod, http } = createSubject({
      webhooks: [
        { id: 'wh-secret', url: 'http://example.test/secret', enabled: true, events: ['peek.bundle.created'], secret: 'super-secret' },
      ],
    });

    await mod.fireWebhookForEvent('peek.bundle.created', { task_id: 'task-99' });
    await flushImmediate();

    const [call] = http.calls;
    const payloadBody = call.req.write.mock.calls[0][0];
    const expected = `sha256=${crypto.createHmac('sha256', 'super-secret').update(payloadBody).digest('hex')}`;

    expect(call.options.headers['X-Torque-Signature']).toBe(expected);
    expect(call.options.headers['Content-Length']).toBe(Buffer.byteLength(payloadBody));
  });

  it('returns before the network request is dispatched', async () => {
    const { mod, http } = createSubject({
      webhooks: [
        { id: 'wh-async', url: 'http://example.test/async', enabled: true, events: ['peek.bundle.created'] },
      ],
      httpOptions: { respond: false },
    });

    const result = await mod.fireWebhookForEvent('peek.bundle.created', { task_id: 'task-async' });

    expect(result).toEqual({ fired: 1 });
    expect(http.request).not.toHaveBeenCalled();

    await flushImmediate();
    expect(http.request).toHaveBeenCalledTimes(1);
  });
});

describe('peek handler webhook emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires peek.recovery.executed after a recovery action completes', async () => {
    const { mod, fireWebhookForEvent } = createRecoveryHandlerSubject();

    const result = await mod.handlePeekRecovery({
      action: 'restart_service',
      params: { service: 'spooler' },
    });

    expect(result.success).toBe(true);
    expect(fireWebhookForEvent).toHaveBeenCalledWith(
      'peek.recovery.executed',
      expect.objectContaining({
        action: 'restart_service',
        mode: 'shadow',
        success: true,
      }),
    );
  });

  it('fires peek.bundle.created after persisting a bundle artifact', () => {
    const { mod, fireWebhookForEvent } = createArtifactsHandlerSubject();

    const result = mod.storePeekArtifactsForTask('task-1', [{
      kind: 'bundle_json',
      path: '/tmp/bundle.json',
      name: 'bundle.json',
    }]);

    expect(result).toHaveLength(1);
    expect(fireWebhookForEvent).toHaveBeenCalledWith('peek.bundle.created', {
      task_id: 'task-1',
    });
  });

  it('fires peek.compliance.generated after generating a compliance report', () => {
    const subject = createComplianceHandlerSubject();

    try {
      const report = subject.mod.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-03-01T00:00:00.000Z',
        project: 'alpha',
      });

      expect(report.report_id).toBeTruthy();
      expect(subject.fireWebhookForEvent).toHaveBeenCalledWith('peek.compliance.generated', {
        report_id: report.report_id,
      });
    } finally {
      subject.dispose();
    }
  });

  it('does not block the primary operation when webhook dispatch fails', async () => {
    const subject = createComplianceHandlerSubject({
      fireWebhookForEvent: vi.fn(() => Promise.reject(new Error('webhook down'))),
    });

    try {
      const report = subject.mod.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-03-01T00:00:00.000Z',
        project: 'alpha',
      });

      expect(report.report_id).toBeTruthy();
      await flushImmediate();
      expect(subject.fireWebhookForEvent).toHaveBeenCalledWith(
        'peek.compliance.generated',
        expect.objectContaining({ report_id: report.report_id }),
      );
    } finally {
      subject.dispose();
    }
  });
});