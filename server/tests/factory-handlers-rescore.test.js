'use strict';

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const factoryHealth = require('../db/factory/health');

let projectDir;

describe('rescore_all_projects', () => {
  beforeAll(() => {
    setupTestDb('rescore-all');
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescore-proj-'));
    fs.mkdirSync(path.join(projectDir, 'server'));
    fs.writeFileSync(path.join(projectDir, 'server', 'app.js'), 'const x = 1;\n');
    factoryHealth.registerProject({
      name: 'RescoreTarget',
      path: projectDir,
      trust_level: 'supervised',
    });
  });

  afterAll(() => {
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    teardownTestDb();
  });

  test('re-scores every registered project and reports a summary', async () => {
    const result = await safeTool('rescore_all_projects', {});
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(getText(result));
    expect(payload.summary.length).toBeGreaterThanOrEqual(1);
    const entry = payload.summary.find(s => s.project === 'RescoreTarget');
    expect(entry).toBeTruthy();
    expect(entry.error).toBeFalsy();
    expect(Array.isArray(entry.dimensions)).toBe(true);
    expect(entry.dimensions.length).toBe(10);
  });
});
