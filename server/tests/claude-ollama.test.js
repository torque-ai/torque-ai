import { describe, expect, it, vi } from 'vitest';

const ClaudeOllamaProvider = require('../providers/claude-ollama');
const child_process = require('child_process');
const hostManagement = require('../db/host-management');

describe('ClaudeOllamaProvider — construction', () => {
  it('has provider name "claude-ollama"', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.name).toBe('claude-ollama');
  });

  it('defaults to enabled=false (opt-in provider)', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.enabled).toBe(false);
  });

  it('respects config.enabled=true', () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    expect(p.enabled).toBe(true);
  });

  it('exposes supportsStreaming=true', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.supportsStreaming).toBe(true);
  });

  it('derives providerId for config lookups', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.providerId).toBe('claude-ollama');
  });
});

describe('ClaudeOllamaProvider.checkHealth', () => {
  it('returns unavailable when ollama binary is missing', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockImplementation((bin) => {
      if (String(bin).includes('ollama')) return { status: 1, stderr: 'not found' };
      return { status: 0, stdout: '2.1.0' };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/ollama/i);
    spawnSyncSpy.mockRestore();
  });

  it('returns unavailable when claude binary is missing', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockImplementation((bin) => {
      if (String(bin).includes('claude')) return { status: 1, stderr: 'not found' };
      return { status: 0, stdout: 'ollama version 0.20.7' };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/claude/i);
    spawnSyncSpy.mockRestore();
  });

  it('returns unavailable when no active Ollama host has local models', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockReturnValue({ status: 0, stdout: 'v1' });
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/no.*host/i);
    spawnSyncSpy.mockRestore();
    hostsSpy.mockRestore();
  });
});

describe('ClaudeOllamaProvider.listModels', () => {
  it('returns union of local models across all active hosts', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', name: 'HostA', url: 'http://host-a.test:11434', enabled: 1 },
      { id: 'h2', name: 'HostB', url: 'http://host-b.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (url.includes('host-a')) return { ok: true, json: async () => ({ models: [
        { name: 'qwen3-coder:30b' }, { name: 'gemma4:latest' },
      ] }) };
      return { ok: true, json: async () => ({ models: [
        { name: 'qwen3.5:latest' }, { name: 'gemma4:latest' },
      ] }) };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models.sort()).toEqual(['gemma4:latest', 'qwen3-coder:30b', 'qwen3.5:latest']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('filters out cloud-tagged models', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', url: 'http://host-a.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ models: [
        { name: 'qwen3-coder:30b' },
        { name: 'qwen3-coder:480b-cloud' },
        { name: 'gpt-oss:120b-cloud' },
      ] }),
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models).toEqual(['qwen3-coder:30b']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('returns empty array when no hosts are registered', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);
    const p = new ClaudeOllamaProvider({ enabled: true });
    expect(await p.listModels()).toEqual([]);
    hostsSpy.mockRestore();
  });

  it('skips a host whose /api/tags fails', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', url: 'http://host-a.test:11434', enabled: 1 },
      { id: 'h2', url: 'http://host-b.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (url.includes('host-a')) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3.5:latest' }] }) };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models).toEqual(['qwen3.5:latest']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});

describe('ClaudeOllamaProvider.buildCommandArgs', () => {
  it('includes launch/claude/model and the -- passthrough boundary', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [],
      disallowedTools: [],
      claudeSessionId: 'cs1',
      messageCount: 0,
    });
    expect(args[0]).toBe('launch');
    expect(args[1]).toBe('claude');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('qwen3-coder:30b');
    expect(args).toContain('--');
    const postDash = args.slice(args.indexOf('--') + 1);
    expect(postDash).toContain('--output-format');
    expect(postDash[postDash.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(postDash).toContain('-p');
  });

  it('emits --add-dir with the working directory', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [], disallowedTools: [],
      claudeSessionId: 'cs1', messageCount: 0,
    });
    const idx = args.indexOf('--add-dir');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/tmp/wd');
  });

  it('emits --allowed-tools / --disallowed-tools when non-empty', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: ['Read', 'Edit'],
      disallowedTools: ['Bash'],
      claudeSessionId: 'cs1', messageCount: 0,
    });
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Read,Edit');
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('Bash');
  });

  it('uses --session-id for a new session (messageCount=0)', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [], disallowedTools: [],
      claudeSessionId: 'cs-new', messageCount: 0,
    });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('cs-new');
    expect(args).not.toContain('--resume');
  });

  it('uses --resume when messageCount > 0', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [], disallowedTools: [],
      claudeSessionId: 'cs-existing', messageCount: 3,
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('cs-existing');
    expect(args).not.toContain('--session-id');
  });

  it('includes --append-system-prompt when skillPrompt is provided', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [], disallowedTools: [],
      claudeSessionId: 'cs1', messageCount: 0,
      skillPrompt: 'Follow the docstring style guide.',
    });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Follow the docstring style guide.');
  });
});

