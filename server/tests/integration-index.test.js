const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const { setupTestDb, teardownTestDb, getText } = require('./vitest-setup');
const providerRoutingCore = require('../db/provider-routing-core');
const taskManager = require('../task-manager');
const { gitSync, cleanupRepo } = require('./git-test-utils');
const {
  handleExportReportJSON,
  handleIntegrationHealth,
  handleTestIntegration,
  handleTaskChanges,
  handleRollbackFile,
  handleStashChanges,
  handleSubmitChunkedReview,
} = require('../handlers/integration');

function parseJsonCodeBlock(text) {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  return match ? JSON.parse(match[1]) : null;
}

describe('integration/index handlers', () => {
  let db;
  let tempDir;
  let repoDir;

  beforeEach(() => {
    ({ db } = setupTestDb(`integration-index-${Date.now()}`));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-integration-index-'));
    repoDir = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (repoDir) {
      cleanupRepo(repoDir);
      repoDir = null;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    teardownTestDb();
  });

  function rawDb() {
    return db.getDbInstance();
  }

  function createTask(overrides = {}) {
    const id = overrides.id || randomUUID();
    const workingDirectory = overrides.working_directory || tempDir;

    db.createTask({
      id,
      task_description: overrides.task_description || 'integration index test task',
      working_directory: workingDirectory,
      status: overrides.status || 'completed',
      provider: overrides.provider || 'ollama',
      model: overrides.model || 'test-model',
      priority: overrides.priority || 0,
      project: overrides.project || null,
      metadata: overrides.metadata || null,
    });

    const updates = [];
    const values = [];
    for (const field of ['git_before_sha', 'git_after_sha', 'git_stash_ref']) {
      if (Object.prototype.hasOwnProperty.call(overrides, field)) {
        updates.push(`${field} = ?`);
        values.push(overrides[field]);
      }
    }

    if (updates.length > 0) {
      values.push(id);
      rawDb().prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    return db.getTask(id);
  }

  function initRepo(name = 'repo') {
    repoDir = path.join(tempDir, name);
    fs.mkdirSync(repoDir, { recursive: true });
    gitSync(['init'], { cwd: repoDir });
    gitSync(['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    gitSync(['config', 'user.name', 'Test'], { cwd: repoDir });
    return repoDir;
  }

  function writeRepoFile(relativePath, content) {
    const filePath = path.join(repoDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  function commitAll(message) {
    gitSync(['add', '--all'], { cwd: repoDir });
    gitSync(['commit', '-m', message, '--no-gpg-sign'], { cwd: repoDir });
  }

  it('handleExportReportJSON records the export and returns task JSON with the expected schema', () => {
    createTask({
      task_description: 'export row 1',
      project: 'export-project',
      working_directory: tempDir,
      status: 'completed',
    });
    createTask({
      task_description: 'export row 2',
      project: 'export-project',
      working_directory: tempDir,
      status: 'failed',
    });

    const result = handleExportReportJSON({ project: 'export-project', limit: 10 });
    const text = getText(result);
    const payload = parseJsonCodeBlock(text);
    const exportRow = rawDb().prepare('SELECT * FROM report_exports ORDER BY created_at DESC LIMIT 1').get();

    expect(text).toContain('JSON Export');
    expect(exportRow).toEqual(expect.objectContaining({
      report_type: 'tasks',
      format: 'json',
      status: 'completed',
      row_count: 2,
    }));
    expect(typeof exportRow.file_size_bytes).toBe('number');
    expect(exportRow.file_size_bytes).toBeGreaterThan(0);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      status: expect.any(String),
      task_description: expect.any(String),
      working_directory: expect.any(String),
    }));
  });

  it('handleIntegrationHealth returns the expected structured summary shape', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'slack-config',
      integration_type: 'slack',
      config: { webhook_url: 'https://hooks.slack.com/services/T000/B000/X000' },
      enabled: true,
    });

    const result = await handleIntegrationHealth({ integration_type: 'slack' });
    const historyRow = rawDb().prepare('SELECT * FROM integration_health ORDER BY checked_at DESC LIMIT 1').get();

    expect(result.structuredData).toEqual({
      count: 1,
      integrations: [
        expect.objectContaining({
          name: 'slack',
          status: 'reachable',
          latency_ms: expect.any(Number),
        }),
      ],
    });
    expect(historyRow).toEqual(expect.objectContaining({
      integration_type: 'slack',
      status: 'reachable',
    }));
  });

  it('handleTestIntegration posts to the configured webhook and records the test result', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'slack-config',
      integration_type: 'slack',
      config: { webhook_url: 'https://hooks.slack.com/services/T111/B111/X111' },
      enabled: true,
    });

    const https = require('https');
    let requestBody = '';

    vi.spyOn(https, 'request').mockImplementation((options, callback) => {
      const response = new EventEmitter();
      response.statusCode = 200;

      const request = new EventEmitter();
      request.write = vi.fn((chunk) => {
        requestBody += chunk;
      });
      request.end = vi.fn(() => {
        callback(response);
        response.emit('data', 'ok');
        response.emit('end');
      });

      expect(options).toEqual(expect.objectContaining({
        hostname: 'hooks.slack.com',
        method: 'POST',
        path: '/services/T111/B111/X111',
      }));

      return request;
    });

    const result = await handleTestIntegration({
      integration_type: 'slack',
      message: 'Ping from test',
    });
    const testRow = rawDb().prepare('SELECT * FROM integration_tests ORDER BY tested_at DESC LIMIT 1').get();

    expect(getText(result)).toContain('Success');
    expect(JSON.parse(requestBody)).toEqual({
      text: '\uD83E\uDDEA Test: Ping from test',
    });
    expect(testRow).toEqual(expect.objectContaining({
      integration_type: 'slack',
      status: 'success',
      response_data: 'ok',
    }));
  });

  it('handleTaskChanges shows the tracked diff between the before/after git SHAs', () => {
    initRepo('task-changes-repo');
    writeRepoFile('notes.txt', 'base\n');
    commitAll('initial commit');

    const beforeSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });
    writeRepoFile('notes.txt', 'base\nstaged change\n');
    commitAll('task diff change');
    const afterSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });

    const task = createTask({
      task_description: 'task changes repo',
      working_directory: repoDir,
      git_before_sha: beforeSha,
      git_after_sha: afterSha,
    });

    const result = handleTaskChanges({ task_id: task.id });
    const text = getText(result);

    expect(text).toContain('Task Changes');
    expect(text).toContain('notes.txt');
    expect(text).toMatch(/M\s+notes\.txt/);
  });

  it('handleRollbackFile restores the previous file contents in a temp repo', () => {
    initRepo('rollback-repo');
    const filePath = writeRepoFile('tracked.txt', 'original\n');
    commitAll('add tracked file');
    const beforeSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });

    fs.writeFileSync(filePath, 'modified\n', 'utf8');

    const task = createTask({
      task_description: 'rollback repo',
      working_directory: repoDir,
      git_before_sha: beforeSha,
    });

    const result = handleRollbackFile({
      task_id: task.id,
      file_path: 'tracked.txt',
    });
    const changeRow = rawDb().prepare(
      "SELECT * FROM task_file_changes WHERE task_id = ? AND change_type = 'rollback' ORDER BY created_at DESC LIMIT 1"
    ).get(task.id);

    expect(result.isError).not.toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('original\n');
    expect(changeRow).toEqual(expect.objectContaining({
      task_id: task.id,
      file_path: 'tracked.txt',
      change_type: 'rollback',
    }));
  });

  it('handleStashChanges stashes modified repo contents and leaves a clean worktree', () => {
    initRepo('stash-repo');
    const filePath = writeRepoFile('tracked.txt', 'base\n');
    commitAll('seed repo');

    fs.writeFileSync(filePath, 'changed\n', 'utf8');

    const task = createTask({
      task_description: 'stash repo',
      working_directory: repoDir,
    });

    const result = handleStashChanges({
      task_id: task.id,
      message: 'stash test changes',
    });
    const status = gitSync(['status', '--porcelain'], { cwd: repoDir });
    const stashList = gitSync(['stash', 'list', '-n', '1'], { cwd: repoDir });
    const changeRow = rawDb().prepare(
      "SELECT * FROM task_file_changes WHERE task_id = ? AND change_type = 'stash' ORDER BY created_at DESC LIMIT 1"
    ).get(task.id);

    expect(result.isError).not.toBe(true);
    expect(status).toBe('');
    expect(stashList).toContain('stash test changes');
    expect(changeRow).toEqual(expect.objectContaining({
      task_id: task.id,
      file_path: '*',
      change_type: 'stash',
    }));
    expect(changeRow.stash_ref).toContain('stash@{0}');
  });

  it('handleSubmitChunkedReview creates chunk tasks and an aggregation task in the test DB', async () => {
    const reviewFile = path.join(tempDir, 'large-file.js');
    const reviewContent = Array.from(
      { length: 220 },
      (_, index) => `const value${index} = "${'x'.repeat(40)}";`
    ).join('\n');
    fs.writeFileSync(reviewFile, reviewContent, 'utf8');

    vi.spyOn(providerRoutingCore, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'codex',
      model: 'unit-route-model',
    });
    const processQueueSpy = vi.spyOn(taskManager, 'processQueue').mockImplementation(() => {});

    const result = await handleSubmitChunkedReview({
      file_path: reviewFile,
      review_type: 'code_review',
      token_limit: 200,
      priority: 7,
    });

    const createdTasks = rawDb().prepare('SELECT id, status, priority, model, metadata FROM tasks ORDER BY created_at ASC').all();
    const parsedTasks = createdTasks.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
    const chunkTasks = parsedTasks.filter((row) => row.metadata && row.metadata.chunked_review && !row.metadata.is_aggregation);
    const aggregationTask = parsedTasks.find((row) => row.metadata && row.metadata.is_aggregation);

    expect(getText(result)).toContain('Chunked Review Submitted');
    expect(processQueueSpy).toHaveBeenCalledTimes(1);
    expect(chunkTasks.length).toBeGreaterThan(1);
    expect(chunkTasks.every((row) => row.status === 'queued')).toBe(true);
    expect(chunkTasks.every((row) => row.priority === 7)).toBe(true);
    expect(chunkTasks.every((row) => row.model === 'unit-route-model')).toBe(true);
    expect(chunkTasks[0].metadata).toEqual(expect.objectContaining({
      intended_provider: 'codex',
      chunked_review: true,
      file_path: reviewFile,
      review_type: 'code_review',
      chunk_number: 1,
      total_chunks: chunkTasks.length,
    }));
    expect(aggregationTask).toBeDefined();
    expect(aggregationTask.status).toBe('pending');
    expect(aggregationTask.metadata).toEqual(expect.objectContaining({
      intended_provider: 'ollama',
      chunked_review: true,
      is_aggregation: true,
      awaiting_chunks: true,
      file_path: reviewFile,
      review_type: 'code_review',
    }));
    expect(aggregationTask.metadata.chunk_task_ids.slice().sort()).toEqual(
      chunkTasks.map((row) => row.id).slice().sort()
    );
  });
});
