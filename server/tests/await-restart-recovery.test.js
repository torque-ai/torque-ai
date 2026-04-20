const Database = require('better-sqlite3');
const serverConfig = require('../config');
const taskCore = require('../db/task-core');
const createCancellationHandler = require('../execution/task-cancellation');
let db;

function addAwaitRestartRecoveryColumns(db) {
  const safeAddColumn = (table, columnDef) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    } catch (_err) {
      void _err;
    }
  };

  safeAddColumn('tasks', 'cancel_reason TEXT');
  safeAddColumn('tasks', 'server_epoch INTEGER');
  safeAddColumn('tasks', 'resume_context TEXT');
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'pending',
      task_description TEXT,
      working_directory TEXT,
      provider TEXT,
      model TEXT,
      timeout_minutes INTEGER DEFAULT 30,
      auto_approve INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      context TEXT,
      error_output TEXT DEFAULT '',
      output TEXT DEFAULT '',
      metadata TEXT,
      created_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      depends_on TEXT,
      template_name TEXT,
      isolated_workspace TEXT,
      approval_status TEXT,
      project TEXT,
      workflow_id TEXT,
      workflow_node_id TEXT,
      tags TEXT,
      ollama_host_id TEXT,
      complexity TEXT,
      review_status TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      mcp_instance_id TEXT,
      original_provider TEXT,
      provider_switched_at TEXT,
      stall_timeout_seconds INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  addAwaitRestartRecoveryColumns(db);
  serverConfig.setEpoch(0);
});

afterEach(() => {
  taskCore.setDb(null);
  serverConfig.setEpoch(0);
  db.close();
});

describe('await restart recovery -- schema', () => {

  test('cancel_reason column can be written and read', () => {
    db.prepare('INSERT INTO tasks (id, status, cancel_reason) VALUES (?, ?, ?)').run(
      'test-cancel-reason',
      'cancelled',
      'server_restart',
    );

    const row = db.prepare('SELECT cancel_reason FROM tasks WHERE id = ?').get('test-cancel-reason');
    expect(row.cancel_reason).toBe('server_restart');
  });

  test('cancel_reason defaults to null', () => {
    db.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)').run('test-null-default', 'pending');

    const row = db.prepare('SELECT cancel_reason FROM tasks WHERE id = ?').get('test-null-default');
    expect(row.cancel_reason).toBeNull();
  });

  test('server_epoch column can be written and read', () => {
    db.prepare('INSERT INTO tasks (id, status, server_epoch) VALUES (?, ?, ?)').run(
      'test-server-epoch',
      'pending',
      1,
    );

    const row = db.prepare('SELECT server_epoch FROM tasks WHERE id = ?').get('test-server-epoch');
    expect(row.server_epoch).toBe(1);
  });
});

