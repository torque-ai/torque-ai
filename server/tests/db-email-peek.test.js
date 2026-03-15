'use strict';

const { installMock } = require('./cjs-mock');

const FROZEN_NOW = new Date('2026-03-11T12:34:56.789Z');
const EMAIL_PEEK_MODULE_PATH = require.resolve('../db/email-peek');
const LOGGER_MODULE_PATH = require.resolve('../logger');
const originalLoggerCache = require.cache[LOGGER_MODULE_PATH];

const mockLoggerInstance = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const mockLogger = {
  child: vi.fn(() => mockLoggerInstance),
};

installMock('../logger', mockLogger);
delete require.cache[EMAIL_PEEK_MODULE_PATH];

const emailPeek = require('../db/email-peek');

const FAILOVER_INSERT_SQL = normalizeSql(`
  INSERT INTO failover_events (task_id, from_provider, to_provider, from_model, to_model, from_host, to_host, reason, failover_type, attempt_num, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function createMockDb() {
  const state = {
    failoverEvents: [],
    emailNotifications: new Map(),
    peekHosts: new Map(),
    prepareCalls: [],
    prepareErrors: new Map(),
    runErrors: new Map(),
  };

  function maybeThrow(errorMap, sql) {
    const error = errorMap.get(sql);
    if (error) {
      throw error;
    }
  }

  function runSql(sql, args) {
    maybeThrow(state.runErrors, sql);

    if (sql.startsWith('INSERT INTO failover_events')) {
      const row = {
        task_id: args[0],
        from_provider: args[1],
        to_provider: args[2],
        from_model: args[3],
        to_model: args[4],
        from_host: args[5],
        to_host: args[6],
        reason: args[7],
        failover_type: args[8],
        attempt_num: args[9],
        created_at: args[10],
      };
      state.failoverEvents.push(row);
      return { changes: 1 };
    }

    if (sql.startsWith('INSERT INTO email_notifications')) {
      const row = {
        id: args[0],
        task_id: args[1],
        recipient: args[2],
        subject: args[3],
        status: args[4],
        error: args[5],
        sent_at: args[6],
      };
      state.emailNotifications.set(row.id, row);
      return { changes: 1 };
    }

    if (sql === 'UPDATE email_notifications SET status = ?, error = ? WHERE id = ?') {
      const [status, error, id] = args;
      const row = state.emailNotifications.get(id);
      if (!row) {
        return { changes: 0 };
      }
      row.status = status;
      row.error = error;
      return { changes: 1 };
    }

    if (sql === 'UPDATE peek_hosts SET is_default = 0') {
      for (const host of state.peekHosts.values()) {
        host.is_default = 0;
      }
      return { changes: state.peekHosts.size };
    }

    if (sql.startsWith('INSERT OR REPLACE INTO peek_hosts')) {
      const row = {
        name: args[0],
        url: args[1],
        ssh: args[2],
        is_default: args[3],
        platform: args[4],
      };
      state.peekHosts.set(row.name, row);
      return { changes: 1 };
    }

    if (sql === 'DELETE FROM peek_hosts WHERE name = ?') {
      return { changes: state.peekHosts.delete(args[0]) ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE peek_hosts SET ') && sql.endsWith(' WHERE name = ?')) {
      const name = args[args.length - 1];
      const row = state.peekHosts.get(name);
      if (!row) {
        return { changes: 0 };
      }

      const setClause = sql.slice('UPDATE peek_hosts SET '.length, -' WHERE name = ?'.length);
      const fields = setClause.split(', ').map((part) => part.slice(0, -' = ?'.length));
      for (let index = 0; index < fields.length; index += 1) {
        row[fields[index]] = args[index];
      }
      return { changes: 1 };
    }

    throw new Error(`Unhandled run SQL: ${sql}`);
  }

  function getSql(sql, args) {
    if (sql === 'SELECT * FROM email_notifications WHERE id = ?') {
      return clone(state.emailNotifications.get(args[0])) || undefined;
    }

    if (sql === 'SELECT * FROM peek_hosts WHERE is_default = 1') {
      const row = Array.from(state.peekHosts.values()).find((host) => host.is_default === 1);
      return clone(row) || undefined;
    }

    if (sql === 'SELECT * FROM peek_hosts WHERE name = ?') {
      return clone(state.peekHosts.get(args[0])) || undefined;
    }

    throw new Error(`Unhandled get SQL: ${sql}`);
  }

  function allSql(sql, args) {
    if (sql === 'SELECT * FROM failover_events WHERE task_id = ? ORDER BY created_at ASC') {
      return state.failoverEvents
        .filter((row) => row.task_id === args[0])
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map(clone);
    }

    if (sql.startsWith('SELECT * FROM email_notifications')) {
      let cursor = 0;
      let status;
      let taskId;

      if (sql.includes('status = ?')) {
        status = args[cursor];
        cursor += 1;
      }

      if (sql.includes('task_id = ?')) {
        taskId = args[cursor];
        cursor += 1;
      }

      const limit = args[cursor];
      cursor += 1;
      const offset = sql.includes(' OFFSET ?') ? args[cursor] : 0;

      return Array.from(state.emailNotifications.values())
        .filter((row) => !status || row.status === status)
        .filter((row) => !taskId || row.task_id === taskId)
        .sort((left, right) => right.sent_at.localeCompare(left.sent_at))
        .slice(offset, offset + limit)
        .map(clone);
    }

    if (sql === 'SELECT * FROM peek_hosts ORDER BY is_default DESC, name ASC') {
      return Array.from(state.peekHosts.values())
        .sort((left, right) => {
          if (right.is_default !== left.is_default) {
            return right.is_default - left.is_default;
          }
          return left.name.localeCompare(right.name);
        })
        .map(clone);
    }

    throw new Error(`Unhandled all SQL: ${sql}`);
  }

  const db = {
    prepare: vi.fn((sql) => {
      const normalized = normalizeSql(sql);
      state.prepareCalls.push(normalized);
      maybeThrow(state.prepareErrors, normalized);

      return {
        run: vi.fn((...args) => runSql(normalized, args)),
        get: vi.fn((...args) => getSql(normalized, args)),
        all: vi.fn((...args) => allSql(normalized, args)),
      };
    }),
  };

  return { db, state };
}

function seedEmail(state, overrides = {}) {
  const row = {
    id: overrides.id || `email-${state.emailNotifications.size + 1}`,
    task_id: Object.prototype.hasOwnProperty.call(overrides, 'task_id') ? overrides.task_id : null,
    recipient: overrides.recipient || 'ops@example.com',
    subject: overrides.subject || 'Notification',
    status: overrides.status || 'pending',
    error: Object.prototype.hasOwnProperty.call(overrides, 'error') ? overrides.error : null,
    sent_at: overrides.sent_at || FROZEN_NOW.toISOString(),
  };
  state.emailNotifications.set(row.id, row);
  return row;
}

function seedPeekHost(state, overrides = {}) {
  const row = {
    name: overrides.name || `peek-${state.peekHosts.size + 1}`,
    url: overrides.url || 'http://peek.local',
    ssh: Object.prototype.hasOwnProperty.call(overrides, 'ssh') ? overrides.ssh : null,
    is_default: Object.prototype.hasOwnProperty.call(overrides, 'is_default') ? overrides.is_default : 0,
    platform: Object.prototype.hasOwnProperty.call(overrides, 'platform') ? overrides.platform : null,
    enabled: Object.prototype.hasOwnProperty.call(overrides, 'enabled') ? overrides.enabled : 1,
  };
  state.peekHosts.set(row.name, row);
  return row;
}

describe('db/email-peek', () => {
  let db;
  let state;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    ({ db, state } = createMockDb());
    emailPeek.setDb(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    delete require.cache[EMAIL_PEEK_MODULE_PATH];
    if (originalLoggerCache) {
      require.cache[LOGGER_MODULE_PATH] = originalLoggerCache;
    } else {
      delete require.cache[LOGGER_MODULE_PATH];
    }
  });

  it('setDb switches the active database handle', () => {
    const first = createMockDb();
    const second = createMockDb();
    seedEmail(first.state, {
      id: 'email-first',
      recipient: 'first@example.com',
      subject: 'First',
    });

    emailPeek.setDb(first.db);
    expect(emailPeek.getEmailNotification('email-first')).toMatchObject({
      recipient: 'first@example.com',
    });

    emailPeek.setDb(second.db);
    expect(emailPeek.getEmailNotification('email-first')).toBeNull();
  });

  it('recordFailoverEvent ignores incomplete events', () => {
    emailPeek.recordFailoverEvent(null);
    emailPeek.recordFailoverEvent({ task_id: 'task-1' });
    emailPeek.recordFailoverEvent({ reason: 'quota' });

    expect(db.prepare).not.toHaveBeenCalled();
    expect(state.failoverEvents).toEqual([]);
  });

  it('recordFailoverEvent stores a normalized event with defaults', () => {
    emailPeek.recordFailoverEvent({
      task_id: 'task-1',
      reason: 'quota exhausted',
      to_provider: 'claude-cli',
    });

    expect(state.failoverEvents).toEqual([
      {
        task_id: 'task-1',
        from_provider: null,
        to_provider: 'claude-cli',
        from_model: null,
        to_model: null,
        from_host: null,
        to_host: null,
        reason: 'quota exhausted',
        failover_type: 'provider',
        attempt_num: 1,
        created_at: FROZEN_NOW.toISOString(),
      },
    ]);
  });

  it('recordFailoverEvent swallows database errors and logs a debug message', () => {
    state.runErrors.set(FAILOVER_INSERT_SQL, new Error('disk full'));

    expect(() => emailPeek.recordFailoverEvent({
      task_id: 'task-1',
      reason: 'quota exhausted',
    })).not.toThrow();

    expect(mockLoggerInstance.debug).toHaveBeenCalledWith('Failed to record failover event: disk full');
    expect(state.failoverEvents).toEqual([]);
  });

  it('getFailoverEvents returns events for a task in ascending timestamp order', () => {
    state.failoverEvents.push(
      { task_id: 'task-1', reason: 'second', created_at: '2026-03-11T12:35:00.000Z' },
      { task_id: 'task-2', reason: 'other', created_at: '2026-03-11T12:34:59.000Z' },
      { task_id: 'task-1', reason: 'first', created_at: '2026-03-11T12:34:58.000Z' },
    );

    expect(emailPeek.getFailoverEvents('task-1')).toEqual([
      { task_id: 'task-1', reason: 'first', created_at: '2026-03-11T12:34:58.000Z' },
      { task_id: 'task-1', reason: 'second', created_at: '2026-03-11T12:35:00.000Z' },
    ]);
  });

  it('recordEmailNotification validates required fields', () => {
    expect(() => emailPeek.recordEmailNotification({})).toThrow('id, recipient, and subject are required');
    expect(() => emailPeek.recordEmailNotification({ id: 'email-1', recipient: 'ops@example.com' })).toThrow('id, recipient, and subject are required');
  });

  it('recordEmailNotification saves defaults and getEmailNotification returns null for blank ids', () => {
    const row = emailPeek.recordEmailNotification({
      id: 'email-1',
      task_id: 'task-1',
      recipient: 'ops@example.com',
      subject: 'Failover started',
    });

    expect(row).toEqual({
      id: 'email-1',
      task_id: 'task-1',
      recipient: 'ops@example.com',
      subject: 'Failover started',
      status: 'pending',
      error: null,
      sent_at: FROZEN_NOW.toISOString(),
    });
    expect(emailPeek.getEmailNotification('email-1')).toEqual(row);
    expect(emailPeek.getEmailNotification('')).toBeNull();
  });

  it('listEmailNotifications filters, sorts, and paginates results', () => {
    seedEmail(state, {
      id: 'email-1',
      task_id: 'task-1',
      status: 'sent',
      sent_at: '2026-03-11T12:40:00.000Z',
      subject: 'Newest',
    });
    seedEmail(state, {
      id: 'email-2',
      task_id: 'task-1',
      status: 'sent',
      sent_at: '2026-03-11T12:39:00.000Z',
      subject: 'Middle',
    });
    seedEmail(state, {
      id: 'email-3',
      task_id: 'task-1',
      status: 'sent',
      sent_at: '2026-03-11T12:38:00.000Z',
      subject: 'Oldest',
    });
    seedEmail(state, {
      id: 'email-4',
      task_id: 'task-2',
      status: 'failed',
      sent_at: '2026-03-11T12:41:00.000Z',
      subject: 'Ignored',
    });

    expect(emailPeek.listEmailNotifications({
      status: 'sent',
      task_id: 'task-1',
      limit: 2,
      offset: 1,
    })).toEqual([
      expect.objectContaining({ id: 'email-2', subject: 'Middle' }),
      expect.objectContaining({ id: 'email-3', subject: 'Oldest' }),
    ]);
  });

  it('listEmailNotifications falls back to the default limit for zero and clamps negatives to one row', () => {
    seedEmail(state, { id: 'email-1', sent_at: '2026-03-11T12:40:00.000Z' });
    seedEmail(state, { id: 'email-2', sent_at: '2026-03-11T12:39:00.000Z' });

    expect(emailPeek.listEmailNotifications({ limit: 0 }).map((row) => row.id)).toEqual(['email-1', 'email-2']);
    expect(emailPeek.listEmailNotifications({ limit: -50 }).map((row) => row.id)).toEqual(['email-1']);
  });

  it('updateEmailNotificationStatus validates inputs and persists status changes', () => {
    seedEmail(state, { id: 'email-1', status: 'pending', error: null });

    expect(() => emailPeek.updateEmailNotificationStatus('', 'sent')).toThrow('id and status are required');
    expect(() => emailPeek.updateEmailNotificationStatus('email-1', '')).toThrow('id and status are required');

    expect(emailPeek.updateEmailNotificationStatus('email-1', 'failed', 'smtp timeout')).toEqual(
      expect.objectContaining({
        id: 'email-1',
        status: 'failed',
        error: 'smtp timeout',
      }),
    );
  });

  it('registerPeekHost updates the default host and list/get helpers reflect the current state', () => {
    emailPeek.registerPeekHost('alpha', 'http://alpha.local', null, true, 'linux');
    emailPeek.registerPeekHost('beta', 'http://beta.local', 'ssh beta', true, 'windows');
    emailPeek.registerPeekHost('gamma', 'http://gamma.local', 'ssh gamma', false, 'darwin');

    expect(emailPeek.getDefaultPeekHost()).toEqual(expect.objectContaining({
      name: 'beta',
      is_default: 1,
    }));
    expect(emailPeek.getPeekHost('alpha')).toEqual(expect.objectContaining({
      name: 'alpha',
      is_default: 0,
      ssh: null,
    }));
    expect(emailPeek.listPeekHosts().map((host) => host.name)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('unregisterPeekHost returns whether the host existed', () => {
    seedPeekHost(state, { name: 'alpha' });

    expect(emailPeek.unregisterPeekHost('alpha')).toBe(true);
    expect(emailPeek.unregisterPeekHost('alpha')).toBe(false);
    expect(emailPeek.getPeekHost('alpha')).toBeNull();
  });

  it('updatePeekHost ignores unsupported fields and updates allowed values only', () => {
    seedPeekHost(state, {
      name: 'alpha',
      url: 'http://old.local',
      ssh: 'ssh old',
      is_default: 0,
      platform: 'linux',
      enabled: 1,
    });

    expect(emailPeek.updatePeekHost('alpha', { unsupported: 'value' })).toBe(false);
    expect(emailPeek.updatePeekHost('alpha', {
      url: 'http://new.local',
      ssh: null,
      enabled: 0,
      ignored: 'value',
    })).toBe(true);
    expect(emailPeek.getPeekHost('alpha')).toEqual(expect.objectContaining({
      name: 'alpha',
      url: 'http://new.local',
      ssh: null,
      enabled: 0,
      platform: 'linux',
    }));
    expect(emailPeek.updatePeekHost('missing', { url: 'http://none.local' })).toBe(false);
  });
});
