/**
 * Tests for provider command builder functions extracted from startTask.
 *
 * Tests: buildAiderCommand, configureAiderHost, buildClaudeCliCommand, buildCodexCommand
 */

const path = require('path');
const _os = require('os');
const fs = require('fs');
const { setupE2eDb, teardownE2eDb, registerMockHost } = require('./e2e-helpers');

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
    provider: overrides.provider || 'aider-ollama',
    model: overrides.model || 'qwen2.5-coder:7b',
    retry_count: overrides.retry_count || 0,
    metadata: overrides.metadata || null,
    files: overrides.files || null,
    project: overrides.project || null,
    auto_approve: overrides.auto_approve || false,
    ...(overrides.extra || {}),
  };
}

// ── buildAiderCommand ────────────────────────────────────────────

describe('buildAiderCommand', () => {
  it('returns cliPath, finalArgs, and usedEditFormat', () => {
    const task = makeTask();
    const result = tm.buildAiderCommand(task, '', []);

    expect(result).toHaveProperty('cliPath');
    expect(result).toHaveProperty('finalArgs');
    expect(result).toHaveProperty('usedEditFormat');
    expect(Array.isArray(result.finalArgs)).toBe(true);
  });

  it('uses default diff edit format for large models', () => {
    // Use a large model to avoid proactive 'whole' selection for small models
    const task = makeTask({ model: 'qwen2.5-coder:32b' });
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--edit-format');
    const fmtIdx = result.finalArgs.indexOf('--edit-format');
    expect(result.finalArgs[fmtIdx + 1]).toBe('diff');
    expect(result.usedEditFormat).toBe('diff');
  });

  it('uses model from task', () => {
    const task = makeTask({ model: 'codestral:22b' });
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--model');
    const modelIdx = result.finalArgs.indexOf('--model');
    expect(result.finalArgs[modelIdx + 1]).toBe('ollama/codestral:22b');
  });

  it('includes --exit and --message flags', () => {
    const task = makeTask();
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--exit');
    expect(result.finalArgs).toContain('--message');
  });

  it('includes --subtree-only by default', () => {
    const task = makeTask();
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--subtree-only');
  });

  it('includes --no-auto-commits by default', () => {
    const task = makeTask();
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--no-auto-commits');
  });

  it('includes --no-dirty-commits always', () => {
    const task = makeTask();
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--no-dirty-commits');
  });

  it('auto-switches to whole on retry', () => {
    const task = makeTask({ retry_count: 1 });
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');
    const fmtIdx = result.finalArgs.indexOf('--edit-format');
    expect(result.finalArgs[fmtIdx + 1]).toBe('whole');
  });

  it('uses stall recovery edit format from metadata', () => {
    const task = makeTask({
      metadata: JSON.stringify({ stallRecoveryEditFormat: 'whole' }),
    });
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');
  });

  it('disables thinking tokens for qwen3 model', () => {
    const task = makeTask({ model: 'qwen3:8b' });
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--thinking-tokens');
    const idx = result.finalArgs.indexOf('--thinking-tokens');
    expect(result.finalArgs[idx + 1]).toBe('0');
    expect(result.finalArgs).toContain('--no-check-model-accepts-settings');
  });

  it('disables thinking tokens for deepseek-r1 model', () => {
    const task = makeTask({ model: 'deepseek-r1:14b' });
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--thinking-tokens');
  });

  it('does not add thinking tokens flag for non-thinking models', () => {
    const task = makeTask({ model: 'codestral:22b' });
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.finalArgs).not.toContain('--thinking-tokens');
  });

  it('adds resolved file paths to args', () => {
    // Create a file in the working directory
    const testFile = path.join(testDir, 'test-file.js');
    fs.writeFileSync(testFile, 'console.log("hello");');

    const task = makeTask({ workingDirectory: testDir });
    const result = tm.buildAiderCommand(task, '', [testFile]);

    // The resolved file path should appear in finalArgs
    expect(result.finalArgs.some(arg => arg.includes('test-file.js'))).toBe(true);
  });

  it('applies model-specific edit format override', () => {
    db.setConfig('aider_model_edit_formats', JSON.stringify({ 'gemma3:4b': 'whole' }));
    const task = makeTask({ model: 'gemma3:4b' });
    const result = tm.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');

    // Clean up
    db.setConfig('aider_model_edit_formats', '');
  });

  it('uses proactive whole for small models', () => {
    // gemma3:4b is a small model (4B params)
    const task = makeTask({ model: 'gemma3:4b', retry_count: 0 });
    const result = tm.buildAiderCommand(task, '', []);

    // Proactive selection should switch to 'whole' for small models
    expect(result.usedEditFormat).toBe('whole');
  });
});

