'use strict';
/* global describe, it, expect, beforeEach, afterEach */

const Database = require('better-sqlite3');
const budgetWatcher = require('../db/budget-watcher');

let db;

function insertBudget({
  id,
  name,
  provider = null,
  budgetUsd,
  period = 'monthly',
  alertThresholdPercent = 80,
  enabled = 1,
  metadata = null,
}) {
  db.prepare(`
    INSERT INTO cost_budgets (
      id, name, provider, budget_usd, period, current_spend,
      alert_threshold_percent, enabled, metadata
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    id,
    name,
    provider,
    budgetUsd,
    period,
    alertThresholdPercent,
    enabled,
    metadata
  );
}

function insertCost(provider, costUsd, trackedAt = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO cost_tracking (provider, cost_usd, tracked_at)
    VALUES (?, ?, ?)
  `).run(provider, costUsd, trackedAt);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cost_budgets (
      id TEXT PRIMARY KEY,
      name TEXT,
      provider TEXT,
      budget_usd REAL,
      period TEXT DEFAULT 'monthly',
      current_spend REAL DEFAULT 0,
      alert_threshold_percent INTEGER DEFAULT 80,
      enabled INTEGER DEFAULT 1,
      metadata TEXT
    );

    CREATE TABLE cost_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      cost_usd REAL,
      tracked_at TEXT
    );
  `);

  budgetWatcher.init(db);
});

afterEach(() => {
  db.close();
});

describe('db/budget-watcher', () => {
  it('returns null when no budget exists for provider', () => {
    expect(budgetWatcher.checkBudgetThresholds('codex')).toBeNull();
  });

  it('calculates spend percentage correctly', () => {
    insertBudget({
      id: 'budget-codex',
      name: 'Codex Monthly',
      provider: 'codex',
      budgetUsd: 10,
    });
    insertCost('codex', 8);

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result).toEqual({
      budgetName: 'Codex Monthly',
      budgetUsd: 10,
      currentSpend: 8,
      spendPercent: 80,
      thresholdBreached: 'warning',
      action: null,
    });
  });

  it('returns warning at 80%', () => {
    insertBudget({
      id: 'budget-warning',
      name: 'Warning Budget',
      provider: 'codex',
      budgetUsd: 10,
      alertThresholdPercent: 80,
    });
    insertCost('codex', 8);

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result.thresholdBreached).toBe('warning');
    expect(result.action).toBeNull();
  });

  it('returns downgrade at 90%', () => {
    insertBudget({
      id: 'budget-downgrade',
      name: 'Downgrade Budget',
      provider: 'codex',
      budgetUsd: 10,
    });
    insertCost('codex', 9);

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result.thresholdBreached).toBe('downgrade');
    expect(result.action).toBe('activate_cost_saver_template');
  });

  it('returns hard_stop at 100%', () => {
    insertBudget({
      id: 'budget-hard-stop',
      name: 'Hard Stop Budget',
      provider: 'codex',
      budgetUsd: 10,
    });
    insertCost('codex', 10);

    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(result.thresholdBreached).toBe('hard_stop');
    expect(result.action).toBe('block_submissions');
  });

  it('getActiveBudgets returns all budgets with spend info', () => {
    insertBudget({
      id: 'budget-alpha',
      name: 'Alpha Budget',
      provider: 'codex',
      budgetUsd: 10,
    });
    insertBudget({
      id: 'budget-beta',
      name: 'Beta Budget',
      provider: 'claude-cli',
      budgetUsd: 20,
    });
    insertCost('codex', 5);
    insertCost('claude-cli', 10);

    const budgets = budgetWatcher.getActiveBudgets();

    expect(budgets).toHaveLength(2);
    expect(budgets).toContainEqual({
      budgetName: 'Alpha Budget',
      budgetUsd: 10,
      currentSpend: 5,
      spendPercent: 50,
      thresholdBreached: null,
      action: null,
    });
    expect(budgets).toContainEqual({
      budgetName: 'Beta Budget',
      budgetUsd: 20,
      currentSpend: 10,
      spendPercent: 50,
      thresholdBreached: null,
      action: null,
    });
  });

  it('configureBudgetAction updates thresholds and stores downgrade metadata', () => {
    insertBudget({
      id: 'budget-configured',
      name: 'Configured Budget',
      provider: 'codex',
      budgetUsd: 10,
    });

    const config = budgetWatcher.configureBudgetAction('Configured Budget', {
      warningPercent: 70,
      downgradePercent: 85,
      downgradeTemplate: 'cost-saver',
      hardStopPercent: 95,
    });

    insertCost('codex', 8.6);

    const storedBudget = db.prepare(`
      SELECT alert_threshold_percent, metadata
      FROM cost_budgets
      WHERE name = ?
    `).get('Configured Budget');
    const metadata = JSON.parse(storedBudget.metadata);
    const result = budgetWatcher.checkBudgetThresholds('codex');

    expect(config).toEqual({
      budgetName: 'Configured Budget',
      warningPercent: 70,
      downgradePercent: 85,
      downgradeTemplate: 'cost-saver',
      hardStopPercent: 95,
    });
    expect(storedBudget.alert_threshold_percent).toBe(70);
    expect(metadata).toEqual({
      downgradePercent: 85,
      downgradeTemplate: 'cost-saver',
      hardStopPercent: 95,
    });
    expect(result.thresholdBreached).toBe('downgrade');
    expect(result.action).toBe('activate_cost_saver_template');
  });

  it('shouldBlockSubmission returns true when over 100%', () => {
    insertBudget({
      id: 'budget-block',
      name: 'Blocking Budget',
      provider: 'codex',
      budgetUsd: 10,
    });
    insertCost('codex', 11);

    expect(budgetWatcher.shouldBlockSubmission('codex')).toBe(true);
  });

  it('shouldBlockSubmission returns false when under 100%', () => {
    insertBudget({
      id: 'budget-allow',
      name: 'Allow Budget',
      provider: 'codex',
      budgetUsd: 10,
    });
    insertCost('codex', 9.99);

    expect(budgetWatcher.shouldBlockSubmission('codex')).toBe(false);
  });
});
