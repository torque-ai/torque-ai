const { randomUUID } = require('crypto');
const taskCore = require('../db/task-core');
const { setupTestDbModule, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

let testDir, mod;

function setup() {
  ({ mod, testDir } = setupTestDbModule('../db/webhooks-streaming', 'webhooks'));
}

function rawDb() {
  return _rawDb();
}

function resetState() {
  const conn = rawDb();
  const tables = [
    'stream_chunks',
    'task_streams',
    'webhook_logs',
    'webhooks',
    'task_event_subscriptions',
    'task_events',
    'task_checkpoints',
    'analytics',
    'coordination_events',
    'tasks'
  ];

  for (const table of tables) {
    conn.prepare(`DELETE FROM ${table}`).run();
  }
}

function makeTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'webhooks-streaming test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    priority: overrides.priority ?? 0,
    project: overrides.project || null,
    provider: overrides.provider || 'codex'
  };

  taskCore.createTask(task);
  return taskCore.getTask(task.id);
}

function makeWebhook(overrides = {}) {
  return mod.createWebhook({
    id: overrides.id || randomUUID(),
    name: overrides.name || 'Webhook',
    url: overrides.url || 'https://example.test/hook',
    type: overrides.type || 'http',
    events: overrides.events || ['task.completed'],
    project: overrides.project === undefined ? null : overrides.project,
    headers: overrides.headers === undefined ? null : overrides.headers,
    secret: overrides.secret === undefined ? null : overrides.secret,
    retryCount: overrides.retryCount === undefined ? 3 : overrides.retryCount
  });
}

