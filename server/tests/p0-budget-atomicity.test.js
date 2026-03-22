const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
let costTracking;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-budget-atomicity-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  costTracking = require('../db/cost-tracking');
  costTracking.setDb(db.getDbInstance());
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

function createTask(overrides = {}) {
  const id = overrides.id || uuidv4();
  db.createTask({
    id,
    task_description: 'cost test task',
    provider: 'codex',
    status: 'completed',
    ...overrides,
  });
  return id;
}

function budgetIdForName(name) {
  return `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
}

describe('Budget atomicity and token validation', () => {
  beforeEach(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  it('simulates concurrent budget checks inside a transaction without exceeding the limit', () => {
    const budgetName = `Concurrent Budget ${Date.now()}`;
    costTracking.setBudget(budgetName, 100, null, 'monthly', 80);
    const budgetId = budgetIdForName(budgetName);

    const rawDb = db.getDbInstance();
    const spend = rawDb.transaction((amount) => {
      const budget = rawDb.prepare('SELECT * FROM cost_budgets WHERE id = ?').get(budgetId);
      if (!budget) {
        return { allowed: false };
      }

      const projectedSpend = budget.current_spend + amount;
      if (projectedSpend > budget.budget_usd) {
        return { allowed: false, current: budget.current_spend, limit: budget.budget_usd };
      }

      rawDb.prepare('UPDATE cost_budgets SET current_spend = current_spend + ? WHERE id = ?')
        .run(amount, budgetId);
      return { allowed: true, newSpend: projectedSpend };
    });

    const first = spend(70);
    const second = spend(70);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(costTracking.getBudgetStatus(budgetId).current_spend).toBe(70);
  });

  it('rejects negative token counts in token usage calculation', () => {
    const taskId = createTask();
    const result = costTracking.recordTokenUsage(taskId, {
      input_tokens: -42,
      output_tokens: -17,
      model: 'codex',
    });

    // Implementation returns 0 (early exit) for invalid inputs — no DB write
    expect(result).toBe(0);
  });

  it('rejects NaN/Infinity token counts in provider cost tracking', () => {
    const taskId = createTask();
    const result = costTracking.recordCost('codex', taskId, Number.NaN, Number.POSITIVE_INFINITY, 'gpt-5.3-codex-spark');

    // Implementation returns 0 (early exit) for invalid inputs — no DB write
    expect(result).toBe(0);

    const row = db.getDbInstance()
      .prepare('SELECT input_tokens, output_tokens, cost_usd FROM cost_tracking WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId);
    expect(row).toBeUndefined();
  });

  it('updates budget spend atomically and blocks spending beyond the limit', () => {
    const budgetName = `Atomic Spend ${Date.now()}`;
    costTracking.setBudget(budgetName, 100, 'codex', 'monthly', 80);
    const budgetId = budgetIdForName(budgetName);

    const firstSpend = costTracking.updateBudgetSpend('codex', 60);
    const secondSpend = costTracking.updateBudgetSpend('codex', 60);
    const budget = costTracking.getBudgetStatus(budgetId);

    expect(firstSpend.allowed).toBe(true);
    expect(secondSpend.allowed).toBe(false);
    expect(secondSpend.current).toBe(60);
    expect(secondSpend.limit).toBe(100);
    expect(budget.current_spend).toBe(60);
  });
});
