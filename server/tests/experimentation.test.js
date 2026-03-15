const path = require('path');
const os = require('os');
const fs = require('fs');
const { _randomUUID } = require('crypto');

let testDir, origDataDir, db, mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-experimentation-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../db/analytics');
  mod.setDb(db.getDb());
  mod.setDbFunctions({
    getCacheStats: () => ({ hits: 0, misses: 0, total: 0 }),
    setCacheConfig: (_v) => {}
  });
  mod.setSetPriorityWeights(() => {});
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
    else delete process.env.TORQUE_DATA_DIR;
  }
}

function rawDb() {
  if (db.getDb) return db.getDb();
  return db.getDbInstance();
}

function resetState() {
  const tables = ['strategy_experiments', 'intelligence_log', 'failure_patterns'];
  for (const table of tables) {
    rawDb().prepare(`DELETE FROM ${table}`).run();
  }
}

describe('experimentation module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('createExperiment', () => {
    it('creates an experiment with initial state', () => {
      const exp = mod.createExperiment(
        'Test Experiment',
        'prioritization',
        { resource: 0.3, success: 0.3 },
        { resource: 0.5, success: 0.2 },
        50
      );

      expect(exp.id).toBeTruthy();
      expect(exp.name).toBe('Test Experiment');
      expect(exp.strategy_type).toBe('prioritization');
    });

    it('stores variants as JSON', () => {
      const exp = mod.createExperiment(
        'JSON test',
        'caching',
        { ttl: 300 },
        { ttl: 600 }
      );

      const fetched = mod.getExperiment(exp.id);
      expect(fetched.variant_a).toEqual({ ttl: 300 });
      expect(fetched.variant_b).toEqual({ ttl: 600 });
    });

    it('initializes results with zero counts', () => {
      const exp = mod.createExperiment('Init', 'prioritization', {}, {});
      const fetched = mod.getExperiment(exp.id);

      expect(fetched.results_a).toEqual({ count: 0, successes: 0, total_duration: 0 });
      expect(fetched.results_b).toEqual({ count: 0, successes: 0, total_duration: 0 });
    });

    it('sets status to running', () => {
      const exp = mod.createExperiment('Running', 'prioritization', {}, {});
      const fetched = mod.getExperiment(exp.id);
      expect(fetched.status).toBe('running');
    });
  });

  describe('getExperiment', () => {
    it('returns null for non-existent experiment', () => {
      expect(mod.getExperiment('missing-id')).toBeNull();
    });

    it('parses all JSON fields', () => {
      const exp = mod.createExperiment('Parse', 'test', { a: 1 }, { b: 2 });
      const fetched = mod.getExperiment(exp.id);

      expect(fetched.variant_a).toEqual({ a: 1 });
      expect(fetched.variant_b).toEqual({ b: 2 });
      expect(fetched.results_a).toBeTypeOf('object');
      expect(fetched.results_b).toBeTypeOf('object');
    });
  });

  describe('listExperiments', () => {
    it('lists all experiments', () => {
      mod.createExperiment('Exp 1', 'a', {}, {});
      mod.createExperiment('Exp 2', 'b', {}, {});

      const all = mod.listExperiments();
      expect(all).toHaveLength(2);
    });

    it('filters by status', () => {
      const exp = mod.createExperiment('Running Exp', 'test', {}, {});
      rawDb().prepare('UPDATE strategy_experiments SET status = ? WHERE id = ?').run('completed', exp.id);
      mod.createExperiment('Still Running', 'test', {}, {});

      const running = mod.listExperiments('running');
      const completed = mod.listExperiments('completed');

      expect(running).toHaveLength(1);
      expect(completed).toHaveLength(1);
    });

    it('parses JSON fields in listed experiments', () => {
      mod.createExperiment('Parsed', 'test', { x: 1 }, { y: 2 });
      const [exp] = mod.listExperiments();

      expect(exp.variant_a).toEqual({ x: 1 });
      expect(exp.results_a).toBeTypeOf('object');
    });
  });

  describe('assignExperimentVariant', () => {
    it('deterministically assigns variant based on task+experiment IDs', () => {
      const v1 = mod.assignExperimentVariant('task-1', 'exp-1');
      const v2 = mod.assignExperimentVariant('task-1', 'exp-1');

      expect(v1).toBe(v2);
      expect(['a', 'b']).toContain(v1);
    });

    it('different tasks may get different variants', () => {
      const variants = new Set();
      for (let i = 0; i < 20; i++) {
        variants.add(mod.assignExperimentVariant(`task-${i}`, 'exp-test'));
      }
      // With 20 tasks, we should see both variants
      expect(variants.size).toBe(2);
    });
  });

  describe('recordExperimentOutcome', () => {
    it('records success outcome for variant a', () => {
      const exp = mod.createExperiment('Outcome A', 'test', {}, {});

      const ok = mod.recordExperimentOutcome(exp.id, 'a', true, 120);
      expect(ok).toBe(true);

      const fetched = mod.getExperiment(exp.id);
      expect(fetched.results_a.count).toBe(1);
      expect(fetched.results_a.successes).toBe(1);
      expect(fetched.results_a.total_duration).toBe(120);
    });

    it('records failure outcome for variant b', () => {
      const exp = mod.createExperiment('Outcome B', 'test', {}, {});

      mod.recordExperimentOutcome(exp.id, 'b', false, 60);

      const fetched = mod.getExperiment(exp.id);
      expect(fetched.results_b.count).toBe(1);
      expect(fetched.results_b.successes).toBe(0);
      expect(fetched.results_b.total_duration).toBe(60);
    });

    it('accumulates results across multiple outcomes', () => {
      const exp = mod.createExperiment('Multi', 'test', {}, {});

      mod.recordExperimentOutcome(exp.id, 'a', true, 100);
      mod.recordExperimentOutcome(exp.id, 'a', true, 200);
      mod.recordExperimentOutcome(exp.id, 'a', false, 50);

      const fetched = mod.getExperiment(exp.id);
      expect(fetched.results_a.count).toBe(3);
      expect(fetched.results_a.successes).toBe(2);
      expect(fetched.results_a.total_duration).toBe(350);
    });

    it('returns false for non-existent experiment', () => {
      expect(mod.recordExperimentOutcome('missing', 'a', true, 10)).toBe(false);
    });

    it('returns false for completed experiment', () => {
      const exp = mod.createExperiment('Done', 'test', {}, {});
      rawDb().prepare('UPDATE strategy_experiments SET status = ? WHERE id = ?').run('completed', exp.id);

      expect(mod.recordExperimentOutcome(exp.id, 'a', true, 10)).toBe(false);
    });
  });

  describe('computeExperimentSignificance', () => {
    it('returns insufficient_samples when counts are too low', () => {
      const exp = mod.createExperiment('Low N', 'test', {}, {});
      for (let i = 0; i < 5; i++) {
        mod.recordExperimentOutcome(exp.id, 'a', true, 10);
        mod.recordExperimentOutcome(exp.id, 'b', false, 10);
      }

      const result = mod.computeExperimentSignificance(exp.id);
      expect(result.significant).toBe(false);
      expect(result.reason).toBe('insufficient_samples');
    });

    it('computes z-test with sufficient samples', () => {
      const exp = mod.createExperiment('Sig Test', 'test', {}, {});
      // A: 80% success, B: 30% success
      for (let i = 0; i < 15; i++) {
        mod.recordExperimentOutcome(exp.id, 'a', i < 12, 10);
        mod.recordExperimentOutcome(exp.id, 'b', i < 5, 10);
      }

      const result = mod.computeExperimentSignificance(exp.id);
      expect(result.z_score).toBeGreaterThan(0);
      expect(result.rate_a).toBeCloseTo(0.8, 1);
      expect(result.rate_b).toBeCloseTo(1/3, 1);
      expect(result.winner).toBe('a');
    });

    it('returns null for non-existent experiment', () => {
      expect(mod.computeExperimentSignificance('missing')).toBeNull();
    });

    it('identifies winner correctly', () => {
      const exp = mod.createExperiment('Winner', 'test', {}, {});
      for (let i = 0; i < 15; i++) {
        mod.recordExperimentOutcome(exp.id, 'a', i < 3, 10);  // 20%
        mod.recordExperimentOutcome(exp.id, 'b', i < 13, 10); // 87%
      }

      const result = mod.computeExperimentSignificance(exp.id);
      expect(result.winner).toBe('b');
    });
  });

  describe('concludeExperiment', () => {
    it('marks experiment as completed', () => {
      const exp = mod.createExperiment('Conclude', 'test', {}, {});
      for (let i = 0; i < 15; i++) {
        mod.recordExperimentOutcome(exp.id, 'a', true, 10);
        mod.recordExperimentOutcome(exp.id, 'b', false, 10);
      }

      const result = mod.concludeExperiment(exp.id);
      expect(result).toBeTruthy();

      const fetched = mod.getExperiment(exp.id);
      expect(fetched.status).toBe('completed');
      expect(fetched.completed_at).toBeTruthy();
    });

    it('returns null for non-existent experiment', () => {
      expect(mod.concludeExperiment('missing')).toBeNull();
    });

    it('does not apply winner when applyWinner is false', () => {
      let prioritySet = false;
      mod.setSetPriorityWeights(() => { prioritySet = true; });

      const exp = mod.createExperiment('No Apply', 'prioritization', { r: 0.5 }, { r: 0.3 });
      for (let i = 0; i < 15; i++) {
        mod.recordExperimentOutcome(exp.id, 'a', true, 10);
        mod.recordExperimentOutcome(exp.id, 'b', false, 10);
      }

      mod.concludeExperiment(exp.id, false);
      expect(prioritySet).toBe(false);

      mod.setSetPriorityWeights(() => {});
    });
  });

  describe('getIntelligenceDashboard', () => {
    it('returns aggregated dashboard metrics', () => {
      mod.createExperiment('Dashboard Exp', 'test', {}, {});

      const dashboard = mod.getIntelligenceDashboard();
      expect(dashboard.cache).toBeTruthy();
      expect(dashboard.predictions).toBeTruthy();
      expect(dashboard.patterns).toBeTruthy();
      expect(dashboard.experiments).toBeTruthy();
      expect(dashboard.experiments.total_experiments).toBe(1);
      expect(dashboard.experiments.running).toBe(1);
    });

    it('reports null accuracy when no predictions exist', () => {
      const dashboard = mod.getIntelligenceDashboard();
      expect(dashboard.predictions.accuracy).toBeNull();
    });

    it('filters by since parameter', () => {
      mod.createExperiment('Recent', 'test', {}, {});
      const future = new Date(Date.now() + 86400000).toISOString();

      const dashboard = mod.getIntelligenceDashboard(future);
      // Predictions from intelligence_log with future date should show nothing
      expect(dashboard.predictions.total_predictions).toBe(0);
    });
  });
});