describe('ClaudeOllamaProvider.runPrompt — tool permission', () => {
  it('rejects with an error when a disallowed tool is requested', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const events = [
      { type: 'tool_call', tool_call_id: 't1', name: 'Bash', args: { cmd: 'rm -rf /' } },
    ].map(JSON.stringify).join('\n') + '\n';

    const spawnSpy = vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.kill = vi.fn(() => setImmediate(() => child.emit('close', 137, 'SIGKILL')));
      setImmediate(() => child.stdout.emit('data', Buffer.from(events)));
      return child;
    });

    await expect(p.runPrompt('test', 'qwen3-coder:30b', {
      working_directory: '/tmp/wd',
      disallowed_tools: ['Bash'],
    })).rejects.toThrow(/Bash.*denied/);

    spawnSpy.mockRestore();
  });
});

describe('ClaudeOllamaProvider — public API', () => {
  it('submit delegates to runPrompt', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const spy = vi.spyOn(p, 'runPrompt').mockResolvedValue({ output: 'ok', status: 'completed', usage: {} });
    await p.submit('task', 'qwen3-coder:30b', { working_directory: '/tmp' });
    expect(spy).toHaveBeenCalledWith('task', 'qwen3-coder:30b', { working_directory: '/tmp' });
    spy.mockRestore();
  });

  it('submitStream delegates to runPrompt', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const spy = vi.spyOn(p, 'runPrompt').mockResolvedValue({ output: 'ok', status: 'completed', usage: {} });
    await p.submitStream('task', 'qwen3-coder:30b', { working_directory: '/tmp' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('dispatchSubagent forwards prompt and returns structured result', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const spy = vi.spyOn(p, 'submit').mockResolvedValue({
      output: 'done', status: 'completed', session_id: 's1',
      claude_session_id: 'cs1', usage: { tokens: 10 },
    });
    const res = await p.dispatchSubagent({ prompt: 'go', model: 'qwen3-coder:30b' });
    expect(res.output).toBe('done');
    expect(res.session_id).toBe('s1');
    spy.mockRestore();
  });

  it('dispatchSubagent rejects empty prompt', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    await expect(p.dispatchSubagent({ prompt: '' })).rejects.toThrow(/non-empty/);
  });
});

describe('ClaudeOllamaProvider.runPrompt — session append', () => {
  it('appends user and assistant messages to the session store', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const fakeStdout = JSON.stringify({ type: 'text_delta', delta: 'OK' }) + '\n';
    const spawnSpy = vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const { EventEmitter } = require('events');
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin = { end: vi.fn() }; c.kill = vi.fn();
      setImmediate(() => { c.stdout.emit('data', Buffer.from(fakeStdout)); c.emit('close', 0, null); });
      return c;
    });

    const result = await p.runPrompt('ping', 'qwen3-coder:30b', {
      working_directory: '/tmp/wd',
    });
    const messages = p.sessionStore.readAll(result.session_id);
    const roles = messages.map(m => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('ping');
    expect(messages[1].content).toBe('OK');
    spawnSpy.mockRestore();
  });
});

describe('ClaudeOllamaProvider.runPrompt — simple text', () => {
  it('spawns with correct binary+args and returns collected output', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const fakeStdout = [
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
    ].map(JSON.stringify).join('\n') + '\n';

    const spawnSpy = vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.kill = vi.fn();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(fakeStdout));
        child.emit('close', 0, null);
      });
      return child;
    });

    const result = await p.runPrompt('say hello', 'qwen3-coder:30b', {
      working_directory: '/tmp/wd',
    });
    expect(result.output).toBe('Hello world');
    expect(result.status).toBe('completed');
    expect(result.usage.total_tokens).toBe(7);
    expect(result.usage.model).toBe('qwen3-coder:30b');
    spawnSpy.mockRestore();
  });
});
