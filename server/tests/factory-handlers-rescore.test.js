'use strict';

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const factoryHealth = require('../db/factory/health');
const { VALID_DIMENSIONS } = require('../db/factory/health');

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
    expect(entry.dimensions.length).toBe(VALID_DIMENSIONS.size);
  });

  test('rescore_all_projects is a registered, annotated, tiered tool', () => {
    const factoryDefs = require('../tool-defs/factory-defs');
    expect(factoryDefs.some(t => t.name === 'rescore_all_projects')).toBe(true);

    const coreTools = require('../core-tools');
    const flat = JSON.stringify(coreTools);
    expect(flat).toContain('rescore_all_projects');

    const annotations = require('../tool-annotations');
    const flatAnn = JSON.stringify(annotations);
    expect(flatAnn).toContain('rescore_all_projects');
  });
});