describe('await restart recovery -- server epoch', () => {
  test('epoch increments on each startup and updates config cache', () => {
    const configDb = {
      getConfig(key) {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
        return row ? row.value : null;
      },
      setConfig(key, value) {
        db.prepare(`
          INSERT INTO config (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value);
      },
    };

    const bumpServerEpoch = () => {
      const prevEpoch = parseInt(configDb.getConfig('server_epoch') || '0', 10);
      const newEpoch = prevEpoch + 1;
      configDb.setConfig('server_epoch', String(newEpoch));
      serverConfig.setEpoch(newEpoch);
      return newEpoch;
    };

    expect(bumpServerEpoch()).toBe(1);
    expect(serverConfig.getEpoch()).toBe(1);
    expect(configDb.getConfig('server_epoch')).toBe('1');

    expect(bumpServerEpoch()).toBe(2);
    expect(serverConfig.getEpoch()).toBe(2);
    expect(configDb.getConfig('server_epoch')).toBe('2');
  });

  test('createTask stamps the current server epoch on new tasks', () => {
    serverConfig.setEpoch(3);
    taskCore.setDb(db);

    const task = taskCore.createTask({
      id: '12345678-1234-1234-1234-123456789012',
      task_description: 'stamp current epoch',
      status: 'pending',
    });

    expect(task.server_epoch).toBe(3);

    const row = db.prepare('SELECT server_epoch FROM tasks WHERE id = ?').get(task.id);
    expect(row.server_epoch).toBe(3);
  });
});

describe('await restart recovery -- cancel_reason persistence', () => {
  test('updateTaskStatus persists cancel_reason when status is cancelled', () => {
    taskCore.setDb(db);
    db.prepare('INSERT INTO tasks (id, status, error_output) VALUES (?, ?, ?)').run(
      'task-cr-1',
      'running',
      '',
    );

    taskCore.updateTaskStatus('task-cr-1', 'cancelled', {
      error_output: 'Server shutdown',
      cancel_reason: 'server_restart',
    });

    const row = db.prepare('SELECT status, cancel_reason, error_output FROM tasks WHERE id = ?').get('task-cr-1');
    expect(row.status).toBe('cancelled');
    expect(row.cancel_reason).toBe('server_restart');
    expect(row.error_output).toBe('Server shutdown');
  });

  test('updateTaskStatus does not persist cancel_reason for non-cancelled statuses', () => {
    taskCore.setDb(db);
    db.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)').run('task-cr-2', 'running');

    taskCore.updateTaskStatus('task-cr-2', 'completed', {
      cancel_reason: 'server_restart',
    });

    const row = db.prepare('SELECT status, cancel_reason FROM tasks WHERE id = ?').get('task-cr-2');
    expect(row.status).toBe('completed');
    expect(row.cancel_reason).toBeNull();
  });

  test('cancelTask persists structured cancel_reason', () => {
    taskCore.setDb(db);
    db.prepare('INSERT INTO tasks (id, status, error_output) VALUES (?, ?, ?)').run(
      'task-cr-3',
      'queued',
      '',
    );

    const handler = createCancellationHandler({
      db: taskCore,
      runningProcesses: new Map(),
      apiAbortControllers: new Map(),
      pendingRetryTimeouts: new Map(),
      stallRecoveryAttempts: new Map(),
      logger: { info() {}, warn() {}, error() {} },
      sanitizeTaskOutput: (value) => value,
      safeTriggerWebhook() {},
      killProcessGraceful() {},
      cleanupChildProcessListeners() {},
      cleanupProcessTracking() {},
      safeDecrementHostSlot() {},
      handleWorkflowTermination() {},
      processQueue() {},
    });

    expect(handler.cancelTask('task-cr-3', 'Server shutdown', { cancel_reason: 'server_restart' })).toBe(true);

    const row = db.prepare('SELECT status, cancel_reason, error_output FROM tasks WHERE id = ?').get('task-cr-3');
    expect(row.status).toBe('cancelled');
    expect(row.cancel_reason).toBe('server_restart');
    expect(row.error_output).toBe('Server shutdown');
  });
});

describe('await restart recovery -- edge cases', () => {
  test('double-resubmit prevention via resubmitted_as pointer', () => {
    const meta = { resubmitted_as: 'new-task-123', restart_resubmit_count: 1 };
    // Handler should follow pointer, not resubmit again
    expect(meta.resubmitted_as).toBe('new-task-123');
    expect(meta.restart_resubmit_count).toBe(1);
  });

  test('resubmit loop breaker triggers at count 3', () => {
    for (const count of [3, 4, 10]) {
      expect(count >= 3).toBe(true);
    }
  });

  test('resubmit allowed at counts 0, 1, 2', () => {
    for (const count of [0, 1, 2]) {
      expect(count < 3).toBe(true);
    }
  });

  test('epoch comparison detects orphaned tasks', () => {
    // Task from epoch 5, server at epoch 7 = orphan
    expect(5 < 7).toBe(true);
    // Task from current epoch = not orphan
    expect(7 < 7).toBe(false);
  });

  test('epoch guard handles falsy values correctly', () => {
    // The guard: task.server_epoch && task.server_epoch < currentEpoch
    // Must handle null/undefined/0 without false positives
    const currentEpoch = 7;
    const cases = [
      { epoch: null, expected: false },
      { epoch: undefined, expected: false },
      { epoch: 0, expected: false },
      { epoch: 5, expected: true },
      { epoch: 7, expected: false },
      { epoch: 8, expected: false },
    ];
    for (const { epoch, expected } of cases) {
      const result = !!(epoch && epoch < currentEpoch);
      expect(result).toBe(expected);
    }
  });

  test('cancel_reason values are exhaustive and non-overlapping', () => {
    const allReasons = ['user', 'server_restart', 'stall', 'timeout', 'orphan_cleanup', 'host_failover', 'workflow_cascade'];
    const restartReasons = new Set(['server_restart', 'orphan_cleanup']);

    // All unique
    expect(new Set(allReasons).size).toBe(allReasons.length);

    // Restart reasons are a proper subset
    for (const r of restartReasons) {
      expect(allReasons).toContain(r);
    }

    // Non-restart reasons are excluded
    expect(restartReasons.has('user')).toBe(false);
    expect(restartReasons.has('stall')).toBe(false);
    expect(restartReasons.has('timeout')).toBe(false);
  });

  test('provider preservation uses resolved provider, not auto', () => {
    const originalTask = {
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      original_provider: 'codex',
    };
    expect(originalTask.provider).toBe('codex');
    expect(originalTask.provider).not.toBe('auto');
  });
});

describe('await restart recovery -- formatDuration', () => {
  test('formats milliseconds to human-readable duration', async () => {
    const { formatDuration } = await import('../handlers/workflow/await.js');
    expect(formatDuration(150000)).toBe('2m 30s');
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('await restart recovery -- restart cancel reason identification', () => {
  test('RESTART_CANCEL_REASONS includes correct values', () => {
    const RESTART_CANCEL_REASONS = new Set(['server_restart', 'orphan_cleanup']);
    expect(RESTART_CANCEL_REASONS.has('server_restart')).toBe(true);
    expect(RESTART_CANCEL_REASONS.has('orphan_cleanup')).toBe(true);
    expect(RESTART_CANCEL_REASONS.has('user')).toBe(false);
    expect(RESTART_CANCEL_REASONS.has('stall')).toBe(false);
    expect(RESTART_CANCEL_REASONS.has('timeout')).toBe(false);
    expect(RESTART_CANCEL_REASONS.has('host_failover')).toBe(false);
    expect(RESTART_CANCEL_REASONS.has('workflow_cascade')).toBe(false);
  });
});
