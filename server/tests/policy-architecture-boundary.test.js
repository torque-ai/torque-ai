const fs = require('fs');
const path = require('path');

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const architectureAdapter = require('../policy-engine/adapters/architecture');

describe('policy architecture boundary adapter', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ db, testDir } = setupTestDb('policy-architecture-boundary'));
  });

  afterEach(() => {
    teardownTestDb();
  });

  function writeProjectFile(relativePath, content) {
    const fullPath = path.join(testDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return fullPath;
  }

  function seedBoundary({
    id = 'boundary-1',
    project = 'Torque',
    name = 'UI boundary',
    boundaryType = 'layer',
    sourcePatterns = ['src/ui/**'],
    allowedDependencies = [],
    forbiddenDependencies = [],
    enabled = 1,
  } = {}) {
    rawDb().prepare(`
      INSERT INTO architecture_boundaries (
        id, project, name, boundary_type, source_patterns,
        allowed_dependencies, forbidden_dependencies, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      project,
      name,
      boundaryType,
      JSON.stringify(sourcePatterns),
      JSON.stringify(allowedDependencies),
      JSON.stringify(forbiddenDependencies),
      enabled,
    );
    return id;
  }

  it('scanImports extracts require() calls correctly', () => {
    const imports = architectureAdapter.scanImports(
      'src/services/user-service.ts',
      `
        const repo = require('../data/user-repo');
        const cache = require("./cache");
      `,
    );

    expect(imports).toEqual([
      {
        source: 'src/services/user-service.ts',
        imported: 'src/data/user-repo',
      },
      {
        source: 'src/services/user-service.ts',
        imported: 'src/services/cache',
      },
    ]);
  });

  it('scanImports extracts ES import statements correctly', () => {
    const imports = architectureAdapter.scanImports(
      'src/ui/view.ts',
      `
        import helper from '../shared/helper';
        import { render } from "./render";
        const lazy = import('../data/lazy-module');
      `,
    );

    expect(imports).toEqual([
      {
        source: 'src/ui/view.ts',
        imported: 'src/shared/helper',
      },
      {
        source: 'src/ui/view.ts',
        imported: 'src/ui/render',
      },
      {
        source: 'src/ui/view.ts',
        imported: 'src/data/lazy-module',
      },
    ]);
  });

  it('scanImports ignores non-relative imports', () => {
    const imports = architectureAdapter.scanImports(
      'src/ui/view.ts',
      `
        const fs = require('fs');
        import React from 'react';
        const lazy = import('node:path');
      `,
    );

    expect(imports).toEqual([]);
  });

  it('checkBoundaries detects forbidden dependency violations', () => {
    const violations = architectureAdapter.checkBoundaries(
      [
        {
          source: 'src/ui/view.ts',
          imported: 'src/data/private/store',
        },
      ],
      [
        {
          id: 'ui-boundary',
          name: 'UI layer',
          boundary_type: 'layer',
          source_patterns: ['src/ui/**'],
          forbidden_dependencies: ['src/data/private/**'],
        },
      ],
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      boundary_id: 'ui-boundary',
      source_file: 'src/ui/view.ts',
      imported_file: 'src/data/private/store',
      violation_type: 'forbidden_import',
    });
  });

  it('checkBoundaries allows dependencies within allowed list', () => {
    const violations = architectureAdapter.checkBoundaries(
      [
        {
          source: 'src/ui/view.ts',
          imported: 'src/shared/formatters/date',
        },
      ],
      [
        {
          id: 'ui-boundary',
          name: 'UI layer',
          boundary_type: 'layer',
          source_patterns: ['src/ui/**'],
          allowed_dependencies: ['src/ui/**', 'src/shared/**'],
        },
      ],
    );

    expect(violations).toEqual([]);
  });

  it('checkBoundaries ignores files not matching any boundary source_patterns', () => {
    const violations = architectureAdapter.checkBoundaries(
      [
        {
          source: 'scripts/build.js',
          imported: 'src/data/private/store',
        },
      ],
      [
        {
          id: 'ui-boundary',
          name: 'UI layer',
          boundary_type: 'layer',
          source_patterns: ['src/ui/**'],
          forbidden_dependencies: ['src/data/private/**'],
        },
      ],
    );

    expect(violations).toEqual([]);
  });

  it('collectEvidence returns empty violations when no boundaries defined', () => {
    writeProjectFile(
      'src/ui/view.ts',
      `import helper from '../shared/helper';`,
    );

    const evidence = architectureAdapter.collectEvidence(
      { working_directory: testDir },
      ['src/ui/view.ts'],
      'Torque',
    );

    expect(evidence).toEqual({
      violations: [],
      boundaries_checked: 0,
      files_scanned: 0,
    });
  });

  it('collectEvidence records violations in architecture_violations table', () => {
    db.createTask({
      id: 'task-architecture-1',
      task_description: 'Architecture boundary task',
      status: 'completed',
      provider: 'codex',
      working_directory: testDir,
      project: 'Torque',
    });
    seedBoundary({
      id: 'ui-boundary',
      sourcePatterns: ['src/ui/**'],
      forbiddenDependencies: ['src/data/private/**'],
    });
    writeProjectFile(
      'src/ui/view.ts',
      `
        import store from '../data/private/store';
        const legacy = require('../data/private/legacy');
      `,
    );

    const evidence = architectureAdapter.collectEvidence(
      {
        id: 'task-architecture-1',
        working_directory: testDir,
      },
      ['src/ui/view.ts'],
      'Torque',
    );

    const storedViolations = rawDb().prepare(`
      SELECT boundary_id, source_file, imported_file, violation_type
      FROM architecture_violations
      ORDER BY imported_file ASC
    `).all();

    expect(evidence.boundaries_checked).toBe(1);
    expect(evidence.files_scanned).toBe(1);
    expect(evidence.violations).toHaveLength(2);
    expect(storedViolations).toEqual([
      {
        boundary_id: 'ui-boundary',
        source_file: 'src/ui/view.ts',
        imported_file: 'src/data/private/legacy',
        violation_type: 'forbidden_import',
      },
      {
        boundary_id: 'ui-boundary',
        source_file: 'src/ui/view.ts',
        imported_file: 'src/data/private/store',
        violation_type: 'forbidden_import',
      },
    ]);
  });
});
