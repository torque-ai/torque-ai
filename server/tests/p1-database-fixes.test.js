const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { ErrorCodes } = require('../handlers/error-codes');

const TASK_CHILD_TABLES = [
  'pipeline_steps', 'token_usage', 'retry_history', 'task_file_changes', 'task_file_writes',
  'task_streams', 'task_checkpoints', 'task_event_subscriptions', 'task_events',
  'task_suggestions', 'approval_requests', 'task_comments', 'resource_usage',
  'task_claims', 'work_stealing_log', 'validation_results', 'pending_approvals',
  'failure_matches', 'retry_attempts', 'diff_previews', 'quality_scores', 'task_rollbacks',
  'build_checks', 'cost_tracking', 'task_fingerprints', 'file_backups', 'security_scans',
  'test_coverage', 'style_checks', 'change_impacts', 'timeout_alerts', 'output_violations',
  'expected_output_paths', 'file_location_anomalies', 'duplicate_file_detections',
  'type_verification_results', 'build_error_analysis', 'similar_file_search',
  'task_complexity_scores', 'auto_rollbacks', 'xaml_validation_results',
  'xaml_consistency_results', 'smoke_test_results', 'similar_tasks', 'task_replays'
];

let db;
let rawDb;
let auxDb;
let workingDir;
let originalDataDir;

