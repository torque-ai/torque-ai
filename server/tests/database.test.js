/**
 * Database Module Tests
 *
 * Direct unit tests for database.js exported functions.
 * Uses isolated temp DB via vitest-setup.js pattern.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;
let emitQueueChangedSpy;
let emitShutdownSpy;
let emitTaskUpdatedSpy;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-database-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  return db;
}

function teardownDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

describe('Database Module', () => {
  beforeAll(() => {
    setupDb();
    const eventBus = require('../event-bus');
    emitQueueChangedSpy = vi.spyOn(eventBus, 'emitQueueChanged');
    emitShutdownSpy = vi.spyOn(eventBus, 'emitShutdown');
    emitTaskUpdatedSpy = vi.spyOn(eventBus, 'emitTaskUpdated');
  });
  afterAll(() => {
    emitQueueChangedSpy.mockRestore();
    emitShutdownSpy.mockRestore();
    emitTaskUpdatedSpy.mockRestore();
    teardownDb();
  });

  // ── Config CRUD ──────────────────────────────────────────
  describe('Config CRUD', () => {
    it('setConfig + getConfig round-trips a string value', () => {
      db.setConfig('test_key_1', 'hello');
      expect(db.getConfig('test_key_1')).toBe('hello');
    });

    it('getConfig returns null for missing key', () => {
      expect(db.getConfig('nonexistent_key_xyz')).toBeNull();
    });

    it('setConfig overwrites existing value', () => {
      db.setConfig('overwrite_key', 'first');
      db.setConfig('overwrite_key', 'second');
      expect(db.getConfig('overwrite_key')).toBe('second');
    });

    it('setConfig stores JSON values as strings', () => {
      const obj = { nested: true, count: 42 };
      db.setConfig('json_key', JSON.stringify(obj));
      const retrieved = JSON.parse(db.getConfig('json_key'));
      expect(retrieved).toEqual(obj);
    });

    it('setConfig stores numeric values as strings', () => {
      db.setConfig('num_key', 123);
      expect(db.getConfig('num_key')).toBe('123');
    });

    it('getAllConfig returns an object with all config entries', () => {
      db.setConfig('all_cfg_test', 'yes');
      const all = db.getAllConfig();
      expect(typeof all).toBe('object');
      expect(all.all_cfg_test).toBe('yes');
    });
  });

  // ── Task CRUD ────────────────────────────────────────────
  describe('Task CRUD', () => {
    let taskId;

    it('createTask returns task with correct fields', () => {
      taskId = uuidv4();
      db.createTask({
        id: taskId,
        task_description: 'Test task for DB unit test',
        working_directory: testDir,
        status: 'queued',
        priority: 5,
        timeout_minutes: 30,
        provider: 'codex',
      });
      const task = db.getTask(taskId);
      expect(task).not.toBeNull();
      expect(task.id).toBe(taskId);
      expect(task.task_description).toBe('Test task for DB unit test');
      expect(task.status).toBe('queued');
      expect(task.priority).toBe(5);
    });

    it('emits queue-changed when createTask creates a queued task', () => {
      const emitSpy = vi.spyOn(process, 'emit');
      try {
        const queuedId = uuidv4();
        db.createTask({
          id: queuedId,
          task_description: 'Queued task emission test',
          working_directory: testDir,
          status: 'queued',
          priority: 4,
          timeout_minutes: 10,
          provider: 'codex',
        });
        expect(emitQueueChangedSpy).toHaveBeenCalled();
      } finally {
        emitSpy.mockRestore();
      }
    });

    it('emits queue-changed when createTask creates a pending task', () => {
      const emitSpy = vi.spyOn(process, 'emit');
      try {
        const pendingId = uuidv4();
        db.createTask({
          id: pendingId,
          task_description: 'Pending task emission test',
          working_directory: testDir,
          status: 'pending',
          priority: 2,
          timeout_minutes: 10,
          provider: 'codex',
        });
        expect(emitQueueChangedSpy).toHaveBeenCalled();
      } finally {
        emitSpy.mockRestore();
      }
    });

    it('emits queue-changed when a task is requeued', () => {
      const emitSpy = vi.spyOn(process, 'emit');
      try {
        const requeueId = uuidv4();
        db.createTask({
          id: requeueId,
          task_description: 'Requeue task emission test',
          working_directory: testDir,
          status: 'running',
          priority: 1,
          timeout_minutes: 10,
          provider: 'codex',
        });
        emitSpy.mockClear();

                db.updateTaskStatus(requeueId, 'queued');
                expect(emitQueueChangedSpy).toHaveBeenCalled();
      } finally {
        emitSpy.mockRestore();
      }
    });

    it('getTask returns null for nonexistent ID', () => {
      expect(db.getTask('nonexistent-id-00000')).toBeNull();
    });

    it('getTask returns null for null/undefined', () => {
      expect(db.getTask(null)).toBeNull();
      expect(db.getTask(undefined)).toBeNull();
    });

    it('updateTaskStatus changes status correctly', () => {
      const id = uuidv4();
      db.createTask({ id, task_description: 'Status test', status: 'queued', working_directory: testDir });
      db.updateTaskStatus(id, 'running');
      const task = db.getTask(id);
      expect(task.status).toBe('running');
      expect(task.started_at).not.toBeNull();
    });

    it('updateTaskStatus to completed sets completed_at', () => {
      const id = uuidv4();
      db.createTask({ id, task_description: 'Complete test', status: 'queued', working_directory: testDir });
      db.updateTaskStatus(id, 'running');
      db.updateTaskStatus(id, 'completed', { exit_code: 0, output: 'done' });
      const task = db.getTask(id);
      expect(task.status).toBe('completed');
      expect(task.completed_at).not.toBeNull();
    });

    it('updateTaskStatus running -> failed sets completed_at', () => {
      const id = uuidv4();
      db.createTask({ id, task_description: 'Failed test', status: 'queued', working_directory: testDir });
      db.updateTaskStatus(id, 'running');
      db.updateTaskStatus(id, 'failed', { exit_code: 1, output: 'error' });
      const task = db.getTask(id);
      expect(task.status).toBe('failed');
      expect(task.completed_at).not.toBeNull();
    });

    it('updateTaskStatus running -> cancelled sets completed_at', () => {
      const id = uuidv4();
      db.createTask({ id, task_description: 'Cancelled running test', status: 'queued', working_directory: testDir });
      db.updateTaskStatus(id, 'running');
      db.updateTaskStatus(id, 'cancelled', { output: 'canceled while running' });
      const task = db.getTask(id);
      expect(task.status).toBe('cancelled');
      expect(task.completed_at).not.toBeNull();
    });

    it('updateTaskStatus pending -> cancelled does not set completed_at', () => {
      const id = uuidv4();
      db.createTask({ id, task_description: 'Cancelled pending test', status: 'pending', working_directory: testDir });
      db.updateTaskStatus(id, 'cancelled', { output: 'canceled while pending' });
      const task = db.getTask(id);
      expect(task.status).toBe('cancelled');
      expect(task.completed_at).toBeNull();
    });

    it('updateTaskStatus blocked -> cancelled does not set completed_at', () => {
      const id = uuidv4();
      db.createTask({ id, task_description: 'Cancelled blocked test', status: 'blocked', working_directory: testDir });
      db.updateTaskStatus(id, 'cancelled', { output: 'canceled while blocked' });
      const task = db.getTask(id);
      expect(task.status).toBe('cancelled');
      expect(task.completed_at).toBeNull();
    });

    it('createTask throws on empty ID', () => {
      expect(() => db.createTask({ id: '', task_description: 'No ID', status: 'queued', working_directory: testDir }))
        .toThrow();
    });

    it('createTask throws on missing ID', () => {
      expect(() => db.createTask({ task_description: 'No ID field', status: 'queued', working_directory: testDir }))
        .toThrow();
    });
  });

  // ── Task Queries ─────────────────────────────────────────
  describe('Task Queries', () => {
    beforeAll(() => {
      // Seed several tasks for query tests
      for (let i = 0; i < 5; i++) {
        db.createTask({
          id: uuidv4(),
          task_description: `Query test task ${i}`,
          status: i < 3 ? 'queued' : 'completed',
          working_directory: testDir,
          project: 'query-test-project',
          priority: i,
        });
      }
    });

    it('listTasks returns an array', () => {
      const tasks = db.listTasks({ limit: 100 });
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
    });

    it('listTasks filters by status', () => {
      const queued = db.listTasks({ status: 'queued', limit: 100 });
      expect(queued.every(t => t.status === 'queued')).toBe(true);
    });

    it('listTasks filters by project', () => {
      const tasks = db.listTasks({ project: 'query-test-project', limit: 100 });
      expect(tasks.length).toBeGreaterThanOrEqual(5);
      expect(tasks.every(t => t.project === 'query-test-project')).toBe(true);
    });

    it('listTasks respects limit', () => {
      const tasks = db.listTasks({ limit: 2 });
      expect(tasks.length).toBeLessThanOrEqual(2);
    });

    it('countTasks returns a number', () => {
      const result = db.countTasks({});
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('countTasks filters by status', () => {
      const all = db.countTasks({});
      const queued = db.countTasks({ status: 'queued' });
      expect(queued).toBeLessThanOrEqual(all);
      expect(queued).toBeGreaterThan(0);
    });
  });

  // ── File Tracking ────────────────────────────────────────
  describe('File Tracking', () => {
    let trackTaskId;

    beforeAll(() => {
      trackTaskId = uuidv4();
      db.createTask({
        id: trackTaskId,
        task_description: 'File tracking test',
        status: 'running',
        working_directory: testDir,
      });
    });

    it('recordFileChange stores and getTaskFileChanges retrieves', () => {
      db.recordFileChange(trackTaskId, 'src/foo.ts', 'modified', {});
      db.recordFileChange(trackTaskId, 'src/bar.ts', 'created', {});
      const changes = db.getTaskFileChanges(trackTaskId);
      expect(Array.isArray(changes)).toBe(true);
      expect(changes.length).toBeGreaterThanOrEqual(2);
    });

    it('getTaskFileChanges returns empty array for task with no changes', () => {
      const noChangesId = uuidv4();
      db.createTask({ id: noChangesId, task_description: 'No changes', status: 'queued', working_directory: testDir });
      const changes = db.getTaskFileChanges(noChangesId);
      expect(changes).toEqual([]);
    });
  });

  // ── Code Analysis Functions ──────────────────────────────
  describe('analyzeCodeComplexity', () => {
    let analysisTaskId;

    beforeAll(() => {
      analysisTaskId = uuidv4();
      db.createTask({
        id: analysisTaskId,
        task_description: 'Analysis test',
        status: 'completed',
        working_directory: testDir,
      });
    });

    it('returns complexity metrics for JS content', () => {
      const code = `
function fibonacci(n) {
  if (n <= 1) return n;
  for (let i = 2; i <= n; i++) {
    const temp = a + b;
    a = b;
    b = temp;
  }
  return b;
}`;
      const result = db.analyzeCodeComplexity(analysisTaskId, 'fib.js', code);
      expect(result.cyclomatic_complexity).toBeGreaterThan(1);
      expect(result.lines_of_code).toBeGreaterThan(0);
      expect(result.function_count).toBeGreaterThanOrEqual(1);
      expect(result.max_nesting_depth).toBeGreaterThan(0);
      expect(typeof result.maintainability_index).toBe('number');
    });

    it('returns base complexity for empty content', () => {
      const result = db.analyzeCodeComplexity(analysisTaskId, 'empty.js', '');
      expect(result.cyclomatic_complexity).toBe(1); // base complexity
      expect(result.lines_of_code).toBe(0);
    });
  });

  describe('checkDocCoverage', () => {
    let docTaskId;

    beforeAll(() => {
      docTaskId = uuidv4();
      db.createTask({ id: docTaskId, task_description: 'Doc test', status: 'completed', working_directory: testDir });
    });

    it('detects missing JSDoc on exports', () => {
      const code = `
export function undocumented() {
  return 42;
}

/** Documented function */
export function documented() {
  return 1;
}`;
      const result = db.checkDocCoverage(docTaskId, 'test.ts', code);
      expect(result.total_public_items).toBe(2);
      expect(result.documented_items).toBe(1);
      expect(result.coverage_percent).toBe(50);
      expect(result.missing_docs).toContain('undocumented');
    });

    it('returns 100% for file with no exports', () => {
      const code = `const x = 1;\nconst y = 2;`;
      const result = db.checkDocCoverage(docTaskId, 'internal.ts', code);
      expect(result.coverage_percent).toBe(100);
    });
  });

  describe('checkAccessibility', () => {
    let a11yTaskId;

    beforeAll(() => {
      a11yTaskId = uuidv4();
      db.createTask({ id: a11yTaskId, task_description: 'A11y test', status: 'completed', working_directory: testDir });
    });

    it('detects missing alt attrs in HTML', () => {
      const html = `<div><img src="photo.jpg"><img src="icon.png" alt="icon"></div>`;
      const result = db.checkAccessibility(a11yTaskId, 'page.html', html);
      expect(result.violations_count).toBeGreaterThanOrEqual(1);
      const altViolation = result.violations.find(v => v.rule === 'img-alt');
      expect(altViolation).toEqual(expect.objectContaining({
        rule: 'img-alt',
        message: expect.any(String),
        wcag: expect.any(String),
        line: expect.any(Number),
      }));
    });

    it('returns zero violations for accessible HTML', () => {
      const html = `<div><img src="photo.jpg" alt="A photo"></div>`;
      const result = db.checkAccessibility(a11yTaskId, 'good.html', html);
      const imgViolations = result.violations.filter(v => v.rule === 'img-alt');
      expect(imgViolations.length).toBe(0);
    });
  });

  describe('checkI18n', () => {
    let i18nTaskId;

    beforeAll(() => {
      i18nTaskId = uuidv4();
      db.createTask({ id: i18nTaskId, task_description: 'I18n test', status: 'completed', working_directory: testDir });
    });

    it('detects hardcoded user-facing strings', () => {
      const code = `const msg = "Please enter your email address to continue";`;
      const result = db.checkI18n(i18nTaskId, 'form.tsx', code);
      expect(result.hardcoded_strings_count).toBeGreaterThanOrEqual(1);
    });

    it('returns zero for non-source files', () => {
      const result = db.checkI18n(i18nTaskId, 'data.json', '{"key": "value"}');
      expect(result.hardcoded_strings_count).toBe(0);
    });
  });

  describe('detectDeadCode', () => {
    let deadTaskId;

    beforeAll(() => {
      deadTaskId = uuidv4();
      db.createTask({ id: deadTaskId, task_description: 'Dead code test', status: 'completed', working_directory: testDir });
    });

    it('finds unused functions', () => {
      const code = `
