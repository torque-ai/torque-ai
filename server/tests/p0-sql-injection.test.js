/**
 * P0 SQL injection and token validation security tests.
 */

const { randomUUID } = require('crypto');

let testDir;
let db;
let projectCache;
const costTracking = require('../db/cost-tracking');
const configCore = require('../db/config-core');
const taskCore = require('../db/task-core');
const { setupTestDbOnly, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

function setup() {
  ({ db, testDir } = setupTestDbOnly('injection-'));
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;

  projectCache = require('../db/project-cache');
  projectCache.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  projectCache.setGetTask((id) => taskCore.getTask(id));
  projectCache.setDbFunctions({ getConfig: configCore.getConfig });
}

function teardown() {
  teardownTestDb();
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const payload = {
    id,
    task_description: 'security test task',
    working_directory: testDir,
    status: overrides.status || 'completed',
  };
  taskCore.createTask(payload);

  db.getDb().prepare('UPDATE tasks SET project = ? WHERE id = ?').run('security-project', id);
  return taskCore.getTask(id);
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
