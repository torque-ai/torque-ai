'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const fileBaselines = require('../db/file/baselines');
const {
  handleCheckDuplicateFiles,
  handleSearchSimilarFiles,
} = require('../handlers/validation/file');
const {
  setupTestDbOnly,
  teardownTestDb,
  resetTables,
  getText,
  mkTask,
} = require('./vitest-setup');

let db;
let testDir;

function createTask(overrides = {}) {
  const workingDirectory = overrides.working_directory || path.join(testDir, `task-${randomUUID()}`);
  fs.mkdirSync(workingDirectory, { recursive: true });
  const result = mkTask(db, {
    ...overrides,
    working_directory: workingDirectory,
  });
  if (result && typeof result === 'object' && result.id) return result;
  return db.getTask(result);
}

beforeAll(() => {
  ({ db, testDir } = setupTestDbOnly('file-baselines-boundary'));
});

beforeEach(() => {
  resetTables([
    'expected_output_paths',
    'task_file_changes',
    'file_location_anomalies',
    'duplicate_file_detections',
    'similar_file_search',
    'tasks',
  ]);
});

afterAll(() => {
  teardownTestDb();
});

describe('file baseline workspace boundaries', () => {
  it('rejects duplicate-file scans outside the task root', async () => {
    const task = createTask();
    const outsideDir = path.join(path.dirname(task.working_directory), `outside-duplicates-${randomUUID()}`);
    fs.mkdirSync(outsideDir, { recursive: true });

    const result = await handleCheckDuplicateFiles({
      task_id: task.id,
      working_directory: outsideDir,
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('PATH_TRAVERSAL');
    expect(getText(result)).toContain('working_directory is outside task workspace root');
  });

  it('rejects similar-file searches outside the task root', async () => {
    const task = createTask();
    const outsideDir = path.join(path.dirname(task.working_directory), `outside-search-${randomUUID()}`);
    fs.mkdirSync(outsideDir, { recursive: true });

    const result = await handleSearchSimilarFiles({
      task_id: task.id,
      search_term: 'Widget',
      working_directory: outsideDir,
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('PATH_TRAVERSAL');
    expect(getText(result)).toContain('working_directory is outside task workspace root');
  });

  it('flags sibling-prefix paths as unexpected locations', () => {
    const task = createTask();
    const workDir = path.join(testDir, `workspace-${randomUUID()}`);
    const expectedDir = path.join(workDir, 'out');
    const siblingFile = path.join(workDir, 'outside', 'x.js');
    fs.mkdirSync(path.dirname(siblingFile), { recursive: true });

    fileBaselines.setExpectedOutputPath(task.id, expectedDir, { allowSubdirs: true });
    fileBaselines.recordFileChange(task.id, siblingFile, 'created', {
      workingDirectory: workDir,
    });

    const anomalies = fileBaselines.checkFileLocationAnomalies(task.id, workDir);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].anomaly_type).toBe('unexpected_location');
    expect(anomalies[0].file_path).toBe(siblingFile);
  });
});
