const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;
let testDir;
let origDataDir;
let db;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-linear-regression-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  }
  db.resetForTest(templateBuffer);
}

function teardownDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  if (testDir) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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
    task_description: 'test task',
    provider: 'codex',
    status: 'completed',
    ...overrides,
  });
  return id;
}

function addCostSample(daysAgo, costUsd) {
  const taskId = createTask();
  db.recordTokenUsage(taskId, {
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

    const forecast = db.getCostForecast();
    expect(forecast.trend_direction).toBe('stable');
    expect(forecast.slope).toBeCloseTo(0, 5);
    expect(forecast.trend_adjusted_monthly).toBeCloseTo(forecast.projected_monthly, 2);
  });

  it('returns increasing trend for rising costs', () => {
    addCostSample(2, 10);
    addCostSample(1, 20);
    addCostSample(0, 30);

    const forecast = db.getCostForecast();
    expect(forecast.slope).toBeGreaterThan(0);
    expect(forecast.trend_direction).toBe('increasing');
    expect(forecast.trend_adjusted_monthly).toBeGreaterThan(forecast.projected_monthly);
  });

  it('returns decreasing trend for falling costs', () => {
    addCostSample(2, 30);
    addCostSample(1, 20);
    addCostSample(0, 10);

    const forecast = db.getCostForecast();
    expect(forecast.slope).toBeLessThan(0);
    expect(forecast.trend_direction).toBe('decreasing');
    expect(forecast.trend_adjusted_monthly).toBeLessThan(forecast.projected_monthly);
  });

  it('skips regression for sparse data', () => {
    addCostSample(2, 10);
    addCostSample(0, 20);

    const forecast = db.getCostForecast();
    expect(forecast.days_analyzed).toBeLessThan(3);
    expect(forecast.slope).toBeCloseTo(0, 5);
    expect(forecast.trend_direction).toBe('stable');
  });
});
