'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const Database = require('better-sqlite3');
const { createBudgetWatcher } = require('../db/budget-watcher');

let db;
let eventBus;
let budgetWatcher;

function insertBudget({
  id,
  name,
  provider = null,
  budgetAmount,
  period = 'monthly',
  enabled = 1,
}) {
  db.prepare(`
    INSERT INTO cost_budgets (
      id,
      name,
      provider,
      budget_amount,
      period,
      enabled
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    provider,
    budgetAmount,
    period,
    enabled
  );
}

function insertCost({
  provider,
  estimatedCost,
  createdAt = new Date().toISOString(),
}) {
  db.prepare(`
    INSERT INTO cost_tracking (
      provider,
      task_id,
      model,
      input_tokens,
      output_tokens,
      estimated_cost,
      tracked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(provider, 'task-1', 'model', 1, 1, estimatedCost, createdAt);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cost_budgets (
      id TEXT PRIMARY KEY,
      name TEXT,
      provider TEXT,
      budget_amount REAL,
      period TEXT DEFAULT 'monthly',
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE cost_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      task_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost REAL,
      tracked_at TEXT
    );
  `);

  eventBus = { emit: vi.fn() };
  budgetWatcher = createBudgetWatcher({ db, eventBus });
});

afterEach(() => {
  db.close();
});

describe('db/budget-watcher', () => {
  it('returns null when no budget exists for provider', () => {
    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result).toBeNull();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('returns 50% spend with no threshold breached', () => {
    insertBudget({
      id: 'budget-codex',
      name: 'Codex Monthly',
      provider: 'codex',
      budgetAmount: 100,
    });
    insertCost({ provider: 'codex', estimatedCost: 50 });

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result.budgetName).toBe('Codex Monthly');
    expect(result.provider).toBe('codex');
    expect(result.spendAmount).toBe(50);
    expect(result.budgetAmount).toBe(100);
    expect(result.spendPercent).toBe(50);
    expect(result.thresholdBreached).toBeNull();
    expect(result.action).toBeNull();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('returns warning threshold at 82% spend', () => {
    insertBudget({
      id: 'budget-warning',
      name: 'Warning Budget',
      provider: 'codex',
      budgetAmount: 100,
    });
    insertCost({ provider: 'codex', estimatedCost: 82 });

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result.thresholdBreached).toBe('warning');
    expect(result.action).toBe('emit_warning');
    expect(eventBus.emit).toHaveBeenCalledWith('budget:warning', {
      budgetName: 'Warning Budget',
      provider: 'codex',
      spendPercent: 82,
    });
  });

  it('returns downgrade threshold at 92% spend', () => {
    insertBudget({
      id: 'budget-downgrade',
      name: 'Downgrade Budget',
      provider: 'codex',
      budgetAmount: 100,
    });
    insertCost({ provider: 'codex', estimatedCost: 92 });

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result.thresholdBreached).toBe('downgrade');
    expect(result.action).toBe('activate_cost_saver');
    expect(eventBus.emit).toHaveBeenCalledWith('budget:downgrade', {
      budgetName: 'Downgrade Budget',
      provider: 'codex',
      spendPercent: 92,
      template: 'Cost Saver',
    });
  });

  it('returns hard_stop threshold at 100% spend', () => {
    insertBudget({
      id: 'budget-hard-stop',
      name: 'Hard Stop Budget',
      provider: 'codex',
      budgetAmount: 100,
    });
    insertCost({ provider: 'codex', estimatedCost: 100 });

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result.thresholdBreached).toBe('hard_stop');
    expect(result.action).toBe('block_submissions');
    expect(eventBus.emit).toHaveBeenCalledWith('budget:hard_stop', {
      budgetName: 'Hard Stop Budget',
      provider: 'codex',
      spendPercent: 100,
    });
  });

  it('getActiveBudgets returns all with percentages', () => {
    insertBudget({
      id: 'budget-alpha',
      name: 'Alpha Budget',
      provider: 'codex',
      budgetAmount: 10,
    });
    insertBudget({
      id: 'budget-beta',
      name: 'Beta Budget',
      provider: 'claude-cli',
      budgetAmount: 20,
    });
    insertCost({ provider: 'codex', estimatedCost: 5 });
    insertCost({ provider: 'claude-cli', estimatedCost: 10 });

    const budgets = budgetWatcher.getActiveBudgets();

    expect(budgets).toHaveLength(2);
    expect(budgets).toContainEqual({
      budgetName: 'Alpha Budget',
      provider: 'codex',
      spendAmount: 5,
      budgetAmount: 10,
      spendPercent: 50,
      thresholdBreached: null,
      action: null,
    });
    expect(budgets).toContainEqual({
      budgetName: 'Beta Budget',
      provider: 'claude-cli',
      spendAmount: 10,
      budgetAmount: 20,
      spendPercent: 50,
      thresholdBreached: null,
      action: null,
    });
  });

  it('configureBudgetAction updates thresholds', () => {
    insertBudget({
      id: 'budget-configured',
      name: 'Configured Budget',
      provider: 'codex',
      budgetAmount: 100,
    });

    const config = budgetWatcher.configureBudgetAction('budget-configured', {
      warningPercent: 70,
      downgradePercent: 85,
      downgradeTemplate: 'cost-saver',
      hardStopPercent: 95,
    });

    expect(config).toEqual({
      warningPercent: 70,
      downgradePercent: 85,
      downgradeTemplate: 'cost-saver',
      hardStopPercent: 95,
    });

    const hasThresholdConfigColumn = db.prepare(`
      PRAGMA table_info(cost_budgets)
    `).all().some((column) => column.name === 'threshold_config');

    if (hasThresholdConfigColumn) {
      const budgetRow = db.prepare(`
        SELECT threshold_config
        FROM cost_budgets
        WHERE id = ?
      `).get('budget-configured');
      const storedConfig = JSON.parse(budgetRow.threshold_config);

      expect(storedConfig.warningPercent).toBe(70);
      expect(storedConfig.downgradePercent).toBe(85);
      expect(storedConfig.hardStopPercent).toBe(95);
      expect(storedConfig.downgradeTemplate).toBe('cost-saver');
    } else {
      const actionRow = db.prepare(`
        SELECT *
        FROM budget_threshold_actions
        WHERE budget_id = ?
      `).get('budget-configured');

      expect(actionRow.warning_percent).toBe(70);
      expect(actionRow.downgrade_percent).toBe(85);
      expect(actionRow.hard_stop_percent).toBe(95);
      expect(actionRow.downgrade_template).toBe('cost-saver');
    }
  });

  it('custom thresholds override defaults', () => {
    insertBudget({
      id: 'budget-override',
      name: 'Override Budget',
      provider: 'codex',
      budgetAmount: 100,
    });

    budgetWatcher.configureBudgetAction('budget-override', {
      warningPercent: 30,
      downgradePercent: 40,
      hardStopPercent: 50,
      downgradeTemplate: 'Custom Saver',
    });
    insertCost({ provider: 'codex', estimatedCost: 45 });

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result.thresholdBreached).toBe('downgrade');
    expect(result.action).toBe('activate_cost_saver');
  });
});
