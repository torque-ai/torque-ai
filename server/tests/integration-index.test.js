const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const { setupTestDbOnly, teardownTestDb, getText } = require('./vitest-setup');
const providerRoutingCore = require('../db/provider/routing-core');
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
    ({ db } = setupTestDbOnly(`integration-index-${Date.now()}`));
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
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    repoDir = path.join(tempDir, `${name}-${suffix}`);
    fs.mkdirSync(repoDir, { recursive: true });
    gitSync(['init'], { cwd: repoDir });
    gitSync(['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    gitSync(['config', 'user.name', 'Test'], { cwd: repoDir });
    gitSync(['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
    gitSync(['config', 'core.autocrlf', 'false'], { cwd: repoDir });
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
    gitSync(['commit', '-m', message, '--no-gpg-sign', '--allow-empty-message'], { cwd: repoDir });
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

  it('handleExportReportJSON with empty dataset returns zero-row structure without crashing', () => {
    const result = handleExportReportJSON({ project: 'nonexistent-project', limit: 10 });
    const text = getText(result);
    const exportRow = rawDb().prepare('SELECT * FROM report_exports ORDER BY created_at DESC LIMIT 1').get();

    expect(result.isError).not.toBe(true);
    expect(text).toContain('JSON Export');
    expect(text).toContain('**Rows:** 0');
    expect(text).toContain('**Size:**');
    expect(exportRow).toEqual(expect.objectContaining({
      report_type: 'tasks',
      format: 'json',
      status: 'completed',
      row_count: 0,
    }));
  });

  it('handleExportReportJSON with <=3 tasks returns full JSON in data block', () => {
    createTask({
      task_description: 'single-export task',
      project: 'small-project',
      working_directory: tempDir,
      status: 'completed',
    });

    const result = handleExportReportJSON({ project: 'small-project', limit: 10 });
    const text = getText(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain('**Rows:** 1');
    // With <=3 rows, the handler uses the "### Data" heading with full JSON
    expect(text).toContain('### Data');
    expect(text).toContain('single-export task');
  });

  it('handleExportReportJSON with >3 tasks shows preview of first 3 records', () => {
    for (let i = 0; i < 5; i++) {
      createTask({
        task_description: `batch-task-${i}`,
        project: 'batch-project',
        working_directory: tempDir,
        status: 'completed',
      });
    }

    const result = handleExportReportJSON({ project: 'batch-project', limit: 10 });
    const text = getText(result);
    const payload = parseJsonCodeBlock(text);

    expect(result.isError).not.toBe(true);
    expect(text).toContain('**Rows:** 5');
    expect(text).toContain('Preview (first 3 records)');
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(3);
    expect(text).toContain('and 2 more records');
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

  it('handleIntegrationHealth with no configured integrations returns informative empty message', async () => {
    const result = await handleIntegrationHealth({ integration_type: 'slack' });
    const text = getText(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Integration Health');
    expect(text).toContain('No slack integrations configured or enabled');
    expect(result.structuredData).toBeUndefined();
  });

  it('handleIntegrationHealth with invalid webhook URL reports error status', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'bad-slack-config',
      integration_type: 'slack',
      config: { webhook_url: 'not-a-valid-url' },
      enabled: true,
    });

    const result = await handleIntegrationHealth({ integration_type: 'slack' });
    const historyRow = rawDb().prepare('SELECT * FROM integration_health ORDER BY checked_at DESC LIMIT 1').get();

    expect(result.structuredData).toEqual({
      count: 1,
      integrations: [
        expect.objectContaining({
          name: 'slack',
          status: 'error',
          latency_ms: null,
        }),
      ],
    });
    expect(historyRow).toEqual(expect.objectContaining({
      integration_type: 'slack',
      status: 'error',
    }));
    expect(getText(result)).toContain('✗ error');
  });

  it('handleIntegrationHealth without webhook_url reports configured status with zero latency', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'no-webhook-config',
      integration_type: 'discord',
      config: { channel_id: '12345' },
      enabled: true,
    });

    const result = await handleIntegrationHealth({ integration_type: 'discord' });
    const historyRow = rawDb().prepare('SELECT * FROM integration_health ORDER BY checked_at DESC LIMIT 1').get();

    expect(result.structuredData).toEqual({
      count: 1,
      integrations: [
        expect.objectContaining({
          name: 'discord',
          status: 'configured',
          latency_ms: 0,
        }),
      ],
    });
    expect(historyRow).toEqual(expect.objectContaining({
      integration_type: 'discord',
      status: 'configured',
      latency_ms: 0,
    }));
    expect(getText(result)).toContain('✓ configured');
  });

  it('handleIntegrationHealth with include_history returns recent health check records', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'slack-hist-config',
      integration_type: 'slack',
      config: { webhook_url: 'https://hooks.slack.com/services/T999/B999/X999' },
      enabled: true,
    });

    // Run health check once to seed history
    await handleIntegrationHealth({ integration_type: 'slack' });

    // Run again with include_history
    const result = await handleIntegrationHealth({ integration_type: 'slack', include_history: true });
    const text = getText(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Recent Health Checks');
    expect(text).toContain('slack');
    expect(text).toContain('reachable');
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

  it('handleTestIntegration reports failure with ETIMEDOUT on network timeout', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'slack-timeout-config',
      integration_type: 'slack',
      config: { webhook_url: 'https://hooks.slack.com/services/T222/B222/X222' },
      enabled: true,
    });

    const https = require('https');
    vi.spyOn(https, 'request').mockImplementation((_options, _callback) => {
      const request = new EventEmitter();
      request.write = vi.fn();
      request.end = vi.fn(() => {
        const err = new Error('connect ETIMEDOUT 1.2.3.4:443');
        err.code = 'ETIMEDOUT';
        request.emit('error', err);
      });
      return request;
    });

    const result = await handleTestIntegration({
      integration_type: 'slack',
      message: 'timeout test',
    });
    const text = getText(result);
    const testRow = rawDb().prepare('SELECT * FROM integration_tests ORDER BY tested_at DESC LIMIT 1').get();

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Integration Test: slack');
    expect(text).toContain('✗ Failed');
    expect(text).toContain('ETIMEDOUT');
    expect(testRow).toEqual(expect.objectContaining({
      integration_type: 'slack',
      status: 'failed',
      test_message: 'timeout test',
    }));
    expect(testRow.error).toContain('ETIMEDOUT');
    expect(testRow.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('handleTestIntegration reports failure with ECONNREFUSED on connection refused', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'slack-connrefused-config',
      integration_type: 'slack',
      config: { webhook_url: 'https://hooks.slack.com/services/T333/B333/X333' },
      enabled: true,
    });

    const https = require('https');
    vi.spyOn(https, 'request').mockImplementation((_options, _callback) => {
      const request = new EventEmitter();
      request.write = vi.fn();
      request.end = vi.fn(() => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
        err.code = 'ECONNREFUSED';
        request.emit('error', err);
      });
      return request;
    });

    const result = await handleTestIntegration({
      integration_type: 'slack',
      message: 'connrefused test',
    });
    const text = getText(result);
    const testRow = rawDb().prepare('SELECT * FROM integration_tests ORDER BY tested_at DESC LIMIT 1').get();

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Integration Test: slack');
    expect(text).toContain('✗ Failed');
    expect(text).toContain('ECONNREFUSED');
    expect(testRow).toEqual(expect.objectContaining({
      integration_type: 'slack',
      status: 'failed',
      test_message: 'connrefused test',
    }));
    expect(testRow.error).toContain('ECONNREFUSED');
  });

  it('handleTestIntegration with invalid integration_type returns validation error', async () => {
    const result = await handleTestIntegration({
      integration_type: 'github',
      message: 'bad type test',
    });
    const text = getText(result);

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(text).toContain('integration_type');
    expect(text).toContain('slack');
    expect(text).toContain('discord');
  });

  it('handleTestIntegration with missing webhook_url returns missing param error', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'discord-no-webhook',
      integration_type: 'discord',
      config: { channel_id: '99999' },
      enabled: true,
    });

    const result = await handleTestIntegration({
      integration_type: 'discord',
      message: 'no webhook test',
    });
    const text = getText(result);

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(text).toContain('discord');
    expect(text).toContain('webhook_url');
  });

  it('handleTestIntegration records discord payload format with content field', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'discord-config',
      integration_type: 'discord',
      config: { webhook_url: 'https://discord.com/api/webhooks/123/abc' },
      enabled: true,
    });

    const https = require('https');
    let requestBody = '';

    vi.spyOn(https, 'request').mockImplementation((options, callback) => {
      const response = new EventEmitter();
      response.statusCode = 204;

      const request = new EventEmitter();
      request.write = vi.fn((chunk) => {
        requestBody += chunk;
      });
      request.end = vi.fn(() => {
        callback(response);
        response.emit('data', '');
        response.emit('end');
      });

      expect(options).toEqual(expect.objectContaining({
        hostname: 'discord.com',
        method: 'POST',
        path: '/api/webhooks/123/abc',
      }));

      return request;
    });

    const result = await handleTestIntegration({
      integration_type: 'discord',
      message: 'Discord ping',
    });
    const text = getText(result);
    const testRow = rawDb().prepare('SELECT * FROM integration_tests ORDER BY tested_at DESC LIMIT 1').get();

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Integration Test: discord');
    expect(text).toContain('✓ Success');
    expect(JSON.parse(requestBody)).toEqual({
      content: '\uD83E\uDDEA Test: Discord ping',
    });
    expect(testRow).toEqual(expect.objectContaining({
      integration_type: 'discord',
      status: 'success',
    }));
  });

  it('handleTestIntegration with non-2xx HTTP response records failure with status code', async () => {
    providerRoutingCore.saveIntegrationConfig({
      id: 'slack-http-err-config',
      integration_type: 'slack',
      config: { webhook_url: 'https://hooks.slack.com/services/T444/B444/X444' },
      enabled: true,
    });

    const https = require('https');
    vi.spyOn(https, 'request').mockImplementation((_options, callback) => {
      const response = new EventEmitter();
      response.statusCode = 403;

      const request = new EventEmitter();
      request.write = vi.fn();
      request.end = vi.fn(() => {
        callback(response);
        response.emit('data', 'invalid_token');
        response.emit('end');
      });

      return request;
    });

    const result = await handleTestIntegration({
      integration_type: 'slack',
      message: 'http error test',
    });
    const text = getText(result);
    const testRow = rawDb().prepare('SELECT * FROM integration_tests ORDER BY tested_at DESC LIMIT 1').get();

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Integration Test: slack');
    expect(text).toContain('✗ Failed');
    expect(text).toContain('HTTP 403');
    expect(text).toContain('invalid_token');
    expect(testRow).toEqual(expect.objectContaining({
      integration_type: 'slack',
      status: 'failed',
      test_message: 'http error test',
    }));
    expect(testRow.error).toContain('HTTP 403');
    expect(testRow.error).toContain('invalid_token');
  });

  it('handleTestIntegration with unconfigured integration returns not-found error', async () => {
    const result = await handleTestIntegration({
      integration_type: 'slack',
      message: 'no integration configured',
    });
    const text = getText(result);

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
    expect(text).toContain('slack');
    expect(text).toContain('not configured or not enabled');
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

  // ============ handleTaskChanges error/edge-case tests ============

  it('handleTaskChanges returns TASK_NOT_FOUND when the task ID does not exist in DB', () => {
    const result = handleTaskChanges({ task_id: 'nonexistent-task-id-000' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TASK_NOT_FOUND');
    expect(getText(result)).toContain('Task not found');
    expect(getText(result)).toContain('nonexistent-task-id-000');
  });

  it('handleTaskChanges returns INVALID_PARAM when task_id is empty or missing', () => {
    const resultEmpty = handleTaskChanges({ task_id: '' });
    expect(resultEmpty.isError).toBe(true);
    expect(resultEmpty.error_code).toBe('INVALID_PARAM');
    expect(getText(resultEmpty)).toContain('task_id is required');

    const resultMissing = handleTaskChanges({});
    expect(resultMissing.isError).toBe(true);
    expect(resultMissing.error_code).toBe('INVALID_PARAM');
  });

  it('handleTaskChanges returns RESOURCE_NOT_FOUND when task has no git tracking data', () => {
    const task = createTask({
      task_description: 'no git data task',
      working_directory: tempDir,
      // no git_before_sha or git_after_sha
    });

    const result = handleTaskChanges({ task_id: task.id });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
    expect(getText(result)).toContain('No git tracking data');
  });

  it('handleTaskChanges with format=full passes the correct diff args', () => {
    initRepo('task-changes-full-repo');
    writeRepoFile('file.txt', 'line1\n');
    commitAll('initial');
    const beforeSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });
    writeRepoFile('file.txt', 'line1\nline2\n');
    commitAll('add line2');
    const afterSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });

    const task = createTask({
      task_description: 'full format task',
      working_directory: repoDir,
      git_before_sha: beforeSha,
      git_after_sha: afterSha,
    });

    const result = handleTaskChanges({ task_id: task.id, format: 'full' });
    const text = getText(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Task Changes (full)');
    // Full diff shows actual content changes with +/- lines
    expect(text).toContain('+line2');
  });

  it('handleTaskChanges with format=stat shows file stats', () => {
    initRepo('task-changes-stat-repo');
    writeRepoFile('data.txt', 'original\n');
    commitAll('initial');
    const beforeSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });
    writeRepoFile('data.txt', 'modified content\n');
    commitAll('modify data');
    const afterSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });

    const task = createTask({
      task_description: 'stat format task',
      working_directory: repoDir,
      git_before_sha: beforeSha,
      git_after_sha: afterSha,
    });

    const result = handleTaskChanges({ task_id: task.id, format: 'stat' });
    const text = getText(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Task Changes (stat)');
    expect(text).toContain('data.txt');
    // Stat format shows insertions/deletions
    expect(text).toMatch(/\d+ insertion|\d+ deletion|\d+ file/);
  });

  // ============ handleRollbackFile error/edge-case tests ============

  it('handleRollbackFile returns TASK_NOT_FOUND when the task ID does not exist', () => {
    const result = handleRollbackFile({ task_id: 'missing-task-id-123', file_path: 'some.txt' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TASK_NOT_FOUND');
    expect(getText(result)).toContain('Task not found');
  });

  it('handleRollbackFile returns INVALID_PARAM when task_id is empty', () => {
    const result = handleRollbackFile({ task_id: '', file_path: 'some.txt' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result)).toContain('task_id is required');
  });

  it('handleRollbackFile returns RESOURCE_NOT_FOUND when task has no git_before_sha', () => {
    const task = createTask({
      task_description: 'no baseline task',
      working_directory: tempDir,
      // no git_before_sha set
    });

    const result = handleRollbackFile({ task_id: task.id, file_path: 'any-file.txt' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
    expect(getText(result)).toContain('No git tracking data available for rollback');
  });

  it('handleRollbackFile returns MISSING_REQUIRED_PARAM when file_path is missing', () => {
    initRepo('rollback-no-filepath');
    writeRepoFile('dummy.txt', 'content\n');
    commitAll('initial');
    const beforeSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });

    const task = createTask({
      task_description: 'rollback no filepath',
      working_directory: repoDir,
      git_before_sha: beforeSha,
    });

    const result = handleRollbackFile({ task_id: task.id });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(getText(result)).toContain('file_path is required');
  });

  it('handleRollbackFile returns PATH_TRAVERSAL error for unsafe path', () => {
    initRepo('rollback-traversal');
    writeRepoFile('safe.txt', 'content\n');
    commitAll('initial');
    const beforeSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });

    const task = createTask({
      task_description: 'rollback traversal test',
      working_directory: repoDir,
      git_before_sha: beforeSha,
    });

    const result = handleRollbackFile({ task_id: task.id, file_path: '../../etc/passwd' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('PATH_TRAVERSAL');
    expect(getText(result)).toContain('path traversal not allowed');
  });

  it('handleRollbackFile returns OPERATION_FAILED when git checkout fails for nonexistent file in history', () => {
    initRepo('rollback-bad-file');
    writeRepoFile('exists.txt', 'content\n');
    commitAll('initial');
    const beforeSha = gitSync(['rev-parse', 'HEAD'], { cwd: repoDir });

    const task = createTask({
      task_description: 'rollback nonexistent file',
      working_directory: repoDir,
      git_before_sha: beforeSha,
    });

    // File 'never-existed.txt' was not in the commit, so git checkout will fail
    const result = handleRollbackFile({ task_id: task.id, file_path: 'never-existed.txt' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('OPERATION_FAILED');
    expect(getText(result)).toContain('Rollback failed');
  });

  // ============ handleStashChanges error/edge-case tests ============

  it('handleStashChanges returns TASK_NOT_FOUND when task_id references a nonexistent task', () => {
    const result = handleStashChanges({ task_id: 'nonexistent-stash-task-999' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TASK_NOT_FOUND');
    expect(getText(result)).toContain('Task not found');
  });

  it('handleStashChanges returns OPERATION_FAILED when there are no changes to stash', () => {
    initRepo('stash-empty-repo');
    writeRepoFile('clean.txt', 'initial\n');
    commitAll('seed clean repo');

    // No modifications — working tree is clean
    const task = createTask({
      task_description: 'stash empty tree',
      working_directory: repoDir,
    });

    const result = handleStashChanges({ task_id: task.id });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('OPERATION_FAILED');
    expect(getText(result)).toContain('Stash failed');
  });

  it('handleStashChanges without task_id uses working_directory arg', () => {
    initRepo('stash-no-task-repo');
    const filePath = writeRepoFile('file.txt', 'base\n');
    commitAll('seed');

    fs.writeFileSync(filePath, 'modified content\n', 'utf8');

    const result = handleStashChanges({ working_directory: repoDir, message: 'no-task stash' });
    const status = gitSync(['status', '--porcelain'], { cwd: repoDir });
    const stashList = gitSync(['stash', 'list', '-n', '1'], { cwd: repoDir });

    expect(result.isError).not.toBe(true);
    expect(status).toBe('');
    expect(stashList).toContain('no-task stash');
    expect(getText(result)).toContain('Changes stashed successfully');
  });

  it('handleStashChanges with custom message includes it in the stash entry', () => {
    initRepo('stash-msg-repo');
    const filePath = writeRepoFile('msg.txt', 'original\n');
    commitAll('seed');

    fs.writeFileSync(filePath, 'edited\n', 'utf8');

    const task = createTask({
      task_description: 'stash message test',
      working_directory: repoDir,
    });

    const result = handleStashChanges({ task_id: task.id, message: 'custom-stash-message-xyz' });
    const stashList = gitSync(['stash', 'list', '-n', '1'], { cwd: repoDir });

    expect(result.isError).not.toBe(true);
    expect(stashList).toContain('custom-stash-message-xyz');
    expect(getText(result)).toContain('Changes stashed successfully');
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

  // ============ handleSubmitChunkedReview additional behavior tests ============

  it('handleSubmitChunkedReview with a small file creates a single review task without chunking', async () => {
    const reviewFile = path.join(tempDir, 'small-file.js');
    // Small file: 5 lines, well within any token limit
    const reviewContent = [
      'function hello() {',
      '  return "world";',
      '}',
      '',
      'module.exports = { hello };',
    ].join('\n');
    fs.writeFileSync(reviewFile, reviewContent, 'utf8');

    vi.spyOn(providerRoutingCore, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'codex',
      model: 'single-review-model',
    });
    const processQueueSpy = vi.spyOn(taskManager, 'processQueue').mockImplementation(() => {});

    const result = await handleSubmitChunkedReview({
      file_path: reviewFile,
      review_type: 'code_review',
      // default token_limit (32000) is far above this file's size
    });
    const text = getText(result);

    const createdTasks = rawDb().prepare('SELECT id, status, priority, model, metadata FROM tasks ORDER BY created_at ASC').all();
    const parsedTasks = createdTasks.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Single Review Task Submitted');
    expect(text).toContain('small enough for single review');
    expect(processQueueSpy).toHaveBeenCalledTimes(1);
    expect(parsedTasks).toHaveLength(1);
    expect(parsedTasks[0].status).toBe('queued');
    expect(parsedTasks[0].model).toBe('single-review-model');
    expect(parsedTasks[0].metadata).toEqual(expect.objectContaining({
      intended_provider: 'codex',
      chunked_review: false,
      file_path: reviewFile,
      review_type: 'code_review',
    }));
  });

  it('handleSubmitChunkedReview returns MISSING_REQUIRED_PARAM when file_path is missing', async () => {
    const result = await handleSubmitChunkedReview({
      review_type: 'code_review',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(getText(result)).toContain('file_path');
  });

  it('handleSubmitChunkedReview returns MISSING_REQUIRED_PARAM when file_path is empty string', async () => {
    const result = await handleSubmitChunkedReview({
      file_path: '',
      review_type: 'security_audit',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(getText(result)).toContain('file_path');
  });

  it('handleSubmitChunkedReview returns OPERATION_FAILED when file does not exist', async () => {
    const nonExistentFile = path.join(tempDir, 'does-not-exist.js');

    const result = await handleSubmitChunkedReview({
      file_path: nonExistentFile,
      review_type: 'code_review',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('OPERATION_FAILED');
    expect(getText(result)).toContain('Cannot read file');
  });

  it('handleSubmitChunkedReview with custom_prompt uses the provided prompt instead of default review type', async () => {
    const reviewFile = path.join(tempDir, 'custom-prompt-file.js');
    // Small file that won't need chunking
    const reviewContent = 'const x = 1;\nconst y = 2;\n';
    fs.writeFileSync(reviewFile, reviewContent, 'utf8');

    vi.spyOn(providerRoutingCore, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'ollama',
      model: 'custom-model',
    });
    vi.spyOn(taskManager, 'processQueue').mockImplementation(() => {});

    const customPrompt = 'Check this code for memory leaks and resource management issues.';
    const result = await handleSubmitChunkedReview({
      file_path: reviewFile,
      review_type: 'code_review',
      custom_prompt: customPrompt,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('Single Review Task Submitted');

    const createdTasks = rawDb().prepare('SELECT task_description FROM tasks ORDER BY created_at ASC').all();
    expect(createdTasks).toHaveLength(1);
    // The custom prompt should be used in the task description instead of the default code_review prompt
    expect(createdTasks[0].task_description).toContain(customPrompt);
    expect(createdTasks[0].task_description).not.toContain('Code quality and readability');
  });

  it('handleSubmitChunkedReview aggregation task chunk_task_ids contains exactly the IDs of all chunk tasks', async () => {
    const reviewFile = path.join(tempDir, 'multi-chunk-verify.js');
    // Generate a file large enough to require chunking with a very small token limit
    const reviewContent = Array.from(
      { length: 300 },
      (_, index) => `function handler${index}() { return ${index}; }`
    ).join('\n');
    fs.writeFileSync(reviewFile, reviewContent, 'utf8');

    vi.spyOn(providerRoutingCore, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'codex',
      model: 'chunk-verify-model',
    });
    vi.spyOn(taskManager, 'processQueue').mockImplementation(() => {});

    const result = await handleSubmitChunkedReview({
      file_path: reviewFile,
      review_type: 'bug_hunt',
      token_limit: 150,
      priority: 3,
    });
    const text = getText(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Chunked Review Submitted');
    expect(text).toContain('bug_hunt');

    const createdTasks = rawDb().prepare('SELECT id, status, priority, metadata FROM tasks ORDER BY created_at ASC').all();
    const parsedTasks = createdTasks.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));

    const chunkTasks = parsedTasks.filter((row) => row.metadata && row.metadata.chunked_review && !row.metadata.is_aggregation);
    const aggregationTask = parsedTasks.find((row) => row.metadata && row.metadata.is_aggregation);

    // At least 2 chunks expected for 300 functions with token_limit 150
    expect(chunkTasks.length).toBeGreaterThanOrEqual(2);
    // All chunks should have sequential chunk_number from 1..N
    const chunkNumbers = chunkTasks.map((t) => t.metadata.chunk_number).sort((a, b) => a - b);
    expect(chunkNumbers).toEqual(Array.from({ length: chunkTasks.length }, (_, i) => i + 1));
    // Each chunk should report total_chunks matching the actual count
    expect(chunkTasks.every((t) => t.metadata.total_chunks === chunkTasks.length)).toBe(true);
    // Each chunk should have the correct review_type
    expect(chunkTasks.every((t) => t.metadata.review_type === 'bug_hunt')).toBe(true);
    // Each chunk should have priority 3
    expect(chunkTasks.every((t) => t.priority === 3)).toBe(true);

    // Aggregation task references exactly the chunk task IDs
    expect(aggregationTask).toBeDefined();
    expect(aggregationTask.metadata.chunk_task_ids).toHaveLength(chunkTasks.length);
    expect(aggregationTask.metadata.chunk_task_ids.slice().sort()).toEqual(
      chunkTasks.map((row) => row.id).slice().sort()
    );
    // Aggregation is pending, not queued
    expect(aggregationTask.status).toBe('pending');
    // Aggregation inherits the review_type
    expect(aggregationTask.metadata.review_type).toBe('bug_hunt');
  });
});