function setupDb() {
  workingDir = path.join(os.tmpdir(), `torque-p1-db-fixes-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(workingDir, { recursive: true });
  originalDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = workingDir;

  db = require('../database');
  db.init();
  rawDb = db.getDbInstance();

  auxDb = new Database(db.getDbPath());
  resetDbTables();
}

function teardownDb() {
  if (auxDb) {
    try {
      auxDb.close();
    } catch {
      // ignore
    }
    auxDb = null;
  }

  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
    rawDb = null;
  }

  if (workingDir) {
    try {
      fs.rmSync(workingDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (originalDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = originalDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
}

function resetDbTables() {
  for (const table of TASK_CHILD_TABLES) {
    try {
      rawDb.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // ignore unavailable or schema-mismatched tables in older DB states
    }
  }

  try {
    rawDb.prepare('DELETE FROM tasks').run();
  } catch {
    // ignore
  }
}

function createTask(overrides = {}) {
  const taskId = overrides.id || `task-${crypto.randomUUID()}`;
  db.createTask({
    task_description: overrides.task_description || `Task ${taskId}`,
    working_directory: overrides.working_directory || workingDir,
    status: overrides.status || 'queued',
    provider: overrides.provider || 'codex',
    timeout_minutes: overrides.timeout_minutes || 30,
    ...overrides,
    id: taskId,
  });
  return taskId;
}

describe('p1 database fixes', () => {
  beforeAll(() => {
    setupDb();
  });

  afterAll(() => {
    teardownDb();
  });

  beforeEach(() => {
    resetDbTables();
  });

  it('serializes metadata object values and parses them on getTask', () => {
    const taskId = createTask({
      id: 'metadata-fix-task',
      metadata: { mode: 'object', nested: { flag: true } },
    });

    const raw = rawDb.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId);
    // createTask injects requested_provider into metadata
    expect(raw.metadata).toBe(JSON.stringify({ mode: 'object', nested: { flag: true }, requested_provider: 'codex' }));
    expect(raw.metadata).not.toBe('[object Object]');

    const createdTask = db.getTask(taskId);
    expect(createdTask.metadata).toEqual({ mode: 'object', nested: { flag: true }, requested_provider: 'codex' });

    db.updateTaskStatus(taskId, 'running', { metadata: { updated: true, step: 2 } });
    const updatedTask = db.getTask(taskId);
    expect(updatedTask.metadata).toEqual({ updated: true, step: 2 });
  });

  it('throws INVALID_PARAM when resolving ambiguous short ID prefixes', () => {
    createTask({ id: 'ambig-task-aaa', task_description: 'first duplicate prefix' });
    createTask({ id: 'ambig-task-bbb', task_description: 'second duplicate prefix' });

    try {
      db.resolveTaskId('ambig-task');
      throw new Error('Expected ambiguous prefix error');
    } catch (err) {
      expect(err.code).toBe(ErrorCodes.INVALID_PARAM);
      expect(err.message).toBe('Ambiguous task ID prefix "ambig-task" matches 2 tasks');
      expect(err.error_code).toBe(ErrorCodes.INVALID_PARAM);
    }
  });

  it('deletes completed tasks and child rows without disabling FK checks', () => {
    const pragmaCalls = [];
    const originalPragma = rawDb.pragma.bind(rawDb);
    rawDb.pragma = (statement, ...args) => {
      pragmaCalls.push(statement);
      return originalPragma(statement, ...args);
    };

    const first = createTask({ id: 'delete-child-1', status: 'completed' });
    const second = createTask({ id: 'delete-child-2', status: 'completed' });

    rawDb.prepare(
      'INSERT INTO task_file_changes (task_id, file_path, change_type, created_at) VALUES (?, ?, ?, ?)'
    ).run(first, 'src/a.txt', 'added', new Date().toISOString());

    rawDb.prepare(
      'INSERT INTO task_file_changes (task_id, file_path, change_type, created_at) VALUES (?, ?, ?, ?)'
    ).run(second, 'src/b.txt', 'added', new Date().toISOString());

    try {
      const result = db.deleteTasks('completed');
      expect(result).toEqual({ deleted: 2, status: 'completed' });
    } finally {
      rawDb.pragma = originalPragma;
    }

    const remaining = rawDb.prepare(
      'SELECT COUNT(*) AS count FROM task_file_changes WHERE task_id IN (?, ?)'
    ).get(first, second);

    const taskCount = rawDb.prepare('SELECT COUNT(*) AS count FROM tasks WHERE id IN (?, ?)').get(first, second);

    expect(remaining.count).toBe(0);
    expect(taskCount.count).toBe(0);
    expect(pragmaCalls.some((statement) =>
      typeof statement === 'string' && statement.replace(/\s+/g, '').toLowerCase() === 'foreign_keys=off'
    )).toBe(false);
  });

  it('keeps global and provider slot checks atomic by preventing race over-capacity claims', () => {
    const blockerId = createTask({ id: 'claim-blocker', provider: 'ollama', status: 'queued' });
    const targetId = createTask({ id: 'claim-target', provider: 'ollama', status: 'queued' });

    const originalPrepare = rawDb.prepare.bind(rawDb);
    const countSql = 'SELECT COUNT(*) as count FROM tasks WHERE status = ?';
    let sideEffectExecuted = false;

    rawDb.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      if (sql !== countSql) {
        return stmt;
      }
      return new Proxy(stmt, {
        get(target, prop) {
          if (prop === 'get') {
            return (...getArgs) => {
              const value = target.get(...getArgs);
              if (!sideEffectExecuted) {
                sideEffectExecuted = true;
                try {
                  // Simulate an interleaved external claim that arrives between the
                  // global-capacity check and provider-capacity check.
                  auxDb.prepare('UPDATE tasks SET status = ?, started_at = ? WHERE id = ?')
                    .run('running', new Date().toISOString(), blockerId);
                } catch {
                  // ignore busy/lock errors so this test validates final running cap
                }
              }
              return value;
            };
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };

    try {
      const result = db.tryClaimTaskSlot(targetId, 1, null, 'ollama', 1, ['ollama']);
      // The interleaved claim fills the global slot (cap=1), so the atomic
      // check correctly rejects the second claim — no over-capacity.
      expect(result.success).toBe(false);
      expect(sideEffectExecuted).toBe(true);
    } finally {
      rawDb.prepare = originalPrepare;
    }

    // The target was not claimed; blocker may or may not have been promoted
    // to 'running' depending on SQLite lock timing (auxDb write may fail).
    const running = rawDb.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'").get();
    expect(running.count).toBeLessThanOrEqual(1);
  });
});