// ── configureAiderHost ──────────────────────────────────────────

describe('configureAiderHost', () => {
  it('returns selectedHostId when host available', () => {
    const _host = registerMockHost(db, 'http://127.0.0.1:11111', ['qwen2.5-coder:7b'], {
      name: 'test-host-1',
      id: `mock-configure-test-${Date.now()}`,
    });

    const task = makeTask({ model: 'qwen2.5-coder:7b' });
    const envVars = {};
    const result = tm.configureAiderHost(task, 'task-1', envVars);

    expect(result.requeued).toBeUndefined();
    expect(result.selectedHostId).toBeTruthy();
    expect(envVars.OLLAMA_API_BASE).toBe('http://127.0.0.1:11111');
    expect(envVars.LITELLM_NUM_RETRIES).toBe('3');
    expect(envVars.LITELLM_REQUEST_TIMEOUT).toBe('120');

    // Clean up - decrement the host task count
    try { db.decrementHostTasks(result.selectedHostId); } catch { /* ignore */ }
  });

  it('falls back to single-host mode when no hosts registered', () => {
    // Remove all hosts
    const hosts = db.listOllamaHosts();
    for (const h of hosts) {
      db.removeOllamaHost(h.id);
    }

    const task = makeTask();
    const envVars = {};
    const result = tm.configureAiderHost(task, 'task-2', envVars);

    expect(result.selectedHostId).toBeNull();
    expect(envVars.OLLAMA_API_BASE).toBeTruthy(); // Should use default
    expect(envVars.LITELLM_NUM_RETRIES).toBe('3');
  });

  it('applies per-task tuning overrides', () => {
    const _host = registerMockHost(db, 'http://127.0.0.1:11112', ['qwen2.5-coder:7b'], {
      name: 'test-host-tune',
      id: `mock-tune-test-${Date.now()}`,
    });

    const task = makeTask({
      model: 'qwen2.5-coder:7b',
      metadata: JSON.stringify({ tuning_overrides: { num_ctx: 32768 } }),
    });
    const envVars = {};
    const result = tm.configureAiderHost(task, 'task-3', envVars);

    expect(envVars.OLLAMA_NUM_CTX).toBe('32768');

    // Clean up
    try { db.decrementHostTasks(result.selectedHostId); } catch { /* ignore */ }
  });

  it('applies per-model tuning settings', () => {
    const _host = registerMockHost(db, 'http://127.0.0.1:11113', ['qwen2.5-coder:7b'], {
      name: 'test-host-model-tune',
      id: `mock-model-tune-${Date.now()}`,
    });
    db.setConfig('ollama_model_settings', JSON.stringify({
      'qwen2.5-coder:7b': { num_ctx: 16384, num_gpu: 99 }
    }));

    const task = makeTask({ model: 'qwen2.5-coder:7b' });
    const envVars = {};
    const result = tm.configureAiderHost(task, 'task-4', envVars);

    expect(envVars.OLLAMA_NUM_CTX).toBe('16384');
    expect(envVars.OLLAMA_NUM_GPU).toBe('99');

    // Clean up
    db.setConfig('ollama_model_settings', '');
    try { db.decrementHostTasks(result.selectedHostId); } catch { /* ignore */ }
  });

  it('throws on OOM protection', () => {
    // Register a host with small VRAM limit and request a huge model
    const _host = registerMockHost(db, 'http://127.0.0.1:11114', ['tiny:1b'], {
      name: 'test-host-oom',
      id: `mock-oom-test-${Date.now()}`,
    });

    const task = makeTask({ model: 'nonexistent-model:999b' });
    const envVars = {};

    // Should throw since model doesn't exist on any host
    expect(() => {
      tm.configureAiderHost(task, 'task-5', envVars);
    }).toThrow();
  });
});

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

  it('includes exec as first arg', () => {
    const task = makeTask({ provider: 'codex' });
    const result = tm.buildCodexCommand(task, null, '');

    expect(result.finalArgs[0]).toBe('exec');
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
