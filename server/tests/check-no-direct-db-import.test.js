'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const guard = require('../scripts/check-no-direct-db-import');

describe('check-no-direct-db-import', () => {
  it('keeps the direct database import allowlist aligned with current source imports', () => {
    const classification = guard.classifyDirectDatabaseImports();

    expect(classification.staleAllowed).toEqual([]);
    expect(guard.getAllowedDirectDatabaseImportProblems()).toEqual([]);
    expect(guard.getAllowedDirectDatabaseImportFiles()).toEqual([...classification.sourceAllowed].sort());
  });

  it('keeps the remaining allowed direct import list explicit', () => {
    expect(guard.getAllowedDirectDatabaseImportFiles()).toEqual([
      'api-server.js',
      'dashboard/server.js',
      'database.js',
      'db/schema/index.js',
      'index.js',
    ]);
  });

  it('surfaces stale allowlist state through scan and CLI summary output', () => {
    expect(guard.scan().staleAllowed).toEqual([]);

    const serverDir = path.resolve(__dirname, '..');
    const result = spawnSync(process.execPath, ['scripts/check-no-direct-db-import.js', '--summary'], {
      cwd: serverDir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Stale allowed database.js import entries: 0');
  });

  it('classifies missing and no-longer-direct allowlist entries as stale', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'di-import-guard-'));
    try {
      const databaseModule = 'database';
      fs.writeFileSync(path.join(fixtureDir, 'current.js'), `const db = require('./${databaseModule}');\n`);
      fs.writeFileSync(path.join(fixtureDir, 'migrated.js'), "const { defaultContainer } = require('./container');\n");

      expect(guard.getAllowedDirectDatabaseImportProblems(
        ['current.js', 'missing.js', 'migrated.js'],
        fixtureDir,
      )).toEqual([
        { file: 'migrated.js', reason: 'no-direct-database-import' },
        { file: 'missing.js', reason: 'missing' },
      ]);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
