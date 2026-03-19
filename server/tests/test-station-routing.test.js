/**
 * Test Station Routing — Config File Writing Tests
 *
 * Tests for writeTestStationConfig which:
 * 1. Writes .torque-test.json (shared config)
 * 2. Writes .torque-test.local.json (personal SSH details)
 * 3. Adds .torque-test.local.json to .gitignore
 * 4. Installs Claude Code guard hook in .claude/settings.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeTestStationConfig } = require('../handlers/automation-handlers');

let tmpDir;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `torque-test-station-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('writeTestStationConfig', () => {
  it('writes .torque-test.json with correct fields when SSH fields are set', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
      test_station_project_path: '/home/kenten/project',
      verify_command: 'npm test',
    };
    const configUpdate = { verify_command: 'npm test' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const filePath = path.join(tmpDir, '.torque-test.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.version).toBe(1);
    expect(content.transport).toBe('ssh');
    expect(content.verify_command).toBe('npm test');
    expect(content.timeout_seconds).toBe(300);
    expect(content.sync_before_run).toBe(true);
  });

  it('writes .torque-test.json with transport "local" when no SSH fields', () => {
    const args = { verify_command: 'npm test' };
    const configUpdate = { verify_command: 'npm test' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const filePath = path.join(tmpDir, '.torque-test.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.transport).toBe('local');
  });

  it('writes .torque-test.local.json with SSH details', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
      test_station_project_path: '/home/kenten/project',
      test_station_key_path: '~/.ssh/id_rsa',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const filePath = path.join(tmpDir, '.torque-test.local.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.host).toBe('192.168.1.183');
    expect(content.user).toBe('kenten');
    expect(content.project_path).toBe('/home/kenten/project');
    expect(content.key_path).toBe('~/.ssh/id_rsa');
  });

  it('does not write .torque-test.local.json when no SSH fields', () => {
    const args = { verify_command: 'npm test' };
    const configUpdate = { verify_command: 'npm test' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const filePath = path.join(tmpDir, '.torque-test.local.json');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('adds .torque-test.local.json to .gitignore', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const gitignorePath = path.join(tmpDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf8');
    expect(content).toContain('.torque-test.local.json');
  });

  it('does not duplicate .gitignore entry on second call', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);
    writeTestStationConfig(tmpDir, args, configUpdate);

    const gitignorePath = path.join(tmpDir, '.gitignore');
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const matches = content.split('\n').filter(line => line.trim() === '.torque-test.local.json');
    expect(matches.length).toBe(1);
  });

  it('appends to existing .gitignore without losing content', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n');

    const args = {
      test_station_host: '192.168.1.183',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const content = fs.readFileSync(gitignorePath, 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.env');
    expect(content).toContain('.torque-test.local.json');
  });

  it('installs hook config in .claude/settings.json for SSH transport', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeInstanceOf(Array);
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);

    const bashHook = settings.hooks.PreToolUse.find(h => h.matcher === 'Bash');
    expect(bashHook).toBeDefined();
    expect(bashHook.hooks).toBeInstanceOf(Array);
    expect(bashHook.hooks[0].type).toBe('command');
    expect(bashHook.hooks[0].command).toContain('torque-test-guard');
  });

  it('does NOT install hook when transport is local', () => {
    const args = { verify_command: 'npm test' };
    const configUpdate = { verify_command: 'npm test' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('merges with existing .torque-test.json without losing fields', () => {
    const existingConfig = {
      version: 1,
      transport: 'local',
      verify_command: 'old command',
      timeout_seconds: 600,
      sync_before_run: false,
      custom_field: 'should_survive',
    };
    fs.writeFileSync(
      path.join(tmpDir, '.torque-test.json'),
      JSON.stringify(existingConfig, null, 2)
    );

    const args = {
      test_station_host: '192.168.1.183',
      verify_command: 'new command',
    };
    const configUpdate = { verify_command: 'new command' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.torque-test.json'), 'utf8'));
    expect(content.transport).toBe('ssh');
    expect(content.verify_command).toBe('new command');
    expect(content.custom_field).toBe('should_survive');
    // timeout_seconds and sync_before_run should keep their existing values
    expect(content.timeout_seconds).toBe(600);
    expect(content.sync_before_run).toBe(false);
  });

  it('merges with existing .torque-test.local.json', () => {
    const existing = {
      host: 'old-host',
      user: 'old-user',
      project_path: '/old/path',
      key_path: '/old/key',
    };
    fs.writeFileSync(
      path.join(tmpDir, '.torque-test.local.json'),
      JSON.stringify(existing, null, 2)
    );

    const args = {
      test_station_host: 'new-host',
      // only update host, leave other fields
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.torque-test.local.json'), 'utf8'));
    expect(content.host).toBe('new-host');
    expect(content.user).toBe('old-user');
    expect(content.project_path).toBe('/old/path');
    expect(content.key_path).toBe('/old/key');
  });

  it('merges with existing .claude/settings.json without losing other settings', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const existingSettings = {
      permissions: { allow: ['Read', 'Write'] },
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo done' }] }],
      },
    };
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(existingSettings, null, 2)
    );

    const args = {
      test_station_host: '192.168.1.183',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    // Original settings preserved
    expect(settings.permissions).toEqual({ allow: ['Read', 'Write'] });
    expect(settings.hooks.PostToolUse).toEqual(existingSettings.hooks.PostToolUse);
    // New hook added
    expect(settings.hooks.PreToolUse).toBeDefined();
    const bashHook = settings.hooks.PreToolUse.find(h => h.matcher === 'Bash');
    expect(bashHook).toBeDefined();
  });

  it('does not duplicate hook if already installed', () => {
    const args = {
      test_station_host: '192.168.1.183',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);
    writeTestStationConfig(tmpDir, args, configUpdate);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const bashHooks = settings.hooks.PreToolUse.filter(h => h.matcher === 'Bash');
    expect(bashHooks.length).toBe(1);
  });

  it('handles corrupt existing JSON files gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, '.torque-test.json'), 'NOT VALID JSON{{{');

    const args = {
      test_station_host: '192.168.1.183',
      verify_command: 'npm test',
    };
    const configUpdate = { verify_command: 'npm test' };

    // Should not throw
    writeTestStationConfig(tmpDir, args, configUpdate);

    // Should write fresh config
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.torque-test.json'), 'utf8'));
    expect(content.version).toBe(1);
    expect(content.transport).toBe('ssh');
  });
});

// ---------------------------------------------------------------------------
// await verify routing
// ---------------------------------------------------------------------------
import { afterEach as afterEachV, beforeEach as beforeEachV, describe as describeV, expect as expectV, it as itV, vi as viV } from 'vitest';

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

// Hoisted mocks (must be set up before require() of the module under test)
const awaitMocks = viV.hoisted(() => ({
  taskEvents: new EventEmitter(),
  executeValidatedCommandSync: viV.fn(),
  safeExecChain: viV.fn(),
  handlePeekUi: viV.fn(),
}));

function installAwaitMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadAwaitFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function textOfResult(result) {
  return result?.content?.[0]?.text || '';
}

describeV('await verify routing', () => {
  const { setupTestDb, teardownTestDb } = require('./vitest-setup');
  const db = require('../database');
  const hostMonitoring = require('../utils/host-monitoring');
  let tmpDir;
  let handlers;

  function createTestTask(overrides = {}) {
    const id = overrides.id || randomUUID();
    db.createTask({
      id,
      task_description: 'Routing test task',
      provider: 'codex',
      model: 'gpt-5',
      status: 'pending',
      working_directory: tmpDir,
      ...overrides,
    });
    return id;
  }

  function finalizeTestTask(taskId, status = 'completed', overrides = {}) {
    const task = db.getTask(taskId);
    if (!task) return;
    if (task.status === 'blocked') db.updateTaskStatus(taskId, 'pending');
    const current = db.getTask(taskId);
    if (current && ['pending', 'queued'].includes(current.status)) {
      db.updateTaskStatus(taskId, 'running', { started_at: '2026-01-01T00:00:00.000Z' });
    }
    db.updateTaskStatus(taskId, status, {
      output: overrides.output ?? (status === 'completed' ? 'task output' : ''),
      error_output: overrides.error_output ?? (status === 'failed' ? 'task failed' : null),
      exit_code: overrides.exit_code ?? (status === 'completed' ? 0 : 1),
      completed_at: '2026-01-01T00:00:05.000Z',
      files_modified: overrides.files_modified ?? null,
    });
  }

  beforeEachV(() => {
    tmpDir = path.join(os.tmpdir(), `torque-await-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    setupTestDb(`await-routing-${Date.now()}`);

    installAwaitMock('../hooks/event-dispatch', { taskEvents: awaitMocks.taskEvents });
    installAwaitMock('../execution/command-policy', {
      executeValidatedCommandSync: awaitMocks.executeValidatedCommandSync,
    });
    installAwaitMock('../utils/safe-exec', {
      safeExecChain: awaitMocks.safeExecChain,
    });
    installAwaitMock('../handlers/peek-handlers', {
      handlePeekUi: awaitMocks.handlePeekUi,
    });

    awaitMocks.executeValidatedCommandSync.mockReset();
    awaitMocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
      if (command === 'git' && args[0] === 'rev-parse') return 'abc123\n';
      if (command === 'git' && args[0] === 'diff') return '';
      return 'verify ok\n';
    });
    awaitMocks.safeExecChain.mockReset();
    awaitMocks.safeExecChain.mockReturnValue({ exitCode: 0, output: 'verify ok' });
    awaitMocks.handlePeekUi.mockReset();
    awaitMocks.handlePeekUi.mockResolvedValue({ content: [] });
    awaitMocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();

    handlers = loadAwaitFresh('../handlers/workflow/await');
  });

  afterEachV(() => {
    viV.restoreAllMocks();
    awaitMocks.executeValidatedCommandSync.mockReset();
    awaitMocks.safeExecChain.mockReset();
    awaitMocks.handlePeekUi.mockReset();
    awaitMocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    viV.useRealTimers();
    teardownTestDb();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  itV('handleAwaitTask routes through torque-remote when it is on PATH', async () => {
    // Simulate torque-remote being available on PATH by making execFileSync('which', ...) succeed
    viV.spyOn(require('child_process'), 'execFileSync').mockImplementation((cmd, args) => {
      if (cmd === 'which' && args[0] === 'torque-remote') return '';
      throw new Error('unexpected execFileSync call');
    });

    const taskId = createTestTask({ status: 'running', working_directory: tmpDir });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      verify_command: 'npx vitest run',
      working_directory: tmpDir,
      poll_interval_ms: 30000,
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));
    finalizeTestTask(taskId, 'completed');
    awaitMocks.taskEvents.emit('task:completed', taskId);
    const result = await promise;

    expectV(textOfResult(result)).toContain('### Verify Command');
    expectV(textOfResult(result)).toContain('Passed');

    // Should invoke torque-remote with the verify command as argument
    expectV(awaitMocks.executeValidatedCommandSync).toHaveBeenCalledWith(
      'torque-remote',
      expectV.arrayContaining(['npx vitest run']),
      expectV.objectContaining({ cwd: tmpDir })
    );
    // Should NOT call sh or cmd for verify
    const verifyCalls = awaitMocks.executeValidatedCommandSync.mock.calls.filter(
      ([cmd]) => cmd === 'sh' || cmd === 'cmd'
    );
    expectV(verifyCalls.length).toBe(0);
  });

  itV('handleAwaitTask falls back to direct execution when torque-remote is not on PATH', async () => {
    // Simulate torque-remote not available — execFileSync('which', ...) throws
    viV.spyOn(require('child_process'), 'execFileSync').mockImplementation(() => {
      throw new Error('not found');
    });

    const taskId = createTestTask({ status: 'running', working_directory: tmpDir });

    const promise = handlers.handleAwaitTask({
      task_id: taskId,
      verify_command: 'npx vitest run',
      working_directory: tmpDir,
      poll_interval_ms: 30000,
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));
    finalizeTestTask(taskId, 'completed');
    awaitMocks.taskEvents.emit('task:completed', taskId);
    const result = await promise;

    expectV(textOfResult(result)).toContain('### Verify Command');
    expectV(textOfResult(result)).toContain('Passed');

    // Should invoke sh or cmd (platform-dependent fallback), NOT torque-remote
    expectV(awaitMocks.executeValidatedCommandSync).toHaveBeenCalledWith(
      expectV.stringMatching(/^(cmd|sh)$/),
      expectV.arrayContaining(['npx vitest run']),
      expectV.objectContaining({ cwd: tmpDir })
    );
    const torqueRemoteCalls = awaitMocks.executeValidatedCommandSync.mock.calls.filter(
      ([cmd]) => cmd === 'torque-remote'
    );
    expectV(torqueRemoteCalls.length).toBe(0);
  });

  itV('handleAwaitWorkflow routes through torque-remote when it is on PATH', async () => {
    // Simulate torque-remote available
    viV.spyOn(require('child_process'), 'execFileSync').mockImplementation((cmd, args) => {
      if (cmd === 'which' && args[0] === 'torque-remote') return '';
      throw new Error('unexpected execFileSync call');
    });

    const wfId = randomUUID();
    db.createWorkflow({
      id: wfId,
      name: 'Routing workflow test',
      status: 'completed',
      context: {},
      working_directory: tmpDir,
    });

    // Add and finalize one task so formatFinalSummary is reached
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      workflow_id: wfId,
      workflow_node_id: 'build',
      task_description: 'build task',
      provider: 'codex',
      model: 'gpt-5',
      status: 'pending',
      working_directory: tmpDir,
    });
    db.updateTaskStatus(taskId, 'running', { started_at: '2026-01-01T00:00:00.000Z' });
    db.updateTaskStatus(taskId, 'completed', {
      output: 'build done',
      exit_code: 0,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    const result = await handlers.handleAwaitWorkflow({
      workflow_id: wfId,
      verify_command: 'npx vitest run',
      working_directory: tmpDir,
      poll_interval_ms: 10,
      timeout_minutes: 1,
    });

    const text = textOfResult(result);
    expectV(text).toContain('### Verification');

    // safeExecChain should be called with torque-remote prefixed command
    expectV(awaitMocks.safeExecChain).toHaveBeenCalledWith(
      expectV.stringContaining('torque-remote'),
      expectV.objectContaining({ cwd: tmpDir })
    );
    expectV(awaitMocks.safeExecChain).toHaveBeenCalledWith(
      expectV.stringContaining('npx vitest run'),
      expectV.any(Object)
    );
  });

  itV('handleAwaitWorkflow falls back to direct command when torque-remote is not on PATH', async () => {
    // Simulate torque-remote not available
    viV.spyOn(require('child_process'), 'execFileSync').mockImplementation(() => {
      throw new Error('not found');
    });

    const wfId = randomUUID();
    db.createWorkflow({
      id: wfId,
      name: 'Routing workflow fallback test',
      status: 'completed',
      context: {},
      working_directory: tmpDir,
    });

    // Add and finalize one task so formatFinalSummary is reached
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      workflow_id: wfId,
      workflow_node_id: 'build',
      task_description: 'build task',
      provider: 'codex',
      model: 'gpt-5',
      status: 'pending',
      working_directory: tmpDir,
    });
    db.updateTaskStatus(taskId, 'running', { started_at: '2026-01-01T00:00:00.000Z' });
    db.updateTaskStatus(taskId, 'completed', {
      output: 'build done',
      exit_code: 0,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    const result = await handlers.handleAwaitWorkflow({
      workflow_id: wfId,
      verify_command: 'npx vitest run',
      working_directory: tmpDir,
      poll_interval_ms: 10,
      timeout_minutes: 1,
    });

    const text = textOfResult(result);
    expectV(text).toContain('### Verification');

    // safeExecChain should be called with the original verify_command (no torque-remote prefix)
    expectV(awaitMocks.safeExecChain).toHaveBeenCalledWith(
      'npx vitest run',
      expectV.objectContaining({ cwd: tmpDir })
    );
  });
});
