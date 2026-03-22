const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir, origDataDir, db, taskCore, mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-failure-prediction-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  taskCore = require('../db/task-core');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../db/analytics');
  mod.setDb(db.getDb());
  mod.setGetTask((id) => taskCore.getTask(id));
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
  const tables = ['intelligence_log', 'failure_patterns', 'tasks'];
  for (const table of tables) {
    rawDb().prepare(`DELETE FROM ${table}`).run();
  }
}

function mkTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'failure test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex'
  };
  taskCore.createTask(task);
  return taskCore.getTask(task.id);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...entries.map(([, v]) => v), taskId);
}

describe('failure-prediction module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('extractKeywords', () => {
    it('extracts signal words from text', () => {
      const keywords = mod.extractKeywords('deploy to production and run test');
      expect(keywords).toContain('deploy');
      expect(keywords).toContain('production');
      expect(keywords).toContain('test');
    });

    it('returns empty array for null/empty text', () => {
      expect(mod.extractKeywords(null)).toEqual([]);
      expect(mod.extractKeywords('')).toEqual([]);
    });

    it('ignores non-signal words', () => {
      const keywords = mod.extractKeywords('the quick brown fox');
      expect(keywords).toEqual([]);
    });

    it('is case insensitive', () => {
      const keywords = mod.extractKeywords('DEPLOY and BUILD');
      expect(keywords).toContain('deploy');
      expect(keywords).toContain('build');
    });
  });

  describe('learnFailurePattern', () => {
    it('creates keyword and time-based patterns from failed task', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy to production' });
      const patterns = mod.learnFailurePattern(task.id);

      expect(patterns.length).toBeGreaterThanOrEqual(2); // keywords + time-based
      const types = patterns.map(p => p.type);
      expect(types).toContain('keyword');
      expect(types).toContain('time_based');
    });

    it('returns null for non-failed task', () => {
      const task = mkTask({ status: 'completed', task_description: 'completed task' });
      expect(mod.learnFailurePattern(task.id)).toBeNull();
    });

    it('returns null for non-existent task', () => {
      expect(mod.learnFailurePattern('missing-id')).toBeNull();
    });

    it('increments failure_count on repeated failures', () => {
      const t1 = mkTask({ status: 'failed', task_description: 'deploy app v1' });
      const t2 = mkTask({ status: 'failed', task_description: 'deploy app v2' });

      mod.learnFailurePattern(t1.id);
      mod.learnFailurePattern(t2.id);

      const patterns = rawDb().prepare('SELECT * FROM failure_patterns WHERE pattern_type = ?').all('keyword');
      const deployPattern = patterns.find(p => {
        const def = JSON.parse(p.pattern_definition);
        return def.keyword === 'deploy';
      });
      expect(deployPattern.failure_count).toBe(2);
    });

    it('creates resource pattern for long-running failed tasks', () => {
      const task = mkTask({ status: 'failed', task_description: 'migrate database' });
      patchTask(task.id, {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T01:00:00.000Z'
      });

      const patterns = mod.learnFailurePattern(task.id);
      const types = patterns.map(p => p.type);
      expect(types).toContain('resource');
    });

    it('does not create resource pattern for short tasks', () => {
      const task = mkTask({ status: 'failed', task_description: 'quick test' });
      patchTask(task.id, {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:05:00.000Z'
      });

      const patterns = mod.learnFailurePattern(task.id);
      const types = patterns.map(p => p.type);
      expect(types).not.toContain('resource');
    });
  });

  describe('matchPatterns', () => {
    it('matches keyword patterns against task description', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy to production' });
      mod.learnFailurePattern(task.id);

      // Set confidence high enough to be matched
      rawDb().prepare('UPDATE failure_patterns SET confidence = 0.5 WHERE pattern_type = ?').run('keyword');

      const matches = mod.matchPatterns('deploy new version');
      const keywordMatches = matches.filter(m => m.pattern_type === 'keyword');
      expect(keywordMatches.length).toBeGreaterThan(0);
    });

    it('returns empty array when no patterns match', () => {
      const matches = mod.matchPatterns('completely unique task with no history');
      expect(matches).toEqual([]);
    });

    it('filters out low-confidence patterns', () => {
      const task = mkTask({ status: 'failed', task_description: 'build something' });
      mod.learnFailurePattern(task.id);

      // Set very low confidence
      rawDb().prepare('UPDATE failure_patterns SET confidence = 0.1').run();

      const matches = mod.matchPatterns('build another thing');
      expect(matches).toEqual([]);
    });
  });

  describe('predictFailureForTask', () => {
    it('returns low default probability when no patterns exist', () => {
      const prediction = mod.predictFailureForTask('some new task');
      expect(prediction.probability).toBe(0.1);
      expect(prediction.patterns).toEqual([]);
      expect(prediction.confidence).toBe(0.5);
    });

    it('computes weighted probability from matched patterns', () => {
      const t1 = mkTask({ status: 'failed', task_description: 'deploy to production' });
      mod.learnFailurePattern(t1.id);
      rawDb().prepare('UPDATE failure_patterns SET confidence = 0.5').run();

      const prediction = mod.predictFailureForTask('deploy new version');
      expect(prediction.patterns.length).toBeGreaterThan(0);
      expect(prediction.probability).toBeGreaterThan(0);
    });

    it('returns parsed pattern definitions', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy app' });
      mod.learnFailurePattern(task.id);
      rawDb().prepare('UPDATE failure_patterns SET confidence = 0.5').run();

      const prediction = mod.predictFailureForTask('deploy service');
      for (const p of prediction.patterns) {
        expect(p.definition).toBeTypeOf('object');
      }
    });
  });

  describe('listFailurePatterns', () => {
    it('lists all patterns with parsed fields', () => {
      const task = mkTask({ status: 'failed', task_description: 'build and deploy' });
      mod.learnFailurePattern(task.id);

      const patterns = mod.listFailurePatterns();
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(p.pattern_definition).toBeTypeOf('object');
      }
    });

    it('filters by pattern type', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy app' });
      mod.learnFailurePattern(task.id);

      const keywords = mod.listFailurePatterns({ patternType: 'keyword' });
      const timeBased = mod.listFailurePatterns({ patternType: 'time_based' });

      expect(keywords.every(p => p.pattern_type === 'keyword')).toBe(true);
      expect(timeBased.every(p => p.pattern_type === 'time_based')).toBe(true);
    });

    it('respects minConfidence filter', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy production' });
      mod.learnFailurePattern(task.id);

      const high = mod.listFailurePatterns({ minConfidence: 0.9 });
      expect(high).toEqual([]);
    });
  });

  describe('deleteFailurePattern', () => {
    it('deletes an existing pattern', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy app' });
      const patterns = mod.learnFailurePattern(task.id);

      const deleted = mod.deleteFailurePattern(patterns[0].id);
      expect(deleted).toBe(true);
    });

    it('returns false for non-existent pattern', () => {
      expect(mod.deleteFailurePattern('missing-pattern')).toBe(false);
    });
  });

  describe('suggestIntervention', () => {
    it('suggests interventions for production deployments', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy to production' });
      mod.learnFailurePattern(task.id);
      rawDb().prepare('UPDATE failure_patterns SET confidence = 0.8, failure_rate = 0.9').run();

      const result = mod.suggestIntervention('deploy to production now');
      expect(result.interventions.length).toBeGreaterThan(0);
      const types = result.interventions.map(i => i.type);
      expect(types).toContain('increase_timeout');
    });

    it('returns empty interventions when no patterns match', () => {
      const result = mod.suggestIntervention('completely unknown task');
      expect(result.interventions).toEqual([]);
      expect(result.prediction.probability).toBe(0.1);
    });
  });

  describe('intelligence log', () => {
    it('logs an intelligence action and returns id', () => {
      const logId = mod.logIntelligenceAction('task-x', 'failure_predicted', { risk: 0.8 }, 0.75);
      expect(logId).toBeTruthy();

      const row = rawDb().prepare('SELECT * FROM intelligence_log WHERE id = ?').get(logId);
      expect(row.task_id).toBe('task-x');
      expect(row.outcome).toBe('pending');
    });

    it('updateIntelligenceOutcome updates outcome', () => {
      const logId = mod.logIntelligenceAction('task-y', 'suggestion', { info: true }, 0.5);
      mod.updateIntelligenceOutcome(logId, 'correct');

      const row = rawDb().prepare('SELECT * FROM intelligence_log WHERE id = ?').get(logId);
      expect(row.outcome).toBe('correct');
    });

    it('updateIntelligenceOutcome adjusts pattern confidence for failure_predicted', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy release' });
      const patterns = mod.learnFailurePattern(task.id);
      const patternIds = patterns.map(p => p.id);

      const logId = mod.logIntelligenceAction(
        task.id, 'failure_predicted',
        { pattern_ids: patternIds }, 0.7
      );

      const beforeConf = rawDb().prepare('SELECT confidence FROM failure_patterns WHERE id = ?').get(patternIds[0]);
      mod.updateIntelligenceOutcome(logId, 'correct');
      const afterConf = rawDb().prepare('SELECT confidence FROM failure_patterns WHERE id = ?').get(patternIds[0]);

      expect(afterConf.confidence).toBeGreaterThan(beforeConf.confidence);
    });

    it('decreases confidence on incorrect outcome', () => {
      const task = mkTask({ status: 'failed', task_description: 'deploy app' });
      const patterns = mod.learnFailurePattern(task.id);
      const patternIds = patterns.map(p => p.id);

      const logId = mod.logIntelligenceAction(
        task.id, 'failure_predicted',
        { pattern_ids: patternIds }, 0.7
      );

      const beforeConf = rawDb().prepare('SELECT confidence FROM failure_patterns WHERE id = ?').get(patternIds[0]);
      mod.updateIntelligenceOutcome(logId, 'incorrect');
      const afterConf = rawDb().prepare('SELECT confidence FROM failure_patterns WHERE id = ?').get(patternIds[0]);

      expect(afterConf.confidence).toBeLessThan(beforeConf.confidence);
    });
  });
});