function insertWebhookLogs(webhookId, count, options = {}) {
  const conn = rawDb();
  const stmt = conn.prepare(`
    INSERT INTO webhook_logs (webhook_id, event, task_id, payload, response_status, response_body, success, error, triggered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const baseMs = options.baseMs || Date.parse('2026-01-01T00:00:00.000Z');
  const success = options.success === undefined ? 1 : options.success;

  const tx = conn.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      stmt.run(
        webhookId,
        'task.completed',
        null,
        '{"ok":true}',
        200,
        'ok',
        success,
        success ? null : 'error',
        new Date(baseMs + i * 1000).toISOString()
      );
    }
  });

  tx();
}

function seedStreamChunks(streamId, count) {
  const conn = rawDb();
  const stmt = conn.prepare(`
    INSERT INTO stream_chunks (stream_id, chunk_data, chunk_type, sequence_num, timestamp)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const tx = conn.transaction(() => {
    for (let i = 1; i <= count; i += 1) {
      stmt.run(streamId, `chunk-${i}`, 'stdout', i);
    }
  });

  tx();
}

function seedForEventTableLimits(analyticsCount, coordCount) {
  const conn = rawDb();
  const digitCte = 'WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))';

  if (analyticsCount > 0) {
    const fullHundredThousands = Math.floor(analyticsCount / 100000);
    const remainder = analyticsCount % 100000;

    for (let i = 0; i < fullHundredThousands; i += 1) {
      conn.exec(`
        ${digitCte}
        INSERT INTO analytics (event_type, task_id, data, timestamp)
        SELECT 'bulk', NULL, NULL, '2026-01-01T00:00:00.000Z'
        FROM digits a, digits b, digits c, digits d, digits e
      `);
    }

    if (remainder > 0) {
      conn.exec(`
        ${digitCte}
        INSERT INTO analytics (event_type, task_id, data, timestamp)
        SELECT 'bulk', NULL, NULL, '2026-01-01T00:00:00.000Z'
        FROM digits a, digits b, digits c, digits d, digits e
        LIMIT ${remainder}
      `);
    }
  }

  if (coordCount > 0) {
    const fullHundredThousands = Math.floor(coordCount / 100000);
    const remainder = coordCount % 100000;

    for (let i = 0; i < fullHundredThousands; i += 1) {
      conn.exec(`
        ${digitCte}
        INSERT INTO coordination_events (event_type, agent_id, task_id, details, created_at)
        SELECT 'bulk', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z'
        FROM digits a, digits b, digits c, digits d, digits e
      `);
    }

    if (remainder > 0) {
      conn.exec(`
        ${digitCte}
        INSERT INTO coordination_events (event_type, agent_id, task_id, details, created_at)
        SELECT 'bulk', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z'
        FROM digits a, digits b, digits c, digits d, digits e
        LIMIT ${remainder}
      `);
    }
  }
}

describe('webhooks-streaming db module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { resetState(); });

  describe('webhooks', () => {
    it('createWebhook persists defaults and parses JSON fields', () => {
      const webhook = mod.createWebhook({
        id: 'wh-create',
        name: 'Create Hook',
        url: 'https://example.test/create',
        events: ['task.completed'],
        headers: { Authorization: 'Bearer token' }
      });

      expect(webhook.id).toBe('wh-create');
      expect(webhook.type).toBe('http');
      expect(webhook.events).toEqual(['task.completed']);
      expect(webhook.headers).toEqual({ Authorization: 'Bearer token' });
      expect(webhook.retry_count).toBe(3);
      expect(webhook.enabled).toBe(true);
    });

    it('getWebhook returns null for unknown id', () => {
      expect(mod.getWebhook('missing-webhook')).toBeNull();
    });

    it('listWebhooks includes project-specific and global hooks for a project filter', () => {
      makeWebhook({ id: 'wh-global', project: null });
      makeWebhook({ id: 'wh-alpha', project: 'alpha' });
      makeWebhook({ id: 'wh-beta', project: 'beta' });

      const list = mod.listWebhooks('alpha').map(w => w.id).sort();
      expect(list).toEqual(['wh-alpha', 'wh-global']);
    });

    it('updateWebhook updates only provided fields and converts booleans/counts', () => {
      makeWebhook({ id: 'wh-update', events: ['task.completed'], headers: { A: '1' } });

      const updated = mod.updateWebhook('wh-update', {
        name: 'Updated Name',
        url: 'https://example.test/new-url',
        type: 'slack',
        events: ['*'],
        project: 'p1',
        headers: null,
        secret: 'sec-2',
        enabled: false,
        retryCount: 9
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.url).toBe('https://example.test/new-url');
      expect(updated.type).toBe('slack');
      expect(updated.events).toEqual(['*']);
      expect(updated.project).toBe('p1');
      expect(updated.headers).toBeNull();
      expect(updated.secret).toBe('sec-2');
      expect(updated.enabled).toBe(false);
      expect(updated.retry_count).toBe(9);
    });

    it('updateWebhook returns existing webhook when no allowed fields are supplied', () => {
      makeWebhook({ id: 'wh-noop', name: 'Before' });

      const unchanged = mod.updateWebhook('wh-noop', { ignored: true });
      expect(unchanged.name).toBe('Before');
      expect(unchanged.id).toBe('wh-noop');
    });

    it('deleteWebhook removes logs then webhook and returns false when missing', () => {
      const task = makeTask();
      makeWebhook({ id: 'wh-delete' });
      mod.logWebhookDelivery({
        webhookId: 'wh-delete',
        event: 'task.completed',
        taskId: task.id,
        payload: { ok: true },
        responseStatus: 200,
        responseBody: 'ok',
        success: true,
        error: null
      });

      expect(mod.deleteWebhook('wh-delete')).toBe(true);
      expect(mod.getWebhook('wh-delete')).toBeNull();
      const logCount = rawDb().prepare('SELECT COUNT(*) AS c FROM webhook_logs WHERE webhook_id = ?').get('wh-delete').c;
      expect(logCount).toBe(0);
      expect(mod.deleteWebhook('wh-delete')).toBe(false);
    });

    it('getWebhooksForEvent matches exact and wildcard events and respects project/enabled', () => {
      makeWebhook({ id: 'wh-exact', project: 'alpha', events: ['task.completed'] });
      makeWebhook({ id: 'wh-wild', project: null, events: ['*'] });
      makeWebhook({ id: 'wh-other', project: 'alpha', events: ['task.failed'] });
      makeWebhook({ id: 'wh-beta', project: 'beta', events: ['task.completed'] });
      makeWebhook({ id: 'wh-disabled', project: 'alpha', events: ['task.completed'] });
      mod.updateWebhook('wh-disabled', { enabled: false });

      const alphaMatches = mod.getWebhooksForEvent('task.completed', 'alpha').map(w => w.id).sort();
      expect(alphaMatches).toEqual(['wh-exact', 'wh-wild']);

      const nullProjectMatches = mod.getWebhooksForEvent('task.completed', null).map(w => w.id);
      expect(nullProjectMatches).toEqual(['wh-wild']);
    });

    it('logWebhookDelivery stores successful log and updates webhook success counters', () => {
      const task = makeTask();
      makeWebhook({ id: 'wh-success' });

      mod.logWebhookDelivery({
        webhookId: 'wh-success',
        event: 'task.completed',
        taskId: task.id,
        payload: { result: 'ok' },
        responseStatus: 200,
        responseBody: 'OK',
        success: true,
        error: null
      });

      const webhook = mod.getWebhook('wh-success');
      const logs = mod.getWebhookLogs('wh-success', 5);

      expect(webhook.success_count).toBe(1);
      expect(webhook.failure_count).toBe(0);
      expect(webhook.last_triggered_at).toBeTruthy();
      expect(logs).toHaveLength(1);
      expect(logs[0].payload).toEqual({ result: 'ok' });
      expect(logs[0].success).toBe(true);
    });

    it('logWebhookDelivery stores failed log and updates failure counters', () => {
      const task = makeTask();
      makeWebhook({ id: 'wh-failure' });

      mod.logWebhookDelivery({
        webhookId: 'wh-failure',
        event: 'task.failed',
        taskId: task.id,
        payload: { result: 'bad' },
        responseStatus: 500,
        responseBody: 'FAIL',
        success: false,
        error: 'network error'
      });

      const webhook = mod.getWebhook('wh-failure');
      const logs = mod.getWebhookLogs('wh-failure', 5);

      expect(webhook.success_count).toBe(0);
      expect(webhook.failure_count).toBe(1);
      expect(logs[0].success).toBe(false);
      expect(logs[0].error).toBe('network error');
    });

    it('getWebhookLogs enforces limit and returns newest first', () => {
      makeWebhook({ id: 'wh-logs' });
      insertWebhookLogs('wh-logs', 2, { baseMs: Date.parse('2026-01-01T00:00:00.000Z'), success: 1 });

      const conn = rawDb();
      const ids = conn.prepare('SELECT id FROM webhook_logs WHERE webhook_id = ? ORDER BY id ASC').all('wh-logs').map(r => r.id);
      conn.prepare('UPDATE webhook_logs SET triggered_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', ids[0]);
      conn.prepare('UPDATE webhook_logs SET triggered_at = ? WHERE id = ?').run('2026-01-01T00:10:00.000Z', ids[1]);

      const logs = mod.getWebhookLogs('wh-logs', 1);
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBe(ids[1]);
    });
    it('getWebhookStats reports active webhooks and only last-24h deliveries', () => {
      makeWebhook({ id: 'wh-stats-1' });
      makeWebhook({ id: 'wh-stats-2' });
      mod.updateWebhook('wh-stats-2', { enabled: false });

      insertWebhookLogs('wh-stats-1', 1, { baseMs: Date.parse('2026-01-01T00:00:00.000Z'), success: 1 });
      insertWebhookLogs('wh-stats-1', 1, { baseMs: Date.now(), success: 0 });

      const conn = rawDb();
      const oldest = conn.prepare('SELECT id FROM webhook_logs ORDER BY id ASC LIMIT 1').get().id;
      conn.prepare('UPDATE webhook_logs SET triggered_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', oldest);

      const stats = mod.getWebhookStats();
      expect(stats.webhooks.total).toBe(2);
      expect(stats.webhooks.active).toBe(1);
      expect(stats.deliveries_24h.total).toBe(1);
      expect(stats.deliveries_24h.successful).toBe(0);
      expect(stats.deliveries_24h.failed).toBe(1);
    });

    it('cleanupWebhookLogs removes logs older than cutoff and bounds daysToKeep', () => {
      makeWebhook({ id: 'wh-clean' });
      insertWebhookLogs('wh-clean', 1, { baseMs: Date.now() - 10 * 24 * 60 * 60 * 1000, success: 1 });
      insertWebhookLogs('wh-clean', 1, { baseMs: Date.now(), success: 1 });

      const deleted = mod.cleanupWebhookLogs(7);
      expect(deleted).toBe(1);

      insertWebhookLogs('wh-clean', 1, { baseMs: Date.now() - 2 * 24 * 60 * 60 * 1000, success: 1 });
      const boundedDelete = mod.cleanupWebhookLogs(-5);
      expect(boundedDelete).toBe(1);
    });

    it('enforceWebhookLogLimits clamps min limit to 1000 and deletes oldest overflow', () => {
      makeWebhook({ id: 'wh-limit' });
      insertWebhookLogs('wh-limit', 1005, { baseMs: Date.parse('2026-01-01T00:00:00.000Z'), success: 1 });

      const deleted = mod.enforceWebhookLogLimits(10);
      const count = rawDb().prepare('SELECT COUNT(*) AS c FROM webhook_logs').get().c;

      expect(deleted).toBe(5);
      expect(count).toBe(1000);
    });

    it('cleanupStaleWebhookRetries removes only old failed deliveries', () => {
      makeWebhook({ id: 'wh-retries' });
      insertWebhookLogs('wh-retries', 1, { baseMs: Date.now() - 10 * 24 * 60 * 60 * 1000, success: 0 });
      insertWebhookLogs('wh-retries', 1, { baseMs: Date.now(), success: 0 });
      insertWebhookLogs('wh-retries', 1, { baseMs: Date.now() - 10 * 24 * 60 * 60 * 1000, success: 1 });

      const deleted = mod.cleanupStaleWebhookRetries(7);
      const remainingFailed = rawDb().prepare('SELECT COUNT(*) AS c FROM webhook_logs WHERE success = 0').get().c;
      const remainingSuccess = rawDb().prepare('SELECT COUNT(*) AS c FROM webhook_logs WHERE success = 1').get().c;

      expect(deleted).toBe(1);
      expect(remainingFailed).toBe(1);
      expect(remainingSuccess).toBe(1);
    });
  });

  describe('streaming', () => {
    it('createTaskStream creates a stream row for task', () => {
      const task = makeTask();
      const streamId = mod.createTaskStream(task.id, 'output');

      expect(typeof streamId).toBe('string');
      const row = rawDb().prepare('SELECT * FROM task_streams WHERE id = ?').get(streamId);
      expect(row.task_id).toBe(task.id);
      expect(row.stream_type).toBe('output');
    });

    it('getOrCreateTaskStream reuses existing stream for same task/type and creates per type', () => {
      const task = makeTask();
      const first = mod.getOrCreateTaskStream(task.id, 'output');
      const second = mod.getOrCreateTaskStream(task.id, 'output');
      const stderrStream = mod.getOrCreateTaskStream(task.id, 'stderr');

      expect(second).toBe(first);
      expect(stderrStream).not.toBe(first);
    });

    it('addStreamChunk increments sequence numbers for a stream', () => {
      const task = makeTask();
      const streamId = mod.getOrCreateTaskStream(task.id, 'output');

      const seq1 = mod.addStreamChunk(streamId, 'first line');
      const seq2 = mod.addStreamChunk(streamId, 'second line', 'stderr');

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);

      const rows = rawDb().prepare('SELECT sequence_num, chunk_type FROM stream_chunks WHERE stream_id = ? ORDER BY sequence_num ASC').all(streamId);
      expect(rows).toEqual([
        { sequence_num: 1, chunk_type: 'stdout' },
        { sequence_num: 2, chunk_type: 'stderr' }
      ]);
    });

    it('addStreamChunk truncates chunk data larger than max chunk size', () => {
      const task = makeTask();
      const streamId = mod.getOrCreateTaskStream(task.id, 'output');
      const oversized = 'x'.repeat(70000);

      const seq = mod.addStreamChunk(streamId, oversized);
      const row = rawDb().prepare('SELECT chunk_data FROM stream_chunks WHERE stream_id = ? AND sequence_num = ?').get(streamId, seq);

      expect(row.chunk_data.includes('[...truncated...]')).toBe(true);
      expect(row.chunk_data.length).toBeGreaterThan(65536);
      expect(row.chunk_data.startsWith('x')).toBe(true);
    });

    it('addStreamChunk prunes oldest chunks when stream count limit is reached', () => {
      const task = makeTask();
      const streamId = mod.getOrCreateTaskStream(task.id, 'output');
      seedStreamChunks(streamId, 10000);

      const nextSeq = mod.addStreamChunk(streamId, 'after-limit');
      const conn = rawDb();
      const count = conn.prepare('SELECT COUNT(*) AS c FROM stream_chunks WHERE stream_id = ?').get(streamId).c;
      const minSeq = conn.prepare('SELECT MIN(sequence_num) AS s FROM stream_chunks WHERE stream_id = ?').get(streamId).s;
      const maxSeq = conn.prepare('SELECT MAX(sequence_num) AS s FROM stream_chunks WHERE stream_id = ?').get(streamId).s;

      expect(nextSeq).toBe(10001);
      expect(count).toBe(9001);
      expect(minSeq).toBe(1001);
      expect(maxSeq).toBe(10001);
    });

    it('getStreamChunks applies chunkType and since filters in ascending sequence order', () => {
      const task = makeTask();
      const streamId = mod.getOrCreateTaskStream(task.id, 'output');

      mod.addStreamChunk(streamId, 'first', 'stdout');
      mod.addStreamChunk(streamId, 'second', 'stderr');
      mod.addStreamChunk(streamId, 'third', 'stderr');

      const conn = rawDb();
      const rows = conn.prepare('SELECT id, sequence_num FROM stream_chunks WHERE stream_id = ? ORDER BY sequence_num ASC').all(streamId);
      conn.prepare('UPDATE stream_chunks SET timestamp = ? WHERE id = ?').run('2026-01-01 00:00:00', rows[0].id);
      conn.prepare('UPDATE stream_chunks SET timestamp = ? WHERE id = ?').run('2026-01-01 00:10:00', rows[1].id);
      conn.prepare('UPDATE stream_chunks SET timestamp = ? WHERE id = ?').run('2026-01-01 00:20:00', rows[2].id);

      const filtered = mod.getStreamChunks(task.id, {
        chunkType: 'stderr',
        since: '2026-01-01 00:05:00'
      });

      expect(filtered.map(c => c.sequence_num)).toEqual([2, 3]);
      expect(filtered.every(c => c.chunk_type === 'stderr')).toBe(true);
    });

    it('getStreamChunks supports limit and offset pagination', () => {
      const task = makeTask();
      const streamId = mod.getOrCreateTaskStream(task.id, 'output');

      for (let i = 0; i < 5; i += 1) {
        mod.addStreamChunk(streamId, `line-${i + 1}`);
      }

      const page = mod.getStreamChunks(task.id, { limit: 2, offset: 1 });
      expect(page.map(c => c.sequence_num)).toEqual([2, 3]);
    });

    it('getLatestStreamChunks returns only chunks after the provided sequence', () => {
      const task = makeTask();
      const streamId = mod.getOrCreateTaskStream(task.id, 'output');

      for (let i = 0; i < 5; i += 1) {
        mod.addStreamChunk(streamId, `line-${i + 1}`);
      }

      const latest = mod.getLatestStreamChunks(task.id, 3, 10);
      expect(latest.map(c => c.sequence_num)).toEqual([4, 5]);
    });

    it('getTaskLogs applies level and search filters over stream chunks', () => {
      const task = makeTask();
      const streamId = mod.getOrCreateTaskStream(task.id, 'output');
      mod.addStreamChunk(streamId, 'all good', 'stdout');
      mod.addStreamChunk(streamId, 'warning details', 'stderr');
      mod.addStreamChunk(streamId, 'error happened in stdout', 'stdout');
      mod.addStreamChunk(streamId, 'fatal stderr', 'stderr');

      const errors = mod.getTaskLogs(task.id, { level: 'error' });
      const warns = mod.getTaskLogs(task.id, { level: 'warn', search: 'warning' });

      expect(errors.length).toBe(3);
      expect(errors.every(l => l.type === 'stderr' || /error/i.test(l.content))).toBe(true);
      // search is literal (no regex alternation) so only 'warning' matches
      expect(warns.map(l => l.content)).toEqual(['warning details']);
    });

    it('cleanupStreamData deletes streams/chunks older than cutoff', () => {
      const task = makeTask();
      const oldStream = mod.createTaskStream(task.id, 'old');
      const newStream = mod.createTaskStream(task.id, 'new');

      mod.addStreamChunk(oldStream, 'old-chunk');
      mod.addStreamChunk(newStream, 'new-chunk');

      const conn = rawDb();
      conn.prepare('UPDATE task_streams SET created_at = ? WHERE id = ?').run(
        new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        oldStream
      );
      conn.prepare('UPDATE task_streams SET created_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        newStream
      );

      const deleted = mod.cleanupStreamData(7);
      const remaining = conn.prepare('SELECT id FROM task_streams ORDER BY id').all().map(r => r.id);
      const chunkCount = conn.prepare('SELECT COUNT(*) AS c FROM stream_chunks').get().c;

      expect(deleted).toBe(1);
      expect(remaining).toEqual([newStream]);
      expect(chunkCount).toBe(1);
    });
  });

  describe('event subscriptions and event cleanup', () => {
    it('createEventSubscription stores event types and expiration timestamp', () => {
      const task = makeTask();
      const withExpiry = mod.createEventSubscription(task.id, ['status_change'], 30);
      const noExpiry = mod.createEventSubscription(task.id, ['*'], 0);

      const conn = rawDb();
      const subA = conn.prepare('SELECT * FROM task_event_subscriptions WHERE id = ?').get(withExpiry);
      const subB = conn.prepare('SELECT * FROM task_event_subscriptions WHERE id = ?').get(noExpiry);

      expect(subA.task_id).toBe(task.id);
      expect(JSON.parse(subA.event_types)).toEqual(['status_change']);
      expect(subA.expires_at).toBeTruthy();
      expect(subB.expires_at).toBeNull();
    });
    it('pollSubscription returns null for unknown subscription', () => {
      expect(mod.pollSubscription('missing-sub')).toBeNull();
    });

    it('recordTaskEvent and getTaskEvents return latest first with limit', () => {
      const task = makeTask();
      mod.recordTaskEvent(task.id, 'status_change', 'queued', 'running', { reason: 'start' });
      mod.recordTaskEvent(task.id, 'progress', '10', '20', { pct: 20 });

      const conn = rawDb();
      const ids = conn.prepare('SELECT id FROM task_events WHERE task_id = ? ORDER BY id ASC').all(task.id);
      conn.prepare('UPDATE task_events SET created_at = ? WHERE id = ?').run('2026-01-01 00:00:00', ids[0].id);
      conn.prepare('UPDATE task_events SET created_at = ? WHERE id = ?').run('2026-01-01 00:10:00', ids[1].id);

      const events = mod.getTaskEvents(task.id, { limit: 1 });
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('progress');
      expect(typeof events[0].event_data).toBe('string');
      expect(JSON.parse(events[0].event_data)).toEqual({ pct: 20 });
    });

    it('getTaskEvents filters by eventType and since', () => {
      const task = makeTask();
      mod.recordTaskEvent(task.id, 'status_change', 'queued', 'running', { a: 1 });
      mod.recordTaskEvent(task.id, 'status_change', 'running', 'paused', { a: 2 });
      mod.recordTaskEvent(task.id, 'progress', '20', '30', { a: 3 });

      const conn = rawDb();
      const all = conn.prepare(`
        SELECT id FROM task_events
        WHERE task_id = ? AND event_type IN ('status_change', 'progress')
        ORDER BY id ASC
      `).all(task.id);
      conn.prepare('UPDATE task_events SET created_at = ? WHERE id = ?').run('2026-01-01 00:00:00', all[0].id);
      conn.prepare('UPDATE task_events SET created_at = ? WHERE id = ?').run('2026-01-01 00:10:00', all[1].id);
      conn.prepare('UPDATE task_events SET created_at = ? WHERE id = ?').run('2026-01-01 00:20:00', all[2].id);

      const filtered = mod.getTaskEvents(task.id, {
        eventType: 'status_change',
        since: '2026-01-01 00:05:00'
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].new_value).toBe('paused');
    });

    it('pollSubscription returns unread events once and updates last_poll_at', () => {
      const task = makeTask();
      const subId = mod.createEventSubscription(task.id, ['status_change'], 60);

      const conn = rawDb();
      conn.prepare('UPDATE task_event_subscriptions SET created_at = ?, last_poll_at = ? WHERE id = ?').run(
        '2026-01-01 00:00:00',
        '2026-01-01 00:00:00',
        subId
      );

      mod.recordTaskEvent(task.id, 'status_change', 'queued', 'running', { pass: 1 });
      mod.recordTaskEvent(task.id, 'progress', '0', '10', { pass: 1 });

      const firstPoll = mod.pollSubscription(subId);
      const secondPoll = mod.pollSubscription(subId);
      const updatedSub = conn.prepare('SELECT last_poll_at FROM task_event_subscriptions WHERE id = ?').get(subId);

      expect(firstPoll.expired).toBe(false);
      expect(firstPoll.events).toHaveLength(1);
      expect(firstPoll.events[0].event_type).toBe('status_change');
      expect(secondPoll.events).toHaveLength(0);
      expect(updatedSub.last_poll_at).toBeTruthy();
    });

    it('pollSubscription enforces task filter and supports wildcard event types', () => {
      const taskA = makeTask();
      const taskB = makeTask();
      const subTaskOnly = mod.createEventSubscription(taskA.id, ['*'], 60);
      const subGlobal = mod.createEventSubscription(null, ['*'], 60);

      const conn = rawDb();
      conn.prepare('UPDATE task_event_subscriptions SET created_at = ? WHERE id IN (?, ?)').run(
        '2026-01-01 00:00:00',
        subTaskOnly,
        subGlobal
      );
      conn.prepare('UPDATE task_events SET created_at = ? WHERE event_type = ?').run(
        '2000-01-01 00:00:00',
        'task.created'
      );

      mod.recordTaskEvent(taskA.id, 'status_change', 'queued', 'running', { x: 1 });
      mod.recordTaskEvent(taskB.id, 'progress', '1', '2', { x: 2 });

      const taskOnly = mod.pollSubscription(subTaskOnly);
      const global = mod.pollSubscription(subGlobal);

      expect(taskOnly.events).toHaveLength(1);
      expect(taskOnly.events[0].task_id).toBe(taskA.id);
      expect(global.events).toHaveLength(2);
    });

    it('pollSubscription returns expired response and deletes expired subscription', () => {
      const task = makeTask();
      const subId = mod.createEventSubscription(task.id, ['*'], 60);
      rawDb().prepare('UPDATE task_event_subscriptions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', subId);

      const result = mod.pollSubscription(subId);
      const stillThere = rawDb().prepare('SELECT id FROM task_event_subscriptions WHERE id = ?').get(subId);

      expect(result).toEqual({ expired: true, events: [] });
      expect(stillThere).toBeUndefined();
    });

    it('deleteEventSubscription returns true when deleted and false when missing', () => {
      const subId = mod.createEventSubscription(null, ['*'], 60);
      expect(mod.deleteEventSubscription(subId)).toBe(true);
      expect(mod.deleteEventSubscription(subId)).toBe(false);
    });

    it('cleanupEventData removes expired subscriptions and old events', () => {
      const task = makeTask();
      const oldSub = mod.createEventSubscription(task.id, ['*'], 60);
      const keepSub = mod.createEventSubscription(task.id, ['*'], 60);

      rawDb().prepare('UPDATE task_event_subscriptions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', oldSub);
      rawDb().prepare('UPDATE task_event_subscriptions SET expires_at = ? WHERE id = ?').run('2999-01-01T00:00:00.000Z', keepSub);

      mod.recordTaskEvent(task.id, 'status_change', 'a', 'b', { old: true });
      mod.recordTaskEvent(task.id, 'status_change', 'b', 'c', { old: false });
      const ids = rawDb().prepare('SELECT id FROM task_events ORDER BY id ASC').all().map(r => r.id);
      rawDb().prepare('UPDATE task_events SET created_at = ? WHERE id = ?').run('2000-01-01 00:00:00', ids[0]);
      rawDb().prepare('UPDATE task_events SET created_at = ? WHERE id = ?').run('2999-01-01 00:00:00', ids[1]);

      const deletedEvents = mod.cleanupEventData(7);
      const subCount = rawDb().prepare('SELECT COUNT(*) AS c FROM task_event_subscriptions').get().c;

      expect(deletedEvents).toBe(1);
      expect(subCount).toBe(1);
    });

    it('cleanupAnalytics deletes old analytics rows based on bounded retention', () => {
      const conn = rawDb();
      conn.prepare('INSERT INTO analytics (event_type, task_id, data, timestamp) VALUES (?, ?, ?, ?)').run('evt', null, null, '2000-01-01T00:00:00.000Z');
      conn.prepare('INSERT INTO analytics (event_type, task_id, data, timestamp) VALUES (?, ?, ?, ?)').run('evt', null, null, new Date().toISOString());

      const deleted = mod.cleanupAnalytics(30);
      const count = conn.prepare('SELECT COUNT(*) AS c FROM analytics').get().c;

      expect(deleted).toBe(1);
      expect(count).toBe(1);
    });

    it('cleanupCoordinationEvents deletes old rows based on bounded retention', () => {
      const conn = rawDb();
      conn.prepare('INSERT INTO coordination_events (event_type, agent_id, task_id, details, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('evt', null, null, null, '2000-01-01T00:00:00.000Z');
      conn.prepare('INSERT INTO coordination_events (event_type, agent_id, task_id, details, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('evt', null, null, null, new Date().toISOString());

      const deleted = mod.cleanupCoordinationEvents(14);
      const count = conn.prepare('SELECT COUNT(*) AS c FROM coordination_events').get().c;

      expect(deleted).toBe(1);
      expect(count).toBe(1);
    });

    it('enforceEventTableLimits returns 0 when under limits', () => {
      const conn = rawDb();
      conn.prepare('INSERT INTO analytics (event_type, task_id, data, timestamp) VALUES (?, ?, ?, ?)').run('evt', null, null, new Date().toISOString());
      conn.prepare('INSERT INTO coordination_events (event_type, agent_id, task_id, details, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('evt', null, null, null, new Date().toISOString());

      expect(mod.enforceEventTableLimits()).toBe(0);
    });

    it('enforceEventTableLimits trims analytics and coordination tables above hard limits', () => {
      seedForEventTableLimits(100100, 50550);

      const deleted = mod.enforceEventTableLimits();
      const conn = rawDb();
      const analyticsCount = conn.prepare('SELECT COUNT(*) AS c FROM analytics').get().c;
      const coordCount = conn.prepare('SELECT COUNT(*) AS c FROM coordination_events').get().c;

      expect(deleted).toBe(2150);
      expect(analyticsCount).toBe(99000);
      expect(coordCount).toBe(49500);
    });

    it('enforceEventTableLimits trims stream chunks and task events above hard limits', () => {
      const task = makeTask();
      const streamId = mod.createTaskStream(task.id, 'output');
      seedStreamChunks(streamId, 6);
      for (let i = 0; i < 5; i += 1) {
        mod.recordTaskEvent(task.id, 'progress', String(i), String(i + 1), { pct: i + 1 });
      }

      const deleted = mod.enforceEventTableLimits({
        maxStreamChunks: 3,
        maxTaskEvents: 2,
      });
      const conn = rawDb();
      const chunkCount = conn.prepare('SELECT COUNT(*) AS c FROM stream_chunks').get().c;
      const eventCount = conn.prepare('SELECT COUNT(*) AS c FROM task_events').get().c;

      expect(deleted).toBe(7);
      expect(chunkCount).toBe(3);
      expect(eventCount).toBe(2);
    });
  });

  describe('checkpoints and pause', () => {
    it('saveTaskCheckpoint stores checkpoint and getTaskCheckpoint returns parsed latest checkpoint', () => {
      const task = makeTask({ status: 'running' });

      const rowId = mod.saveTaskCheckpoint(task.id, { cursor: 12, files: ['a.txt'] }, 'pause');
      const checkpoint = mod.getTaskCheckpoint(task.id);

      expect(typeof rowId).toBe('number');
      expect(rowId).toBeGreaterThan(0);
      expect(checkpoint.task_id).toBe(task.id);
      expect(checkpoint.checkpoint_type).toBe('pause');
      expect(checkpoint.checkpoint_data).toEqual({ cursor: 12, files: ['a.txt'] });
    });

    it('getTaskCheckpoint returns null when task has no checkpoints', () => {
      const task = makeTask();
      expect(mod.getTaskCheckpoint(task.id)).toBeUndefined();
    });

    it('getTaskCheckpoints returns all checkpoints ordered newest first with parsed JSON', () => {
      const task = makeTask({ status: 'running' });
      mod.saveTaskCheckpoint(task.id, { step: 1 }, 'pause');
      mod.saveTaskCheckpoint(task.id, { step: 2 }, 'pause');

      const conn = rawDb();
      const ids = conn.prepare('SELECT id FROM task_checkpoints WHERE task_id = ? ORDER BY id ASC').all(task.id);
      conn.prepare('UPDATE task_checkpoints SET created_at = ? WHERE id = ?').run('2026-01-01 00:00:00', ids[0].id);
      conn.prepare('UPDATE task_checkpoints SET created_at = ? WHERE id = ?').run('2026-01-01 00:10:00', ids[1].id);

      const checkpoints = mod.getTaskCheckpoints(task.id);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0].checkpoint_data).toEqual({ step: 2 });
      expect(checkpoints[1].checkpoint_data).toEqual({ step: 1 });
    });
    it('deleteTaskCheckpoints removes all checkpoints for a task', () => {
      const task = makeTask({ status: 'running' });
      mod.saveTaskCheckpoint(task.id, { a: 1 });
      mod.saveTaskCheckpoint(task.id, { a: 2 });

      const deleted = mod.deleteTaskCheckpoints(task.id);
      expect(deleted).toBe(2);
      expect(mod.getTaskCheckpoints(task.id)).toEqual([]);
    });

    it('pauseTask sets paused state and records status_change task event', () => {
      const task = makeTask({ status: 'running' });

      const ok = mod.pauseTask(task.id, 'manual pause');
      const after = taskCore.getTask(task.id);
      const events = mod.getTaskEvents(task.id, { eventType: 'status_change' });

      expect(ok).toBe(true);
      expect(after.status).toBe('paused');
      expect(after.pause_reason).toBe('manual pause');
      expect(after.paused_at).toBeTruthy();
      expect(events).toHaveLength(1);
      expect(events[0].old_value).toBe('running');
      expect(events[0].new_value).toBe('paused');
      expect(JSON.parse(events[0].event_data)).toEqual({ reason: 'manual pause' });
    });

    it('pauseTask returns false for unknown task id', () => {
      expect(mod.pauseTask('missing-task', 'x')).toBe(false);
    });

    it('clearPauseState clears pause metadata and returns sqlite run result', () => {
      const task = makeTask({ status: 'running' });
      mod.pauseTask(task.id, 'clear me');

      const result = mod.clearPauseState(task.id);
      const after = taskCore.getTask(task.id);

      expect(result.changes).toBe(1);
      expect(after.pause_reason).toBeNull();
      expect(after.paused_at).toBeNull();
      expect(after.status).toBe('paused');
    });

    it('listPausedTasks returns paused tasks with project filter and limit', () => {
      const alpha1 = makeTask({ status: 'running', project: 'alpha' });
      const alpha2 = makeTask({ status: 'running', project: 'alpha' });
      const beta = makeTask({ status: 'running', project: 'beta' });

      mod.pauseTask(alpha1.id, 'a1');
      mod.pauseTask(alpha2.id, 'a2');
      mod.pauseTask(beta.id, 'b1');

      rawDb().prepare('UPDATE tasks SET paused_at = ? WHERE id = ?').run('2026-01-01 00:00:00', alpha1.id);
      rawDb().prepare('UPDATE tasks SET paused_at = ? WHERE id = ?').run('2026-01-01 00:10:00', alpha2.id);
      rawDb().prepare('UPDATE tasks SET paused_at = ? WHERE id = ?').run('2026-01-01 00:20:00', beta.id);

      const pausedAlpha = mod.listPausedTasks({ project: 'alpha', limit: 1 });
      expect(pausedAlpha).toHaveLength(1);
      expect(pausedAlpha[0].id).toBe(alpha2.id);
      expect(pausedAlpha[0].paused_minutes).toBeGreaterThanOrEqual(0);
    });
  });
});
