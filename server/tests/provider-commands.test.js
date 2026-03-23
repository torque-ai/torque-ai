/**
 * Tests for provider command builder functions extracted from startTask.
 *
 * Tests: buildClaudeCliCommand, buildCodexCommand
 */

const _os = require('os');
const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');
const { createConfigMock: _createConfigMock } = require('./test-helpers');

let db, tm, testDir, origDataDir;

beforeAll(() => {
  const ctx = setupE2eDb('provider-commands');
  db = ctx.db;
  tm = ctx.tm;
  testDir = ctx.testDir;
  origDataDir = ctx.origDataDir;
});

afterAll(async () => {
  await teardownE2eDb({ db, testDir, origDataDir });
});

// ── Helper ──────────────────────────────────────────────────────

function makeTask(overrides = {}) {
  return {
    id: 'test-task-1',
    task_description: overrides.description || 'Write a hello world function in hello.js',
    working_directory: overrides.workingDirectory || testDir,
    provider: overrides.provider || 'hashline-ollama',
    model: overrides.model || 'qwen2.5-coder:7b',
    retry_count: overrides.retry_count || 0,
    metadata: overrides.metadata || null,
    files: overrides.files || null,
    project: overrides.project || null,
    auto_approve: overrides.auto_approve || false,
    ...(overrides.extra || {}),
  };
}

// buildAiderCommand and configureAiderHost tests removed — aider provider no longer exists

// ── buildClaudeCliCommand ───────────────────────────────────────

describe('buildClaudeCliCommand', () => {
  it('returns cliPath, finalArgs, and stdinPrompt', () => {
    const task = makeTask({ provider: 'claude-cli' });
    const result = tm.buildClaudeCliCommand(task, null, '');

    expect(result).toHaveProperty('cliPath');
    expect(result).toHaveProperty('finalArgs');
    expect(result).toHaveProperty('stdinPrompt');
    expect(typeof result.stdinPrompt).toBe('string');
    expect(result.stdinPrompt.length).toBeGreaterThan(0);
  });

  it('includes required flags', () => {
    const task = makeTask({ provider: 'claude-cli' });
    const result = tm.buildClaudeCliCommand(task, null, '');

    expect(result.finalArgs).toContain('--dangerously-skip-permissions');
    expect(result.finalArgs).toContain('--disable-slash-commands');
    expect(result.finalArgs).toContain('--strict-mcp-config');
    expect(result.finalArgs).toContain('-p');
  });

  it('uses provider cli_path override', () => {
    const task = makeTask({ provider: 'claude-cli' });
    // On Windows, bare paths without extensions get .cmd appended
    const result = tm.buildClaudeCliCommand(task, { cli_path: '/usr/local/bin/claude' }, '');

    if (process.platform === 'win32') {
      expect(result.cliPath).toBe('/usr/local/bin/claude.cmd');
    } else {
      expect(result.cliPath).toBe('/usr/local/bin/claude');
    }
  });

  it('uses claude.cmd on Windows', () => {
    if (process.platform !== 'win32') return; // Skip on non-Windows
    const task = makeTask({ provider: 'claude-cli' });
    const result = tm.buildClaudeCliCommand(task, null, '');

    expect(result.cliPath).toBe('claude.cmd');
  });

  it('wraps task description with instructions', () => {
    const task = makeTask({ description: 'Fix the bug in main.js', provider: 'claude-cli' });
    const result = tm.buildClaudeCliCommand(task, null, '');

    // stdinPrompt should contain the task description
    expect(result.stdinPrompt).toContain('Fix the bug in main.js');
  });
});

// ── buildCodexCommand ───────────────────────────────────────────

describe('buildCodexCommand', () => {
  it('returns cliPath, finalArgs, and stdinPrompt', () => {
    const task = makeTask({ provider: 'codex' });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result).toHaveProperty('cliPath');
    expect(result).toHaveProperty('finalArgs');
    expect(result).toHaveProperty('stdinPrompt');
    expect(typeof result.stdinPrompt).toBe('string');
  });

  it('includes exec in args', () => {
    const task = makeTask({ provider: 'codex' });
    const result = tm.buildCodexCommand(task, null, '');

    // On nvm-managed Node, finalArgs may be prepended with the codex path
    expect(result.finalArgs).toContain('exec');
  });

  it('includes --skip-git-repo-check', () => {
    const task = makeTask({ provider: 'codex' });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.finalArgs).toContain('--skip-git-repo-check');
  });

  it('includes model flag when specified', () => {
    const task = makeTask({ provider: 'codex', model: 'gpt-5.3-codex-spark' });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.finalArgs).toContain('-m');
    const mIdx = result.finalArgs.indexOf('-m');
    expect(result.finalArgs[mIdx + 1]).toBe('gpt-5.3-codex-spark');
  });

  it('uses --full-auto by default', () => {
    const task = makeTask({ provider: 'codex', auto_approve: false });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.finalArgs).toContain('--full-auto');
    expect(result.finalArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('uses --dangerously-bypass-approvals-and-sandbox when auto_approve', () => {
    const task = makeTask({ provider: 'codex', auto_approve: true });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.finalArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(result.finalArgs).not.toContain('--full-auto');
  });

  it('includes -C with working directory', () => {
    const task = makeTask({ provider: 'codex', workingDirectory: '/tmp/test' });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.finalArgs).toContain('-C');
    const cIdx = result.finalArgs.indexOf('-C');
    expect(result.finalArgs[cIdx + 1]).toBe('/tmp/test');
  });

  it('reads prompt from stdin (- arg)', () => {
    const task = makeTask({ provider: 'codex' });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.finalArgs).toContain('-');
  });

  it('uses provider cli_path override', () => {
    const task = makeTask({ provider: 'codex' });
    const result = tm.buildCodexCommand(task, { cli_path: '/usr/local/bin/codex' }, '');

    if (process.platform === 'win32') {
      expect(result.cliPath).toBe('/usr/local/bin/codex.cmd');
    } else {
      expect(result.cliPath).toBe('/usr/local/bin/codex');
    }
  });

  it('uses codex.cmd on Windows', () => {
    if (process.platform !== 'win32') return;
    const task = makeTask({ provider: 'codex' });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.cliPath).toBe('codex.cmd');
  });

  it('wraps task description with instructions', () => {
    const task = makeTask({ description: 'Create a REST API', provider: 'codex' });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.stdinPrompt).toContain('Create a REST API');
  });
});