function usedFunction() { return 1; }
function unusedHelper() { return 2; }
const result = usedFunction();
console.log(result);`;
      const result = db.detectDeadCode(deadTaskId, 'test.js', code);
      const unused = result.find(d => d.identifier === 'unusedHelper');
      expect(unused).toEqual(expect.objectContaining({
        type: 'unused_function',
        identifier: 'unusedHelper',
        line: expect.any(Number),
        confidence: expect.any(Number),
      }));
      expect(unused.type).toBe('unused_function');
    });

    it('returns empty array for all-used code', () => {
      const code = `
function a() { return b(); }
function b() { return a(); }`;
      const result = db.detectDeadCode(deadTaskId, 'mutual.js', code);
      const funcs = result.filter(d => d.type === 'unused_function');
      expect(funcs.length).toBe(0);
    });
  });

  describe('estimateResourceUsage', () => {
    let resTaskId;

    beforeAll(() => {
      resTaskId = uuidv4();
      db.createTask({ id: resTaskId, task_description: 'Resource test', status: 'completed', working_directory: testDir });
    });

    it('detects infinite loop risk', () => {
      const code = `while (true) { process(); }`;
      const result = db.estimateResourceUsage(resTaskId, 'loop.js', code);
      expect(result.risk_factors).toContain('potential_infinite_loop');
      expect(result.cpu_risk_score).toBeGreaterThan(0);
    });

    it('detects blocking IO', () => {
      const code = `const data = fs.readFileSync('file.txt', 'utf8');`;
      const result = db.estimateResourceUsage(resTaskId, 'sync.js', code);
      expect(result.risk_factors).toContain('blocking_io');
    });

    it('returns base memory for safe code', () => {
      const code = `const x = 1 + 2;`;
      const result = db.estimateResourceUsage(resTaskId, 'safe.js', code);
      expect(result.risk_factors.length).toBe(0);
      expect(result.estimated_memory_mb).toBe(50); // base only
    });
  });

  describe('verifyTypeReferences', () => {
    let typeTaskId;
    let workDir;

    beforeAll(() => {
      typeTaskId = uuidv4();
      db.createTask({ id: typeTaskId, task_description: 'Type ref test', status: 'completed', working_directory: testDir });
      // Create a temp working directory with a type file
      workDir = path.join(testDir, 'type-project');
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(workDir, 'types.ts'), `export interface ILogger { log(msg: string): void; }`);
    });

    it('finds type references in TypeScript', () => {
      const code = `class MyService implements ICustomType { }`;
      const result = db.verifyTypeReferences(typeTaskId, 'service.ts', code, workDir);
      expect(result).toEqual(expect.objectContaining({
        status: 'types_missing',
        types_checked: expect.any(Number),
        missing_types: expect.any(Number),
        results: expect.any(Array),
      }));
      expect(result.types_checked).toBeGreaterThan(0);
      expect(result.missing_types).toBeGreaterThan(0);
      expect(result.status).toBe('types_missing');
    });

    it('returns verified for content with no type refs', () => {
      const code = `const x = 1;`;
      const result = db.verifyTypeReferences(typeTaskId, 'simple.ts', code, workDir);
      expect(result).toEqual(expect.objectContaining({
        status: 'verified',
        types_checked: expect.any(Number),
        missing_types: 0,
        results: expect.any(Array),
      }));
      expect(result.types_checked).toBe(0);
      expect(result.status).toBe('verified');
    });
  });

  // ── Edge Cases ───────────────────────────────────────────
  describe('Edge Cases', () => {
    it('resolveTaskId returns null for nonexistent partial ID', () => {
      const result = db.resolveTaskId('zzz_nonexistent');
      expect(result).toBeNull();
    });

    it('deleteTask removes completed task from DB', () => {
      const id = uuidv4();
      db.createTask({ id, task_description: 'To be deleted', status: 'queued', working_directory: testDir });
      db.updateTaskStatus(id, 'cancelled');
      expect(db.getTask(id)).not.toBeNull();
      db.deleteTask(id);
      expect(db.getTask(id)).toBeFalsy();
    });

    it('safeJsonParse handles malformed JSON', () => {
      const result = db.safeJsonParse('not valid json', 'fallback');
      expect(result).toBe('fallback');
    });

    it('safeJsonParse parses valid JSON', () => {
      const result = db.safeJsonParse('{"a":1}', null);
      expect(result).toEqual({ a: 1 });
    });

    it('escapeLikePattern escapes special characters', () => {
      const result = db.escapeLikePattern('100% match_test');
      expect(result).toContain('\\%');
      expect(result).toContain('\\_');
    });

    it('getRunningCount returns a number', () => {
      const count = db.getRunningCount();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
