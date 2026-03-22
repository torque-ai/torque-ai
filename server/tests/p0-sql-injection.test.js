/**
 * P0 SQL injection and token validation security tests.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let projectCache;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;
const costTracking = require('../db/cost-tracking');

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-injection-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;

  projectCache = require('../db/project-cache');
  projectCache.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  projectCache.setGetTask((id) => db.getTask(id));
  projectCache.setDbFunctions({ getConfig: db.getConfig });
}

function teardown() {
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

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const payload = {
    id,
    task_description: 'security test task',
    working_directory: testDir,
    status: overrides.status || 'completed',
  };
  db.createTask(payload);

  db.getDb().prepare('UPDATE tasks SET project = ? WHERE id = ?').run('security-project', id);
  return db.getTask(id);
}

describe('P0 SQL injection hardening', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  describe('project-cache explainQueryPlan', () => {
    it('rejects UNION injection attempts', () => {
      const result = projectCache.explainQueryPlan('SELECT * FROM tasks UNION SELECT * FROM tasks');
      expect(result.error).toBe('Only SELECT queries can be explained');
    });

    it('rejects semicolons and comments', () => {
      const semicolonResult = projectCache.explainQueryPlan('SELECT * FROM tasks;');
      const commentResult = projectCache.explainQueryPlan('SELECT * FROM tasks -- drop');
      const blockCommentResult = projectCache.explainQueryPlan('SELECT * FROM tasks /* comment */');

      expect(semicolonResult.error).toBe('Only SELECT queries can be explained');
      expect(commentResult.error).toBe('Only SELECT queries can be explained');
      expect(blockCommentResult.error).toBe('Only SELECT queries can be explained');
    });
  });

  describe('cost-tracking token validation', () => {
    it('rejects negative and NaN token values', () => {
      const task = createTask();

      const negativeResult = costTracking.recordTokenUsage(task.id, { input_tokens: -10, output_tokens: 20, model: 'codex' });
      const afterNegative = db.getDb().prepare('SELECT COUNT(*) AS cnt FROM token_usage WHERE task_id = ?').get(task.id);
      expect(negativeResult).toBe(0);
      expect(afterNegative.cnt).toBe(0);

      const nanResult = costTracking.recordTokenUsage(task.id, { input_tokens: Number.NaN, output_tokens: 30, model: 'codex' });
      const afterNaN = db.getDb().prepare('SELECT COUNT(*) AS cnt FROM token_usage WHERE task_id = ?').get(task.id);
      expect(nanResult).toBe(0);
      expect(afterNaN.cnt).toBe(0);

      const costTask = createTask();
      const negativeCostResult = costTracking.recordCost('codex', costTask.id, -10, 20, 'gpt-5.3-codex-spark');
      const nanCostResult = costTracking.recordCost('codex', costTask.id, 10, Number.NaN, 'gpt-5.3-codex-spark');
      const afterInvalidCost = db.getDb().prepare('SELECT COUNT(*) AS cnt FROM cost_tracking WHERE task_id = ?').get(costTask.id);

      expect(negativeCostResult).toBe(0);
      expect(nanCostResult).toBe(0);
      expect(afterInvalidCost.cnt).toBe(0);
    });
  });
});
