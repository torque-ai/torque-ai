const { v4: uuidv4 } = require('uuid');

let db;
let taskCore;
let costTracking;
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

function setupDb() {
  ({ db } = setupTestDbOnly('linear-regression-'));
  taskCore = require('../db/task-core');
  costTracking = require('../db/cost-tracking');
}

function teardownDb() {
  teardownTestDb();
}

function createTask(overrides = {}) {
  const id = overrides.id || uuidv4();
  taskCore.createTask({
    id,
    task_description: 'test task',
    provider: 'codex',
    status: 'completed',
    ...overrides,
  });
  return id;
}

function addCostSample(daysAgo, costUsd) {
  const taskId = createTask();
  costTracking.recordTokenUsage(taskId, {
    input_tokens: 1000,
    output_tokens: 500,
    model: 'codex',
  });
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.getDbInstance().prepare(
    'UPDATE token_usage SET recorded_at = ?, estimated_cost_usd = ? WHERE task_id = ?'
  ).run(createdAt, costUsd, taskId);
}

describe('getCostForecast linear regression', () => {
  beforeEach(() => setupDb());
  afterEach(() => teardownDb());

  it('returns stable trend for flat costs', () => {
    addCostSample(2, 10);
    addCostSample(1, 10);
    addCostSample(0, 10);

    const forecast = costTracking.getCostForecast();
    expect(forecast.trend_direction).toBe('stable');
    expect(forecast.slope).toBeCloseTo(0, 5);
    expect(forecast.trend_adjusted_monthly).toBeCloseTo(forecast.projected_monthly, 2);
  });

  it('returns increasing trend for rising costs', () => {
    addCostSample(2, 10);
    addCostSample(1, 20);
    addCostSample(0, 30);

    const forecast = costTracking.getCostForecast();
    expect(forecast.slope).toBeGreaterThan(0);
    expect(forecast.trend_direction).toBe('increasing');
    expect(forecast.trend_adjusted_monthly).toBeGreaterThan(forecast.projected_monthly);
  });

  it('returns decreasing trend for falling costs', () => {
    addCostSample(2, 30);
    addCostSample(1, 20);
    addCostSample(0, 10);

    const forecast = costTracking.getCostForecast();
    expect(forecast.slope).toBeLessThan(0);
    expect(forecast.trend_direction).toBe('decreasing');
    expect(forecast.trend_adjusted_monthly).toBeLessThan(forecast.projected_monthly);
  });

  it('skips regression for sparse data', () => {
    addCostSample(2, 10);
    addCostSample(0, 20);

    const forecast = costTracking.getCostForecast();
    expect(forecast.days_analyzed).toBeLessThan(3);
    expect(forecast.slope).toBeCloseTo(0, 5);
    expect(forecast.trend_direction).toBe('stable');
  });
});
