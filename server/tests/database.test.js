/**
 * Database Module Tests
 *
 * Direct unit tests for database.js exported functions.
 * Uses isolated temp DB via vitest-setup.js pattern.
 */

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let testDir;
let taskCore;
let configCore;
let fileTracking;
let codeAnalysis;
let eventTracking;
let emitQueueChangedSpy;
let emitShutdownSpy;
let emitTaskUpdatedSpy;

function setupDb() {
  ({ db, testDir } = setupTestDbOnly('database'));
  taskCore = require('../db/task-core');
  configCore = require('../db/config-core');
  fileTracking = require('../db/file-tracking');
  codeAnalysis = require('../db/code-analysis');
  eventTracking = require('../db/event-tracking');
  return db;
}

function teardownDb() {
  teardownTestDb();
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
      configCore.setConfig('test_key_1', 'hello');
      expect(configCore.getConfig('test_key_1')).toBe('hello');
    });

    it('getConfig returns null for missing key', () => {
      expect(configCore.getConfig('nonexistent_key_xyz')).toBeNull();
    });

    it('setConfig overwrites existing value', () => {
      configCore.setConfig('overwrite_key', 'first');
      configCore.setConfig('overwrite_key', 'second');
      expect(configCore.getConfig('overwrite_key')).toBe('second');
    });

    it('setConfig stores JSON values as strings', () => {
      const obj = { nested: true, count: 42 };
      configCore.setConfig('json_key', JSON.stringify(obj));
      const retrieved = JSON.parse(configCore.getConfig('json_key'));
      expect(retrieved).toEqual(obj);
    });

    it('setConfig stores numeric values as strings', () => {
      configCore.setConfig('num_key', 123);
      expect(configCore.getConfig('num_key')).toBe('123');
    });

    it('getAllConfig returns an object with all config entries', () => {
      configCore.setConfig('all_cfg_test', 'yes');
      const all = configCore.getAllConfig();
      expect(typeof all).toBe('object');
      expect(all.all_cfg_test).toBe('yes');
    });
  });

  // ── Task CRUD ────────────────────────────────────────────
  describe('Task CRUD', () => {
    let taskId;

    it('createTask returns task with correct fields', () => {
      taskId = uuidv4();
      taskCore.createTask({
        id: taskId,
        task_description: 'Test task for DB unit test',
        working_directory: testDir,
        status: 'queued',
        priority: 5,
        timeout_minutes: 30,
        provider: 'codex',
      });
      const task = taskCore.getTask(taskId);
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
        taskCore.createTask({
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
        taskCore.createTask({
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
        taskCore.createTask({
          id: requeueId,
          task_description: 'Requeue task emission test',
          working_directory: testDir,
          status: 'running',
          priority: 1,
          timeout_minutes: 10,
          provider: 'codex',
        });
        emitSpy.mockClear();

                taskCore.updateTaskStatus(requeueId, 'queued');
                expect(emitQueueChangedSpy).toHaveBeenCalled();
      } finally {
        emitSpy.mockRestore();
      }
    });

    it('getTask returns null for nonexistent ID', () => {
      expect(taskCore.getTask('nonexistent-id-00000')).toBeNull();
    });

    it('getTask returns null for null/undefined', () => {
      expect(taskCore.getTask(null)).toBeNull();
      expect(taskCore.getTask(undefined)).toBeNull();
    });

    it('updateTaskStatus changes status correctly', () => {
      const id = uuidv4();
      taskCore.createTask({ id, task_description: 'Status test', status: 'queued', working_directory: testDir });
      taskCore.updateTaskStatus(id, 'running');
      const task = taskCore.getTask(id);
      expect(task.status).toBe('running');
      expect(task.started_at).not.toBeNull();
    });

    it('updateTaskStatus to completed sets completed_at', () => {
      const id = uuidv4();
      taskCore.createTask({ id, task_description: 'Complete test', status: 'queued', working_directory: testDir });
      taskCore.updateTaskStatus(id, 'running');
      taskCore.updateTaskStatus(id, 'completed', { exit_code: 0, output: 'done' });
      const task = taskCore.getTask(id);
      expect(task.status).toBe('completed');
      expect(task.completed_at).not.toBeNull();
    });

    it('updateTaskStatus running -> failed sets completed_at', () => {
      const id = uuidv4();
      taskCore.createTask({ id, task_description: 'Failed test', status: 'queued', working_directory: testDir });
      taskCore.updateTaskStatus(id, 'running');
      taskCore.updateTaskStatus(id, 'failed', { exit_code: 1, output: 'error' });
      const task = taskCore.getTask(id);
      expect(task.status).toBe('failed');
      expect(task.completed_at).not.toBeNull();
    });

    it('createTask persists resume_context JSON', () => {
      const id = uuidv4();
      const resumeContext = { goal: 'retry safely', filesModified: ['server/foo.js'] };

      taskCore.createTask({
        id,
        task_description: 'Resume context create test',
        status: 'queued',
        working_directory: testDir,
        resume_context: resumeContext,
      });

      const task = taskCore.getTask(id);
      expect(JSON.parse(task.resume_context)).toEqual(resumeContext);
    });

    it('updateTaskStatus persists resume_context JSON on failed tasks', () => {
      const id = uuidv4();
      const resumeContext = { goal: 'fix failure', errorDetails: 'boom' };

      taskCore.createTask({ id, task_description: 'Resume context failed test', status: 'queued', working_directory: testDir });
      taskCore.updateTaskStatus(id, 'running');
      taskCore.updateTaskStatus(id, 'failed', {
        exit_code: 1,
        output: 'error',
        resume_context: resumeContext,
      });

      const task = taskCore.getTask(id);
      expect(task.status).toBe('failed');
      expect(JSON.parse(task.resume_context)).toEqual(resumeContext);
    });

    it('updateTaskStatus running -> cancelled sets completed_at', () => {
      const id = uuidv4();
      taskCore.createTask({ id, task_description: 'Cancelled running test', status: 'queued', working_directory: testDir });
      taskCore.updateTaskStatus(id, 'running');
      taskCore.updateTaskStatus(id, 'cancelled', { output: 'canceled while running' });
      const task = taskCore.getTask(id);
      expect(task.status).toBe('cancelled');
      expect(task.completed_at).not.toBeNull();
    });

    it('updateTaskStatus pending -> cancelled does not set completed_at', () => {
      const id = uuidv4();
      taskCore.createTask({ id, task_description: 'Cancelled pending test', status: 'pending', working_directory: testDir });
      taskCore.updateTaskStatus(id, 'cancelled', { output: 'canceled while pending' });
      const task = taskCore.getTask(id);
      expect(task.status).toBe('cancelled');
      expect(task.completed_at).toBeNull();
    });

    it('updateTaskStatus blocked -> cancelled does not set completed_at', () => {
      const id = uuidv4();
      taskCore.createTask({ id, task_description: 'Cancelled blocked test', status: 'blocked', working_directory: testDir });
      taskCore.updateTaskStatus(id, 'cancelled', { output: 'canceled while blocked' });
      const task = taskCore.getTask(id);
      expect(task.status).toBe('cancelled');
      expect(task.completed_at).toBeNull();
    });

    it('createTask throws on empty ID', () => {
      expect(() => taskCore.createTask({ id: '', task_description: 'No ID', status: 'queued', working_directory: testDir }))
        .toThrow();
    });

    it('createTask throws on missing ID', () => {
      expect(() => taskCore.createTask({ task_description: 'No ID field', status: 'queued', working_directory: testDir }))
        .toThrow();
    });
  });

  describe('Queue TTL helpers', () => {
    it('excludes workflow-owned pending and queued tasks from queue TTL expiry', () => {
      const staleQueuedId = uuidv4();
      const staleWorkflowQueuedId = uuidv4();
      const staleWorkflowPendingId = uuidv4();
      const cutoff = '2026-04-09T16:00:00.000Z';
      const staleCreatedAt = '2026-04-09T15:00:00.000Z';

      taskCore.createTask({
        id: staleQueuedId,
        task_description: 'standalone queued task',
        working_directory: testDir,
        status: 'queued',
        provider: 'codex',
      });
      taskCore.createTask({
        id: staleWorkflowQueuedId,
        task_description: 'workflow queued task',
        working_directory: testDir,
        status: 'queued',
        provider: 'ollama',
        workflow_id: 'wf-1',
        workflow_node_id: 'queued-node',
      });
      taskCore.createTask({
        id: staleWorkflowPendingId,
        task_description: 'workflow pending task',
        working_directory: testDir,
        status: 'pending',
        provider: 'ollama',
        workflow_id: 'wf-1',
        workflow_node_id: 'pending-node',
      });

      db.getDbInstance().prepare(`
        UPDATE tasks
        SET created_at = ?
        WHERE id IN (?, ?, ?)
      `).run(staleCreatedAt, staleQueuedId, staleWorkflowQueuedId, staleWorkflowPendingId);

      const expired = taskCore.getExpiredQueuedTasks(cutoff);

      expect(expired).toEqual([{ id: staleQueuedId }]);
    });
  });

  // ── Task Queries ─────────────────────────────────────────
  describe('Task Queries', () => {
    beforeAll(() => {
      // Seed several tasks for query tests
      for (let i = 0; i < 5; i++) {
        taskCore.createTask({
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
      const tasks = taskCore.listTasks({ limit: 100 });
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
    });

    it('listTasks filters by status', () => {
      const queued = taskCore.listTasks({ status: 'queued', limit: 100 });
      expect(queued.every(t => t.status === 'queued')).toBe(true);
    });

    it('listTasks filters by project', () => {
      const tasks = taskCore.listTasks({ project: 'query-test-project', limit: 100 });
      expect(tasks.length).toBeGreaterThanOrEqual(5);
      expect(tasks.every(t => t.project === 'query-test-project')).toBe(true);
    });

    it('listTasks respects limit', () => {
      const tasks = taskCore.listTasks({ limit: 2 });
      expect(tasks.length).toBeLessThanOrEqual(2);
    });

    it('listTasks with columns projection returns only requested fields plus id', () => {
      const tasks = taskCore.listTasks({
        project: 'query-test-project',
        limit: 5,
        columns: ['status', 'priority', 'task_description'],
      });
      expect(tasks.length).toBeGreaterThan(0);
      for (const task of tasks) {
        // id is auto-included
        expect(task).toHaveProperty('id');
        expect(task).toHaveProperty('status');
        expect(task).toHaveProperty('priority');
        expect(task).toHaveProperty('task_description');
        // Heavy columns not requested -> not present
        expect(task).not.toHaveProperty('output');
        expect(task).not.toHaveProperty('error_output');
        expect(task).not.toHaveProperty('context');
      }
    });

    it('listTasks drops unknown columns and falls back to SELECT * when all invalid', () => {
      const tasks = taskCore.listTasks({
        project: 'query-test-project',
        limit: 3,
        columns: ['nonexistent_column', "' OR 1=1 --"],
      });
      // All columns were invalid so projection was skipped — full rows returned
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0]).toHaveProperty('created_at');
      expect(tasks[0]).toHaveProperty('task_description');
    });

    it('listTasks without columns still parses JSON fields', () => {
      const tasks = taskCore.listTasks({ project: 'query-test-project', limit: 1 });
      expect(tasks.length).toBe(1);
      // tags is stored as TEXT/JSON, should be parsed into an array
      expect(Array.isArray(tasks[0].tags)).toBe(true);
      // auto_approve is stored as INTEGER, should be coerced to boolean
      expect(typeof tasks[0].auto_approve).toBe('boolean');
    });

    it('countTasks returns a number', () => {
      const result = taskCore.countTasks({});
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('countTasks filters by status', () => {
      const all = taskCore.countTasks({});
      const queued = taskCore.countTasks({ status: 'queued' });
      expect(queued).toBeLessThanOrEqual(all);
      expect(queued).toBeGreaterThan(0);
    });
  });

  // ── File Tracking ────────────────────────────────────────
  describe('File Tracking', () => {
    let trackTaskId;

    beforeAll(() => {
      trackTaskId = uuidv4();
      taskCore.createTask({
        id: trackTaskId,
        task_description: 'File tracking test',
        status: 'running',
        working_directory: testDir,
      });
    });

    it('recordFileChange stores and getTaskFileChanges retrieves', () => {
      fileTracking.recordFileChange(trackTaskId, 'src/foo.ts', 'modified', {});
      fileTracking.recordFileChange(trackTaskId, 'src/bar.ts', 'created', {});
      const changes = fileTracking.getTaskFileChanges(trackTaskId);
      expect(Array.isArray(changes)).toBe(true);
      expect(changes.length).toBeGreaterThanOrEqual(2);
    });

    it('getTaskFileChanges returns empty array for task with no changes', () => {
      const noChangesId = uuidv4();
      taskCore.createTask({ id: noChangesId, task_description: 'No changes', status: 'queued', working_directory: testDir });
      const changes = fileTracking.getTaskFileChanges(noChangesId);
      expect(changes).toEqual([]);
    });
  });

  // ── Code Analysis Functions ──────────────────────────────
  describe('analyzeCodeComplexity', () => {
    let analysisTaskId;

    beforeAll(() => {
      analysisTaskId = uuidv4();
      taskCore.createTask({
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
      const result = codeAnalysis.analyzeCodeComplexity(analysisTaskId, 'fib.js', code);
      expect(result.cyclomatic_complexity).toBeGreaterThan(1);
      expect(result.lines_of_code).toBeGreaterThan(0);
      expect(result.function_count).toBeGreaterThanOrEqual(1);
      expect(result.max_nesting_depth).toBeGreaterThan(0);
      expect(typeof result.maintainability_index).toBe('number');
    });

    it('returns base complexity for empty content', () => {
      const result = codeAnalysis.analyzeCodeComplexity(analysisTaskId, 'empty.js', '');
      expect(result.cyclomatic_complexity).toBe(1); // base complexity
      expect(result.lines_of_code).toBe(0);
    });
  });

  describe('checkDocCoverage', () => {
    let docTaskId;

    beforeAll(() => {
      docTaskId = uuidv4();
      taskCore.createTask({ id: docTaskId, task_description: 'Doc test', status: 'completed', working_directory: testDir });
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
      const result = codeAnalysis.checkDocCoverage(docTaskId, 'test.ts', code);
      expect(result.total_public_items).toBe(2);
      expect(result.documented_items).toBe(1);
      expect(result.coverage_percent).toBe(50);
      expect(result.missing_docs).toContain('undocumented');
    });

    it('returns 100% for file with no exports', () => {
      const code = `const x = 1;\nconst y = 2;`;
      const result = codeAnalysis.checkDocCoverage(docTaskId, 'internal.ts', code);
      expect(result.coverage_percent).toBe(100);
    });
  });

  describe('checkAccessibility', () => {
    let a11yTaskId;

    beforeAll(() => {
      a11yTaskId = uuidv4();
      taskCore.createTask({ id: a11yTaskId, task_description: 'A11y test', status: 'completed', working_directory: testDir });
    });

    it('detects missing alt attrs in HTML', () => {
      const html = `<div><img src="photo.jpg"><img src="icon.png" alt="icon"></div>`;
      const result = codeAnalysis.checkAccessibility(a11yTaskId, 'page.html', html);
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
      const result = codeAnalysis.checkAccessibility(a11yTaskId, 'good.html', html);
      const imgViolations = result.violations.filter(v => v.rule === 'img-alt');
      expect(imgViolations.length).toBe(0);
    });
  });

  describe('checkI18n', () => {
    let i18nTaskId;

    beforeAll(() => {
      i18nTaskId = uuidv4();
      taskCore.createTask({ id: i18nTaskId, task_description: 'I18n test', status: 'completed', working_directory: testDir });
    });

    it('detects hardcoded user-facing strings', () => {
      const code = `const msg = "Please enter your email address to continue";`;
      const result = codeAnalysis.checkI18n(i18nTaskId, 'form.tsx', code);
      expect(result.hardcoded_strings_count).toBeGreaterThanOrEqual(1);
    });

    it('returns zero for non-source files', () => {
      const result = codeAnalysis.checkI18n(i18nTaskId, 'data.json', '{"key": "value"}');
      expect(result.hardcoded_strings_count).toBe(0);
    });
  });

  describe('detectDeadCode', () => {
    let deadTaskId;

    beforeAll(() => {
      deadTaskId = uuidv4();
      taskCore.createTask({ id: deadTaskId, task_description: 'Dead code test', status: 'completed', working_directory: testDir });
    });

    it('finds unused functions', () => {
      const code = `
function usedFunction() { return 1; }
function unusedHelper() { return 2; }
const result = usedFunction();
console.log(result);`;
      const result = codeAnalysis.detectDeadCode(deadTaskId, 'test.js', code);
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
      const result = codeAnalysis.detectDeadCode(deadTaskId, 'mutual.js', code);
      const funcs = result.filter(d => d.type === 'unused_function');
      expect(funcs.length).toBe(0);
    });
  });

  describe('estimateResourceUsage', () => {
    let resTaskId;

    beforeAll(() => {
      resTaskId = uuidv4();
      taskCore.createTask({ id: resTaskId, task_description: 'Resource test', status: 'completed', working_directory: testDir });
    });

    it('detects infinite loop risk', () => {
      const code = `while (true) { process(); }`;
      const result = codeAnalysis.estimateResourceUsage(resTaskId, 'loop.js', code);
      expect(result.risk_factors).toContain('potential_infinite_loop');
      expect(result.cpu_risk_score).toBeGreaterThan(0);
    });

    it('detects blocking IO', () => {
      const code = `const data = fs.readFileSync('file.txt', 'utf8');`;
      const result = codeAnalysis.estimateResourceUsage(resTaskId, 'sync.js', code);
      expect(result.risk_factors).toContain('blocking_io');
    });

    it('returns base memory for safe code', () => {
      const code = `const x = 1 + 2;`;
      const result = codeAnalysis.estimateResourceUsage(resTaskId, 'safe.js', code);
      expect(result.risk_factors.length).toBe(0);
      expect(result.estimated_memory_mb).toBe(50); // base only
    });
  });

  describe('verifyTypeReferences', () => {
    let typeTaskId;
    let workDir;

    beforeAll(() => {
      typeTaskId = uuidv4();
      taskCore.createTask({ id: typeTaskId, task_description: 'Type ref test', status: 'completed', working_directory: testDir });
      // Create a temp working directory with a type file
      workDir = path.join(testDir, 'type-project');
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(workDir, 'types.ts'), `export interface ILogger { log(msg: string): void; }`);
    });

    it('finds type references in TypeScript', () => {
      const code = `class MyService implements ICustomType { }`;
      const result = codeAnalysis.verifyTypeReferences(typeTaskId, 'service.ts', code, workDir);
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
      const result = codeAnalysis.verifyTypeReferences(typeTaskId, 'simple.ts', code, workDir);
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
      taskCore.createTask({ id, task_description: 'To be deleted', status: 'queued', working_directory: testDir });
      taskCore.updateTaskStatus(id, 'cancelled');
      expect(taskCore.getTask(id)).not.toBeNull();
      taskCore.deleteTask(id);
      expect(taskCore.getTask(id)).toBeFalsy();
    });

    it('safeJsonParse handles malformed JSON', () => {
      const result = eventTracking.safeJsonParse('not valid json', 'fallback');
      expect(result).toBe('fallback');
    });

    it('safeJsonParse parses valid JSON', () => {
      const result = eventTracking.safeJsonParse('{"a":1}', null);
      expect(result).toEqual({ a: 1 });
    });

    it('escapeLikePattern escapes special characters', () => {
      const result = eventTracking.escapeLikePattern('100% match_test');
      expect(result).toContain('\\%');
      expect(result).toContain('\\_');
    });

    it('getRunningCount returns a number', () => {
      const count = taskCore.getRunningCount();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
