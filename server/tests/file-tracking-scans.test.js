import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('fs');
const childProcess = require('child_process');
const { setupTestDbOnly, teardownTestDb, mkTask } = require('./vitest-setup');
const scans = require('../db/file-tracking-scans');

let dbModule;
let db;
let existsSyncMock;
let readdirSyncMock;
let readFileSyncMock;
let spawnMock;

const TABLES_TO_RESET = [
  'vulnerability_scans',
  'api_contract_results',
  'api_contracts',
  'test_baselines',
  'regression_results',
  'config_baselines',
  'config_drift_results',
  'xaml_validation_results',
  'xaml_validations',
  'xaml_consistency_results',
  'smoke_test_results',
];

function ensureScanTables(dbHandle) {
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS vulnerability_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      package_manager TEXT NOT NULL,
      scan_output TEXT,
      vulnerabilities_found INTEGER DEFAULT 0,
      critical_count INTEGER DEFAULT 0,
      high_count INTEGER DEFAULT 0,
      medium_count INTEGER DEFAULT 0,
      low_count INTEGER DEFAULT 0,
      scanned_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_contract_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      contract_file TEXT NOT NULL,
      validation_type TEXT NOT NULL,
      is_valid INTEGER DEFAULT 1,
      breaking_changes TEXT,
      warnings TEXT,
      validated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      contract_file TEXT NOT NULL,
      payload TEXT,
      validated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      baseline_data TEXT,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS regression_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      test_command TEXT,
      tests_before INTEGER,
      tests_after INTEGER,
      passed_before INTEGER,
      passed_after INTEGER,
      failed_before INTEGER,
      failed_after INTEGER,
      new_failures TEXT,
      detected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config_baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      working_directory TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      content TEXT,
      captured_at TEXT NOT NULL,
      UNIQUE(working_directory, file_path)
    );

    CREATE TABLE IF NOT EXISTS config_drift_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      drift_type TEXT NOT NULL,
      old_hash TEXT,
      new_hash TEXT,
      changes_summary TEXT,
      detected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS xaml_validation_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      severity TEXT DEFAULT 'error',
      line_number INTEGER,
      column_number INTEGER,
      code_snippet TEXT,
      message TEXT NOT NULL,
      suggested_fix TEXT,
      validated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS xaml_validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      payload TEXT,
      validated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS xaml_consistency_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      xaml_file TEXT NOT NULL,
      codebehind_file TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      element_name TEXT,
      severity TEXT DEFAULT 'error',
      message TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS smoke_test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      test_type TEXT NOT NULL,
      working_directory TEXT,
      command TEXT,
      exit_code INTEGER,
      startup_time_ms INTEGER,
      passed INTEGER DEFAULT 0,
      error_output TEXT,
      tested_at TEXT NOT NULL
    );
  `);
}

function resetScanTables(dbHandle) {
  for (const table of TABLES_TO_RESET) {
    dbHandle.prepare(`DELETE FROM ${table}`).run();
  }
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function makeTaskId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function createMockProcess({ stdout = '', stderr = '', closeCode, exitCode, error } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  process.nextTick(() => {
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    if (stderr) {
      proc.stderr.emit('data', Buffer.from(stderr));
    }
    if (error) {
      proc.emit('error', error);
      return;
    }
    if (closeCode !== undefined) {
      proc.emit('close', closeCode);
    }
    if (exitCode !== undefined) {
      proc.emit('exit', exitCode);
    }
  });

  return proc;
}

describe('db/file-tracking-scans', () => {
  beforeAll(() => {
    ({ db: dbModule } = setupTestDbOnly('file-tracking-scans'));
    db = dbModule.getDbInstance();
    ensureScanTables(db);
    scans.setDb(db);
  });

  beforeEach(() => {
    db = dbModule.getDbInstance();
    ensureScanTables(db);
    resetScanTables(db);
    scans.setDb(db);

    existsSyncMock = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    readdirSyncMock = vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    readFileSyncMock = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    spawnMock = vi.spyOn(childProcess, 'spawn');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('setDb wires the module and runVulnerabilityScan stores parsed npm audit results', async () => {
    const taskId = makeTaskId('vuln');
    const workingDirectory = 'C:\\repo\\scan-app';
    const auditPayload = JSON.stringify({
      metadata: {
        vulnerabilities: {
          total: 5,
          critical: 1,
          high: 2,
          moderate: 1,
          low: 1,
        },
      },
    });

    existsSyncMock.mockImplementation((target) => String(target).endsWith('package.json'));
    readdirSyncMock.mockReturnValue([]);
    spawnMock.mockImplementation(() => createMockProcess({ stdout: auditPayload, closeCode: 0 }));

    scans.setDb(db);
    const result = await scans.runVulnerabilityScan(taskId, workingDirectory);

    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      ['audit', '--json'],
      expect.objectContaining({
        cwd: workingDirectory,
        windowsHide: true,
      })
    );
    expect(result).toEqual([
      {
        package_manager: 'npm',
        vulnerabilities: {
          total: 5,
          critical: 1,
          high: 2,
          medium: 1,
          low: 1,
        },
        scanned: true,
      },
    ]);

    const stored = db.prepare(`
      SELECT package_manager, working_directory, vulnerabilities_found, critical_count, high_count, medium_count, low_count, scan_output
      FROM vulnerability_scans
      WHERE task_id = ?
    `).get(taskId);

    expect(stored).toMatchObject({
      package_manager: 'npm',
      working_directory: workingDirectory,
      vulnerabilities_found: 5,
      critical_count: 1,
      high_count: 2,
      medium_count: 1,
      low_count: 1,
      scan_output: auditPayload,
    });
  });

  it('getVulnerabilityScanResults returns rows for the requested task', () => {
    const taskId = makeTaskId('lookup');
    const otherTaskId = makeTaskId('lookup-other');

    db.prepare(`
      INSERT INTO vulnerability_scans (
        task_id, working_directory, package_manager, scan_output, vulnerabilities_found,
        critical_count, high_count, medium_count, low_count, scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, 'C:\\repo\\one', 'npm', '{"ok":true}', 2, 1, 1, 0, 0, new Date().toISOString());

    db.prepare(`
      INSERT INTO vulnerability_scans (
        task_id, working_directory, package_manager, scan_output, vulnerabilities_found,
        critical_count, high_count, medium_count, low_count, scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(otherTaskId, 'C:\\repo\\two', 'pip', '{"ok":false}', 4, 0, 2, 1, 1, new Date().toISOString());

    expect(scans.getVulnerabilityScanResults(taskId)).toEqual([
      expect.objectContaining({
        task_id: taskId,
        working_directory: 'C:\\repo\\one',
        package_manager: 'npm',
        vulnerabilities_found: 2,
      }),
    ]);
  });

  it('captureTestBaseline parses the spawned test output into a baseline summary', async () => {
    const taskId = makeTaskId('baseline');
    const workingDirectory = 'C:\\repo\\tests-app';

    existsSyncMock.mockImplementation((target) => String(target).endsWith('package.json'));
    readdirSyncMock.mockReturnValue([]);
    spawnMock.mockImplementation(() => createMockProcess({
      stdout: '3 tests\n2 passed\n1 failed\n',
      closeCode: 1,
    }));

    const baseline = await scans.captureTestBaseline(taskId, workingDirectory);

    expect(baseline).toEqual({
      captured: true,
      test_command: 'npm test -- --json',
      tests: 3,
      passed: 2,
      failed: 1,
      output: '3 tests\n2 passed\n1 failed\n',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM test_baselines').get().count).toBe(0);
  });

  it('detectRegressions compares baseline to current output and stores the regression result', async () => {
    const taskId = makeTaskId('regression');
    const workingDirectory = 'C:\\repo\\regression-app';
    const baseline = {
      captured: true,
      test_command: 'npm test -- --json',
      tests: 3,
      passed: 3,
      failed: 0,
      output: '3 tests\n3 passed\n',
    };

    existsSyncMock.mockImplementation((target) => String(target).endsWith('package.json'));
    readdirSyncMock.mockReturnValue([]);
    spawnMock.mockImplementation(() => createMockProcess({
      stdout: '3 tests\n2 passed\n1 failed\n',
      closeCode: 1,
    }));

    const result = await scans.detectRegressions(taskId, workingDirectory, baseline);

    expect(result.detected).toBe(true);
    expect(result.new_failures).toBe(1);
    expect(result.current).toMatchObject({
      captured: true,
      tests: 3,
      passed: 2,
      failed: 1,
    });

    expect(scans.getRegressionResults(taskId)).toEqual([
      expect.objectContaining({
        task_id: taskId,
        working_directory: workingDirectory,
        tests_before: 3,
        tests_after: 3,
        passed_before: 3,
        passed_after: 2,
        failed_before: 0,
        failed_after: 1,
      }),
    ]);
    expect(Number(scans.getRegressionResults(taskId)[0].new_failures)).toBe(1);
  });

  it('captureConfigBaselines hashes matching config files and stores them', () => {
    const workingDirectory = 'C:\\repo\\config-app';
    const configFiles = {
      'package.json': '{"name":"config-app"}',
      '.env.local': 'API_KEY=test-key',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    };

    readdirSyncMock.mockReturnValue([
      'package.json',
      '.env.local',
      'tsconfig.json',
      'notes.md',
    ]);
    readFileSyncMock.mockImplementation((target) => {
      const fileName = String(target).split(/[/\\]/).pop();
      if (!configFiles[fileName]) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return configFiles[fileName];
    });

    const result = scans.captureConfigBaselines(workingDirectory);

    expect(result.count).toBe(3);
    expect(result.captured).toEqual(
      expect.arrayContaining([
        { file: 'package.json', hash: hashContent(configFiles['package.json']) },
        { file: '.env.local', hash: hashContent(configFiles['.env.local']) },
        { file: 'tsconfig.json', hash: hashContent(configFiles['tsconfig.json']) },
      ])
    );

    const stored = db.prepare(`
      SELECT file_path, file_hash, content
      FROM config_baselines
      WHERE working_directory = ?
      ORDER BY file_path
    `).all(workingDirectory);

    expect(stored).toEqual([
      {
        file_path: '.env.local',
        file_hash: hashContent(configFiles['.env.local']),
        content: configFiles['.env.local'],
      },
      {
        file_path: 'package.json',
        file_hash: hashContent(configFiles['package.json']),
        content: configFiles['package.json'],
      },
      {
        file_path: 'tsconfig.json',
        file_hash: hashContent(configFiles['tsconfig.json']),
        content: configFiles['tsconfig.json'],
      },
    ]);
  });

  it('detectConfigDrift records drift when a tracked config file changes', () => {
    const taskId = makeTaskId('drift');
    const workingDirectory = 'C:\\repo\\drift-app';
    const originalConfig = '{"name":"drift-app"}';
    const updatedConfig = '{"name":"drift-app","private":true}';

    readdirSyncMock.mockReturnValue(['package.json']);
    readFileSyncMock.mockImplementation((target) => {
      const fileName = String(target).split(/[/\\]/).pop();
      if (fileName === 'package.json') {
        return originalConfig;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    scans.captureConfigBaselines(workingDirectory);

    readFileSyncMock.mockImplementation((target) => {
      const fileName = String(target).split(/[/\\]/).pop();
      if (fileName === 'package.json') {
        return updatedConfig;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = scans.detectConfigDrift(taskId, workingDirectory);

    expect(result).toEqual({
      drifts: [
        {
          file: 'package.json',
          drift_type: 'expanded',
          old_hash: hashContent(originalConfig).slice(0, 8),
          new_hash: hashContent(updatedConfig).slice(0, 8),
        },
      ],
      count: 1,
    });
    expect(scans.getConfigDriftResults(taskId)).toEqual([
      expect.objectContaining({
        task_id: taskId,
        file_path: 'package.json',
        drift_type: 'expanded',
        old_hash: hashContent(originalConfig),
        new_hash: hashContent(updatedConfig),
      }),
    ]);
  });

  it('runAppSmokeTest stores both passing and failing runs based on spawned exit codes', async () => {
    const successTaskId = makeTaskId('smoke-pass');
    const failureTaskId = makeTaskId('smoke-fail');
    const workingDirectory = 'C:\\repo\\smoke-app';

    mkTask(dbModule, { id: successTaskId, working_directory: workingDirectory });
    mkTask(dbModule, { id: failureTaskId, working_directory: workingDirectory });

    spawnMock
      .mockImplementationOnce(() => createMockProcess({ exitCode: 0 }))
      .mockImplementationOnce(() => createMockProcess({ stderr: 'startup failed', exitCode: 1 }));

    const success = await scans.runAppSmokeTest(successTaskId, workingDirectory, { timeoutMs: 25 });
    const failure = await scans.runAppSmokeTest(failureTaskId, workingDirectory, { timeoutMs: 25 });

    expect(success).toMatchObject({
      task_id: successTaskId,
      working_directory: workingDirectory,
      passed: true,
      exit_code: 0,
      status: 'passed',
    });
    expect(failure).toMatchObject({
      task_id: failureTaskId,
      working_directory: workingDirectory,
      passed: false,
      exit_code: 1,
      error_output: 'startup failed',
      status: 'failed',
    });

    expect(scans.getSmokeTestResults(successTaskId)).toEqual([
      expect.objectContaining({
        task_id: successTaskId,
        test_type: 'app_startup',
        passed: 1,
        exit_code: 0,
      }),
    ]);
    expect(scans.getSmokeTestResults(failureTaskId)).toEqual([
      expect.objectContaining({
        task_id: failureTaskId,
        test_type: 'app_startup',
        passed: 0,
        exit_code: 1,
        error_output: 'startup failed',
      }),
    ]);
  });
});
