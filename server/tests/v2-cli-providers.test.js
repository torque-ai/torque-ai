'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

function installMock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath),
    filename: require.resolve(modulePath),
    loaded: true,
    exports,
  };
}

const MODULE_PATH = '../providers/v2-cli-providers';
const CHILD_PROCESS_MODULE = 'child_process';
const FS_MODULE = 'fs';
const CONFIG_CORE_MODULE = '../db/config-core';
const PROVIDER_ROUTING_CORE_MODULE = '../db/provider/routing-core';
const LOGGER_MODULE = '../logger';
const CONSTANTS_MODULE = '../constants';
const BASE_MODULE = '../providers/base';
const PROMPTS_MODULE = '../providers/prompts';

const originalPlatform = process.platform;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;

function clearModuleCaches() {
  for (const modulePath of [
    MODULE_PATH,
    CHILD_PROCESS_MODULE,
    FS_MODULE,
    CONFIG_CORE_MODULE,
    PROVIDER_ROUTING_CORE_MODULE,
    LOGGER_MODULE,
    CONSTANTS_MODULE,
    BASE_MODULE,
    PROMPTS_MODULE,
  ]) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore missing cache entries.
    }
  }
}

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function createBaseProviderMock() {
  const constructorCalls = [];

  class MockBaseProvider {
    constructor(config = {}) {
      constructorCalls.push(config);
      this.name = config.name || 'unknown';
      this.enabled = config.enabled !== false;
      this.maxConcurrent = config.maxConcurrent || 3;
      this.activeTasks = 0;
    }
  }

  return { MockBaseProvider, constructorCalls };
}

function createConfigCoreMock(overrides = {}) {
  return {
    getConfig: vi.fn(() => null),
    ...overrides,
  };
}

function createProviderRoutingCoreMock(overrides = {}) {
  return {
    getProvider: vi.fn(() => ({})),
    ...overrides,
  };
}

function createPromptsMock(overrides = {}) {
  return {
    init: vi.fn(),
    wrapWithInstructions: vi.fn((task, provider, model) => `wrapped:${provider}:${model || ''}:${task}`),
    ...overrides,
  };
}

function createMockChild({
  stdout = [],
  stderr = [],
  code = 0,
  signal = null,
  error = null,
  deferClose = false,
} = {}) {
  const child = new EventEmitter();
  const stdinChunks = [];

  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', (chunk) => {
    stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  });
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  child.getStdinText = () => stdinChunks.join('');

  if (!deferClose) {
    queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }

      for (const chunk of stdout) {
        child.stdout.write(chunk);
      }
      child.stdout.end();

      for (const chunk of stderr) {
        child.stderr.write(chunk);
      }
      child.stderr.end();

      child.emit('close', code, signal);
    });
  }

  return child;
}

function loadProviders(options = {}) {
  clearModuleCaches();

  const base = createBaseProviderMock();
  const configCore = createConfigCoreMock(options.configCore);
  const providerRoutingCore = createProviderRoutingCoreMock(options.providerRoutingCore);
  const prompts = createPromptsMock(options.prompts);
  const providerLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const logger = {
    child: vi.fn(() => providerLogger),
  };
  const childProcess = {
    spawn: vi.fn(() => createMockChild({
      stdout: ['cli output'],
      code: 0,
    })),
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: 'cli output',
      stderr: '',
    })),
    ...(options.childProcess || {}),
  };
  const fs = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    ...(options.fs || {}),
  };
  const constants = {
    TASK_TIMEOUTS: {
      PROVIDER_CHECK: 4321,
      ...((options.constants && options.constants.TASK_TIMEOUTS) || {}),
    },
    PROVIDER_DEFAULT_TIMEOUTS: {
      codex: 17,
      'claude-cli': 13,
      groq: 11,
      ...((options.constants && options.constants.PROVIDER_DEFAULT_TIMEOUTS) || {}),
    },
  };

  installMock(CHILD_PROCESS_MODULE, childProcess);
  installMock(FS_MODULE, fs);
  installMock(CONFIG_CORE_MODULE, configCore);
  installMock(PROVIDER_ROUTING_CORE_MODULE, providerRoutingCore);
  installMock(LOGGER_MODULE, logger);
  installMock(CONSTANTS_MODULE, constants);
  installMock(BASE_MODULE, base.MockBaseProvider);
  installMock(PROMPTS_MODULE, prompts);

  const providers = require(MODULE_PATH);

  return {
    ...providers,
    BaseProvider: base.MockBaseProvider,
    baseConstructorCalls: base.constructorCalls,
    configCore,
    providerRoutingCore,
    prompts,
    childProcess,
    fs,
    logger,
    providerLogger,
    constants,
  };
}

