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

    const probeSpy = vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
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
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60 * 60 * 1000 }));
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

  it('uses project-configured baseline probe timeout when automatic probing runs', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 1 });
    const row = db.prepare('SELECT config_json FROM factory_projects WHERE id = ?').get(projectId);
    const cfg = JSON.parse(row.config_json);
    cfg.baseline_probe_timeout_minutes = 90;
    db.prepare('UPDATE factory_projects SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), projectId);

    const probeSpy = vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: false, exitCode: 1, output: 'FAIL', durationMs: 1, error: null,
    });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await factoryTick.tickProject(project);

    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 90 * 60 * 1000 }));
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

describe('handleResumeProjectBaselineFixed', () => {
  let db;
  beforeEach(() => {
    setupTestDb('baseline-resume');
    db = rawDb();
  });
  afterEach(() => { teardownTestDb(); vi.restoreAllMocks(); });

  it('returns error when project is not baseline-flagged', async () => {
    const projectId = 'proj-not-flagged';
    db.prepare(
      `INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
       VALUES (?, 'T', '/tmp/t', 'dark', 'running', '{}', datetime('now'), datetime('now'))`
    ).run(projectId);
    const { handleResumeProjectBaselineFixed } = require('../handlers/factory-handlers');
    const r = await handleResumeProjectBaselineFixed({ project: projectId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not flagged');
  });

  it('returns error when verify_command is missing', async () => {
    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0 });
    const projectConfigCore = require('../db/project-config-core');
    vi.spyOn(projectConfigCore, 'getProjectDefaults').mockReturnValue(null);
    const { handleResumeProjectBaselineFixed } = require('../handlers/factory-handlers');
    const r = await handleResumeProjectBaselineFixed({ project: projectId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('verify_command');
  });

  it('clears flag and resumes when probe passes', async () => {
    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0 });
    const projectConfigCore = require('../db/project-config-core');
    vi.spyOn(projectConfigCore, 'getProjectDefaults').mockReturnValue({ verify_command: 'npm test' });
    const baselineProbe = require('../factory/baseline-probe');
    const probeSpy = vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: true, exitCode: 0, output: 'all green', durationMs: 4321, error: null,
    });
    const {
      handleResumeProjectBaselineFixed,
      handleBaselineResumeJobStatus,
    } = require('../handlers/factory-handlers');
    const r = await handleResumeProjectBaselineFixed({ project: projectId, timeout_minutes: 75 });
    const job = r.structuredData;
    expect(r.isError).toBeFalsy();
    expect(r.status).toBe(202);
    expect(job).toBeTruthy();
    expect(job.status).toBe('running');
    const statusWhileRunning = await handleBaselineResumeJobStatus({ project: projectId, job_id: job.job_id });
    expect(statusWhileRunning.structuredData.job_id).toBe(job.job_id);
    expect(['running', 'completed']).toContain(statusWhileRunning.structuredData.status);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const statusAfterRun = await handleBaselineResumeJobStatus({ project: projectId, job_id: job.job_id });
    expect(statusAfterRun.structuredData.status).toBe('completed');
    expect(statusAfterRun.structuredData.project_resumed).toBe(true);
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 75 * 60 * 1000 }));
    const updated = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('running');
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_since).toBeNull();
  });

  it('returns error + preserves flag when probe still fails', async () => {
    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0 });
    const projectConfigCore = require('../db/project-config-core');
    vi.spyOn(projectConfigCore, 'getProjectDefaults').mockReturnValue({ verify_command: 'npm test' });
    const baselineProbe = require('../factory/baseline-probe');
    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: false, exitCode: 1, output: 'FAILED tests/foo.py', durationMs: 100, error: null,
    });
    const {
      handleResumeProjectBaselineFixed,
      handleBaselineResumeJobStatus,
    } = require('../handlers/factory-handlers');
    const r = await handleResumeProjectBaselineFixed({ project: projectId });
    expect(r.isError).toBeFalsy();
    expect(r.status).toBe(202);
    const job = r.structuredData;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const statusAfterRun = await handleBaselineResumeJobStatus({ project: projectId, job_id: job.job_id });
    expect(statusAfterRun.structuredData.status).toBe('failed');
    expect(statusAfterRun.structuredData.message).toContain('Baseline still failing');
    expect(statusAfterRun.structuredData.preview_output).toContain('FAILED tests/foo.py');
    const updated = db.prepare('SELECT status FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('paused');
  });

  it('returns 404 for missing status job id', async () => {
    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0 });
    const { handleBaselineResumeJobStatus } = require('../handlers/factory-handlers');
    const r = await handleBaselineResumeJobStatus({ project: projectId, job_id: 'nope' });
    expect(r.status).toBe(404);
    expect(r.errorCode).toBe('baseline_resume_job_not_found');
    expect(r.errorMessage).toContain('Baseline resume job not found');
  });
});
