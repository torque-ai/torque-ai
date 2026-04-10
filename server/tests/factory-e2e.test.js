'use strict';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const factoryHealth = require('../db/factory-health');
const handlers = require('../handlers/factory-handlers');

describe('factory end-to-end flow', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    runMigrations(db);
    factoryHealth.setDb(db);
  });

  afterEach(() => {
    db.close();
  });

  test('migration creates factory tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'factory_%'"
    ).all().map(r => r.name);
    expect(tables).toContain('factory_projects');
    expect(tables).toContain('factory_health_snapshots');
    expect(tables).toContain('factory_health_findings');
  });

  test('registerProject creates and returns a project', () => {
    const project = factoryHealth.registerProject({
      name: 'TestApp',
      path: '/projects/test-app',
      brief: 'A test application',
    });
    expect(project.id).toBeTruthy();
    expect(project.name).toBe('TestApp');
    expect(project.trust_level).toBe('supervised');
    expect(project.status).toBe('paused');
  });

  test('rejects duplicate paths', () => {
    factoryHealth.registerProject({ name: 'App1', path: '/app' });
    expect(() => {
      factoryHealth.registerProject({ name: 'App2', path: '/app' });
    }).toThrow();
  });

  test('rejects invalid trust_level', () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
    expect(() => {
      factoryHealth.updateProject(p.id, { trust_level: 'invalid' });
    }).toThrow();
  });

  test('getProject returns null for unknown id', () => {
    expect(factoryHealth.getProject('nonexistent')).toBeNull();
  });

  test('getProjectByPath resolves project', () => {
    const created = factoryHealth.registerProject({ name: 'App', path: '/my/app' });
    const fetched = factoryHealth.getProjectByPath('/my/app');
    expect(fetched.id).toBe(created.id);
  });

  test('listProjects returns all projects', () => {
    factoryHealth.registerProject({ name: 'A', path: '/a' });
    factoryHealth.registerProject({ name: 'B', path: '/b' });
    expect(factoryHealth.listProjects()).toHaveLength(2);
  });

  test('recordSnapshot and getLatestScores', () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 30 });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 50 });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 72 });

    const scores = factoryHealth.getLatestScores(p.id);
    expect(scores.test_coverage).toBe(50);
    expect(scores.security).toBe(72);
  });

  test('getScoreHistory returns time-series', () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 20 });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 35 });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 48 });

    const history = factoryHealth.getScoreHistory(p.id, 'test_coverage');
    expect(history).toHaveLength(3);
    expect(history[0].score).toBe(20);
    expect(history[2].score).toBe(48);
  });

  test('getBalanceScore returns 0 for equal scores', () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 60 });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 60 });
    expect(factoryHealth.getBalanceScore(p.id)).toBe(0);
  });

  test('getBalanceScore returns high value for imbalanced scores', () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 10 });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 90 });
    expect(factoryHealth.getBalanceScore(p.id)).toBeGreaterThan(30);
  });

  test('recordFindings and getFindings', () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
    const snap = factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 55 });
    factoryHealth.recordFindings(snap.id, [
      { severity: 'high', message: 'SQL injection in user search', file_path: 'src/api/users.js' },
      { severity: 'low', message: 'Missing CSRF token', file_path: 'src/pages/settings.js' },
    ]);
    const findings = factoryHealth.getFindings(snap.id);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('high');
  });

  test('handler: register + health + pause + resume full lifecycle', async () => {
    const regResult = await handlers.handleRegisterFactoryProject({
      name: 'WidgetApp', path: '/projects/widget', brief: 'Billing tool', trust_level: 'guided',
    });
    const regData = JSON.parse(regResult.content[0].text);
    expect(regData.project.trust_level).toBe('guided');
    const projectId = regData.project.id;

    // Record scores
    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'test_coverage', score: 31 });
    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'security', score: 72 });
    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'structural', score: 68 });

    // Query health
    const healthResult = await handlers.handleProjectHealth({ project: projectId });
    const healthData = JSON.parse(healthResult.content[0].text);
    expect(healthData.scores.test_coverage).toBe(31);
    expect(healthData.weakest_dimension.dimension).toBe('test_coverage');
    expect(healthData.balance).toBeGreaterThan(0);

    // Query by path
    const pathResult = await handlers.handleProjectHealth({ project: '/projects/widget' });
    expect(JSON.parse(pathResult.content[0].text).scores.security).toBe(72);

    // Factory status
    const statusResult = await handlers.handleFactoryStatus();
    const statusData = JSON.parse(statusResult.content[0].text);
    expect(statusData.projects).toHaveLength(1);
    expect(statusData.summary.total).toBe(1);

    // Pause
    await handlers.handlePauseProject({ project: projectId });
    expect(factoryHealth.getProject(projectId).status).toBe('paused');

    // Resume
    await handlers.handleResumeProject({ project: projectId });
    expect(factoryHealth.getProject(projectId).status).toBe('running');

    // Trust level
    await handlers.handleSetFactoryTrustLevel({ project: projectId, trust_level: 'autonomous' });
    expect(factoryHealth.getProject(projectId).trust_level).toBe('autonomous');

    // Pause all
    await handlers.handlePauseAllProjects();
    expect(factoryHealth.getProject(projectId).status).toBe('paused');
  });

  test('handler: list projects includes health data', async () => {
    const reg = await handlers.handleRegisterFactoryProject({ name: 'A', path: '/a' });
    const id = JSON.parse(reg.content[0].text).project.id;
    factoryHealth.recordSnapshot({ project_id: id, dimension: 'security', score: 80 });

    const result = await handlers.handleListFactoryProjects({});
    const data = JSON.parse(result.content[0].text);
    expect(data.projects[0].scores.security).toBe(80);
    expect(data.projects[0].balance).toBeDefined();
  });

  test('handler: scan records placeholder scores', async () => {
    const reg = await handlers.handleRegisterFactoryProject({ name: 'App', path: '/scan-test' });
    const id = JSON.parse(reg.content[0].text).project.id;

    const scanResult = await handlers.handleScanProjectHealth({
      project: id,
      dimensions: ['test_coverage', 'security'],
      scan_type: 'full',
    });
    const scanData = JSON.parse(scanResult.content[0].text);
    expect(scanData.results.test_coverage.score).toBe(0);
    expect(scanData.results.security.score).toBe(0);
  });
});