afterEach(() => {
  clearModuleCaches();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.OPENAI_API_KEY = originalOpenAiApiKey;

  if (originalFetch === undefined) {
    delete globalThis.fetch;
  } else {
    globalThis.fetch = originalFetch;
  }

  setPlatform(originalPlatform);
});

describe('v2-cli-providers', () => {
  it('initializes prompts and constructs CodexCliProvider with BaseProvider defaults', () => {
    const loaded = loadProviders();
    const provider = new loaded.CodexCliProvider();

    expect(loaded.prompts.init).toHaveBeenCalledWith({
      db: { getConfig: loaded.configCore.getConfig },
    });
    expect(provider).toBeInstanceOf(loaded.BaseProvider);
    expect(provider.providerId).toBe('codex');
    expect(provider.supportsStreaming).toBe(false);
    expect(loaded.baseConstructorCalls).toEqual([
      { name: 'codex', enabled: true, maxConcurrent: 3 },
    ]);
  });

  it('constructs ClaudeCliProvider with custom base settings', () => {
    const loaded = loadProviders();
    const provider = new loaded.ClaudeCliProvider({
      enabled: false,
      maxConcurrent: 7,
      cliBinary: 'claude-bin',
    });

    expect(provider).toBeInstanceOf(loaded.BaseProvider);
    expect(provider.providerId).toBe('claude-cli');
    expect(provider.cliBinary).toBe('claude-bin');
    expect(provider.enabled).toBe(false);
    expect(provider.maxConcurrent).toBe(7);
    expect(loaded.baseConstructorCalls).toEqual([
      { name: 'claude-cli', enabled: false, maxConcurrent: 7 },
    ]);
  });

  it('builds Codex CLI commands with prompt wrapping, model, cwd, and auto-approve flags', () => {
    const loaded = loadProviders();
    const provider = new loaded.CodexCliProvider();

    loaded.prompts.wrapWithInstructions.mockReturnValueOnce('wrapped prompt');

    expect(provider.buildCommand('  write tests  ', 'gpt-5-codex', {
      auto_approve: true,
      working_directory: '/tmp/repo',
    })).toEqual({
      finalArgs: [
        'exec',
        '--skip-git-repo-check',
        '-m',
        'gpt-5-codex',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        '/tmp/repo',
        '-',
      ],
      stdinPrompt: 'wrapped prompt',
    });
    expect(loaded.prompts.wrapWithInstructions).toHaveBeenCalledWith('write tests', 'codex', 'gpt-5-codex');
  });

  it('builds Claude CLI commands with wrapped prompts and fixed args', () => {
    const loaded = loadProviders();
    const provider = new loaded.ClaudeCliProvider();

    loaded.prompts.wrapWithInstructions.mockReturnValueOnce('claude prompt');

    expect(provider.buildCommand('  summarize this  ', 'claude-sonnet')).toEqual({
      finalArgs: [
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '-p',
      ],
      stdinPrompt: 'claude prompt',
    });
    expect(loaded.prompts.wrapWithInstructions).toHaveBeenCalledWith('summarize this', 'claude-cli', 'claude-sonnet');
  });

  it('submits Codex CLI jobs with resolved Windows cli_path, prompt input, and spawn options', async () => {
    setPlatform('win32');
    let spawnedChild;
    const loaded = loadProviders({
      providerRoutingCore: {
        getProvider: vi.fn(() => ({ cli_path: 'C:\\Tools\\codex' })),
      },
      childProcess: {
        spawn: vi.fn(() => {
          spawnedChild = createMockChild({
            stdout: ['  completed from stdout  '],
            stderr: ['ignored'],
            code: 0,
          });
          return spawnedChild;
        }),
      },
    });
    const provider = new loaded.CodexCliProvider();

    loaded.prompts.wrapWithInstructions.mockReturnValueOnce('stdin prompt');

    const result = await provider.submit('  ship it  ', 'gpt-5-codex', {
      working_directory: 'C:\\repo',
      timeout: 2,
    });

    expect(loaded.providerRoutingCore.getProvider).toHaveBeenCalledWith('codex');
    expect(loaded.childProcess.spawn).toHaveBeenCalledWith(
      'C:\\Tools\\codex.cmd',
      ['exec', '--skip-git-repo-check', '-m', 'gpt-5-codex', '--full-auto', '-C', 'C:\\repo', '-'],
      expect.objectContaining({
        cwd: 'C:\\repo',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: expect.objectContaining({
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
          CI: '1',
          CODEX_NON_INTERACTIVE: '1',
          CLAUDE_NON_INTERACTIVE: '1',
          PYTHONIOENCODING: 'utf-8',
        }),
      }),
    );
    expect(spawnedChild.getStdinText()).toBe('stdin prompt');
    expect(result).toEqual({
      output: 'completed from stdout',
      status: 'completed',
      usage: expect.objectContaining({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost: 0,
        model: 'gpt-5-codex',
      }),
    });
  });

  it('submits Claude CLI jobs with the default non-Windows binary and stderr fallback output', async () => {
    setPlatform('linux');
    let spawnedChild;
    const loaded = loadProviders({
      childProcess: {
        spawn: vi.fn(() => {
          spawnedChild = createMockChild({
            stdout: ['   '],
            stderr: ['  from stderr  '],
            code: 0,
          });
          return spawnedChild;
        }),
      },
    });
    const provider = new loaded.ClaudeCliProvider();

    loaded.prompts.wrapWithInstructions.mockReturnValueOnce('claude stdin');

    const result = await provider.submit('  explain  ', 'claude-3-7', {
      timeout: 0,
    });

    expect(loaded.childProcess.spawn).toHaveBeenCalledWith(
      'claude-cli',
      ['--dangerously-skip-permissions', '--disable-slash-commands', '--strict-mcp-config', '-p'],
      expect.objectContaining({
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }),
    );
    expect(spawnedChild.getStdinText()).toBe('claude stdin');
    expect(result.output).toBe('from stderr');
    expect(result.usage.model).toBe('claude-3-7');
  });

  it('throws a descriptive error when a CLI process exits non-zero', async () => {
    const loaded = loadProviders({
      childProcess: {
        spawn: vi.fn(() => createMockChild({
          stdout: [''],
          stderr: ['  broken pipe  '],
          code: 2,
        })),
      },
    });
    const provider = new loaded.CodexCliProvider();

    await expect(provider.submit('fail', 'gpt-5-codex')).rejects.toThrow(
      'v2 codex CLI exited with status 2: broken pipe',
    );
    expect(loaded.providerLogger.info).toHaveBeenCalledWith(
      '[v2 codex] command failed: v2 codex CLI exited with status 2: broken pipe',
    );
  });

  it('rethrows spawn errors from CLI submission and logs the failure', async () => {
    const spawnError = new Error('spawn exploded');
    const loaded = loadProviders({
      childProcess: {
        spawn: vi.fn(() => createMockChild({
          error: spawnError,
        })),
      },
    });
    const provider = new loaded.CodexCliProvider();

    await expect(provider.submit('fail', 'gpt-5-codex')).rejects.toThrow('spawn exploded');
    expect(loaded.providerLogger.info).toHaveBeenCalledWith('[v2 codex] spawn error: spawn exploded');
  });

  it('kills the CLI when combined stdout and stderr exceed maxBuffer', async () => {
    let spawnedChild;
    const loaded = loadProviders({
      childProcess: {
        spawn: vi.fn(() => {
          spawnedChild = createMockChild({
            stdout: ['x'.repeat((10 * 1024 * 1024) + 1)],
            code: 0,
          });
          return spawnedChild;
        }),
      },
    });
    const provider = new loaded.CodexCliProvider();

    await expect(provider.submit('big output', 'gpt-5-codex')).rejects.toThrow('maxBuffer length exceeded');
    expect(spawnedChild.kill).toHaveBeenCalledTimes(1);
    expect(loaded.providerLogger.info).toHaveBeenCalledWith(
      '[v2 codex] spawn error: stdout/stderr maxBuffer length exceeded',
    );
  });

  it('kills the CLI when the async spawn exceeds the timeout', async () => {
    vi.useFakeTimers();

    let spawnedChild;
    const loaded = loadProviders({
      childProcess: {
        spawn: vi.fn(() => {
          spawnedChild = createMockChild({ deferClose: true });
          return spawnedChild;
        }),
      },
    });
    const provider = new loaded.CodexCliProvider();

    const pending = provider.submit('slow task', 'gpt-5-codex', { timeout: 1 });
    const rejection = expect(pending).rejects.toThrow('Command timed out after 60000ms');

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await rejection;
    expect(spawnedChild.kill).toHaveBeenCalledTimes(1);
    expect(loaded.providerLogger.info).toHaveBeenCalledWith(
      '[v2 codex] spawn error: Command timed out after 60000ms',
    );
  });

  it('rejects API transport for Claude CLI providers', async () => {
    const loaded = loadProviders();
    const provider = new loaded.ClaudeCliProvider();

    await expect(provider.submit('task', 'claude-sonnet', { transport: 'api' })).rejects.toThrow(
      'claude-cli API transport is not available for v2 adapter',
    );
  });

  it('reports healthy CLI versions when checkHealth succeeds', async () => {
    setPlatform('linux');
    const loaded = loadProviders({
      childProcess: {
        spawnSync: vi.fn(() => ({
          status: 0,
          stdout: '  claude 1.2.3  ',
          stderr: '',
        })),
      },
    });
    const provider = new loaded.ClaudeCliProvider();

    await expect(provider.checkHealth()).resolves.toEqual({
      available: true,
      models: [],
      version: 'claude 1.2.3',
    });
    expect(loaded.childProcess.spawnSync).toHaveBeenCalledWith(
      'claude-cli',
      ['--version'],
      {
        timeout: loaded.constants.TASK_TIMEOUTS.PROVIDER_CHECK,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
  });

  it('returns an unavailable health result when CLI version checks fail', async () => {
    const loaded = loadProviders({
      childProcess: {
        spawnSync: vi.fn(() => ({
          status: 1,
          stdout: '',
          stderr: '  not installed  ',
        })),
      },
    });
    const provider = new loaded.ClaudeCliProvider();

    await expect(provider.checkHealth()).resolves.toEqual({
      available: false,
      models: [],
      error: 'not installed',
    });
  });

  it('submits Codex API jobs with file-based auth, db config, and normalized usage', async () => {
    delete process.env.OPENAI_API_KEY;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'server-model',
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: '  API ' },
              { type: 'output_text', text: 'output  ' },
            ],
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
        },
      }),
    });
    const loaded = loadProviders({
      configCore: {
        getConfig: vi.fn((key) => {
          if (key === 'openai_base_url') return 'https://example.test/';
          if (key === 'codex_api_model') return 'db-model';
          return null;
        }),
      },
      fs: {
        existsSync: vi.fn((filePath) => filePath.endsWith('api.auth.json')),
        readFileSync: vi.fn(() => JSON.stringify({ OPENAI_API_KEY: 'file-token' })),
      },
    });
    const provider = new loaded.CodexCliProvider();

    const result = await provider.submit('  use api  ', null, {
      transport: 'api',
      maxTokens: '9.8',
      tuning: { temperature: '0.4' },
      timeout: 3,
    });

    expect(loaded.fs.existsSync).toHaveBeenCalled();
    expect(loaded.prompts.wrapWithInstructions).toHaveBeenCalledWith('use api', 'codex', 'db-model');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.test/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer file-token',
        },
        body: JSON.stringify({
          model: 'db-model',
          input: 'wrapped:codex:db-model:use api',
          max_output_tokens: 9,
          temperature: 0.4,
        }),
        signal: expect.any(Object),
      }),
    );
    expect(result).toEqual({
      output: 'API output',
      status: 'completed',
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
        cost: 0.000048,
        duration_ms: expect.any(Number),
        model: 'server-model',
      },
    });
  });

  it('runs raw prompts through the Codex CLI without wrapping instructions', async () => {
    setPlatform('linux');
    let spawnedChild;
    const loaded = loadProviders({
      childProcess: {
        spawn: vi.fn(() => {
          spawnedChild = createMockChild({
            stdout: ['  raw output  '],
            code: 0,
          });
          return spawnedChild;
        }),
      },
    });
    const provider = new loaded.CodexCliProvider();

    const output = await provider.runPrompt({
      prompt: 'System prompt\n\nUser prompt',
      max_tokens: 123,
      working_directory: '/tmp/patterns',
    });

    expect(output).toBe('raw output');
    expect(spawnedChild.getStdinText()).toBe('System prompt\n\nUser prompt');
    expect(loaded.prompts.wrapWithInstructions).not.toHaveBeenCalled();
    expect(loaded.childProcess.spawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '--skip-git-repo-check', '--full-auto', '-C', '/tmp/patterns', '-'],
      expect.objectContaining({
        cwd: '/tmp/patterns',
      }),
    );
  });

  it('runs raw prompts through the Codex API when transport=api is requested', async () => {
    process.env.OPENAI_API_KEY = 'env-token';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: 'pattern result',
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          total_tokens: 3,
        },
      }),
    });
    const loaded = loadProviders();
    const provider = new loaded.CodexCliProvider();

    const output = await provider.runPrompt({
      prompt: 'System prompt\n\nUser prompt',
      transport: 'api',
      max_tokens: 77,
    });

    expect(output).toBe('pattern result');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          input: 'System prompt\n\nUser prompt',
          max_output_tokens: 77,
        }),
      }),
    );
    expect(loaded.prompts.wrapWithInstructions).not.toHaveBeenCalled();
  });

  it('throws when Codex API transport has no available token', async () => {
    delete process.env.OPENAI_API_KEY;
    const loaded = loadProviders({
      fs: {
        existsSync: vi.fn(() => false),
      },
    });
    const provider = new loaded.CodexCliProvider();

    await expect(provider.submit('no token', null, { transport: 'api' })).rejects.toThrow(
      'codex API transport is unavailable: no OPENAI_API_KEY or Codex auth token found',
    );
    expect(loaded.fs.existsSync).toHaveBeenCalled();
  });

  it('truncates Codex API error bodies when fetch returns a non-ok response', async () => {
    process.env.OPENAI_API_KEY = 'env-token';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'x'.repeat(400),
    });
    const loaded = loadProviders();
    const provider = new loaded.CodexCliProvider();

    await expect(provider.submit('rate limit', 'gpt-5-codex', { transport: 'api' })).rejects.toThrow(
      /OpenAI API error \(429\): .*\.\.\.$/,
    );
  });

  it('throws when Codex API returns no extractable response text', async () => {
    process.env.OPENAI_API_KEY = 'env-token';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }),
    });
    const loaded = loadProviders();
    const provider = new loaded.CodexCliProvider();

    await expect(provider.submit('empty output', 'gpt-5-codex', { transport: 'api' })).rejects.toThrow(
      'OpenAI API returned empty response content',
    );
  });
});
