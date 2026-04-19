'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

function seedPausedBaselineProject(db, { probeAttempts = 0, tickCountSincePause = 1 } = {}) {
  const cfg = {
    loop: { auto_continue: true },
    baseline_broken_since: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    baseline_broken_reason: 'verify_failed_baseline_unrelated',
    baseline_broken_evidence: { failing_tests: ['tests/foo.py'], exit_code: 1 },
    baseline_broken_probe_attempts: probeAttempts,
    baseline_broken_tick_count: tickCountSincePause,
  };
  const projectId = 'proj-probe-e2e';
  db.prepare(
    `INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
     VALUES (?, 'ProbeTest', '/tmp/probe', 'dark', 'paused', ?, datetime('now'), datetime('now'))`
  ).run(projectId, JSON.stringify(cfg));
  return projectId;
}

describe('factory-tick baseline probe phase', () => {
  let db;
  beforeEach(() => {
    setupTestDb('baseline-probe-tick');
    db = rawDb();
  });
  afterEach(() => { teardownTestDb(); vi.restoreAllMocks(); });

  it('probes paused project on first tick; clears flag + resumes on green probe', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');
    const eventBus = require('../event-bus');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 1 });

    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: true, exitCode: 0, output: 'all green', durationMs: 5000, error: null,
    });
    const eventSpy = vi.fn();
    eventBus.onFactoryProjectBaselineCleared(eventSpy);

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await factoryTick.tickProject(project);

    const updated = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('running');
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_since).toBeNull();
    expect(cfg.baseline_broken_reason).toBeNull();
    expect(eventSpy).toHaveBeenCalledTimes(1);
  });

  it('probes paused project; stays paused on red probe and increments attempts', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 1 });

    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: false, exitCode: 1, output: 'FAILED tests/foo.py', durationMs: 5000, error: null,
    });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await factoryTick.tickProject(project);

    const updated = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('paused');
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_since).toBeTruthy();
    expect(cfg.baseline_broken_probe_attempts).toBe(1);
  });

  it('skips probing when tick count has not reached the next backoff slot', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 1, tickCountSincePause: 2 });

    const probeSpy = vi.spyOn(baselineProbe, 'probeProjectBaseline');

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await factoryTick.tickProject(project);

    expect(probeSpy).not.toHaveBeenCalled();

    const updated = db.prepare('SELECT config_json FROM factory_projects WHERE id = ?').get(projectId);
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_tick_count).toBe(3);
  });

  it('probes at backoff slots with gaps 1, 2, 4, 8, 12, 12, 12', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const probeSpy = vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: false, exitCode: 1, output: 'FAIL', durationMs: 1, error: null,
    });

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 0 });
    const expectedGaps = [1, 2, 4, 8, 12, 12, 12];

    for (let i = 0; i < expectedGaps.length; i += 1) {
      const row = db.prepare('SELECT config_json FROM factory_projects WHERE id = ?').get(projectId);
      const cfg = JSON.parse(row.config_json);
      cfg.baseline_broken_tick_count = (cfg.baseline_broken_tick_count || 0) + expectedGaps[i];
      db.prepare('UPDATE factory_projects SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), projectId);

      const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
      await factoryTick.tickProject(project);
    }

    expect(probeSpy).toHaveBeenCalledTimes(expectedGaps.length);
  });

  it('probe errors (thrown) do not clear the flag and do not crash the tick', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 1 });
    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockRejectedValue(new Error('remote down'));

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await expect(factoryTick.tickProject(project)).resolves.toBeUndefined();

    const updated = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('paused');
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_since).toBeTruthy();
  });
});
