'use strict';

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
const DATABASE_MODULE = '../database';
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
    DATABASE_MODULE,
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

function createDbMock(overrides = {}) {
  return {
    getProvider: vi.fn(() => ({})),
    getConfig: vi.fn(() => null),
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

function loadProviders(options = {}) {
  clearModuleCaches();

  const base = createBaseProviderMock();
  const db = createDbMock(options.db);
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
  installMock(DATABASE_MODULE, db);
  installMock(LOGGER_MODULE, logger);
  installMock(CONSTANTS_MODULE, constants);
  installMock(BASE_MODULE, base.MockBaseProvider);
  installMock(PROMPTS_MODULE, prompts);

  const providers = require(MODULE_PATH);

  return {
    ...providers,
    BaseProvider: base.MockBaseProvider,
    baseConstructorCalls: base.constructorCalls,
    db,
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

    expect(loaded.prompts.init).toHaveBeenCalledWith({ db: loaded.db });
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
    const loaded = loadProviders({
      db: {
        getProvider: vi.fn(() => ({ cli_path: 'C:\\Tools\\codex' })),
      },
      childProcess: {
        spawnSync: vi.fn(() => ({
          status: 0,
          stdout: '  completed from stdout  ',
          stderr: 'ignored',
        })),
      },
    });
    const provider = new loaded.CodexCliProvider();

    loaded.prompts.wrapWithInstructions.mockReturnValueOnce('stdin prompt');

    const result = await provider.submit('  ship it  ', 'gpt-5-codex', {
      working_directory: 'C:\\repo',
      timeout: 2,
    });

    expect(loaded.db.getProvider).toHaveBeenCalledWith('codex');
    expect(loaded.childProcess.spawnSync).toHaveBeenCalledWith(
      'C:\\Tools\\codex.cmd',
      ['exec', '--skip-git-repo-check', '-m', 'gpt-5-codex', '--full-auto', '-C', 'C:\\repo', '-'],
      expect.objectContaining({
        cwd: 'C:\\repo',
        input: 'stdin prompt',
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
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
    const loaded = loadProviders({
      childProcess: {
        spawnSync: vi.fn(() => ({
          status: 0,
          stdout: '   ',
          stderr: '  from stderr  ',
        })),
      },
    });
    const provider = new loaded.ClaudeCliProvider();

    loaded.prompts.wrapWithInstructions.mockReturnValueOnce('claude stdin');

    const result = await provider.submit('  explain  ', 'claude-3-7', {
      timeout: 0,
    });

    expect(loaded.childProcess.spawnSync).toHaveBeenCalledWith(
      'claude-cli',
      ['--dangerously-skip-permissions', '--disable-slash-commands', '--strict-mcp-config', '-p'],
      expect.objectContaining({
        cwd: process.cwd(),
        input: 'claude stdin',
        timeout: loaded.constants.PROVIDER_DEFAULT_TIMEOUTS['claude-cli'] * 60 * 1000,
        shell: false,
      }),
    );
    expect(result.output).toBe('from stderr');
    expect(result.usage.model).toBe('claude-3-7');
  });

  it('throws a descriptive error when a CLI process exits non-zero', async () => {
    const loaded = loadProviders({
      childProcess: {
        spawnSync: vi.fn(() => ({
          status: 2,
          stdout: '',
          stderr: '  broken pipe  ',
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
        spawnSync: vi.fn(() => ({
          error: spawnError,
          status: null,
          stdout: '',
          stderr: '',
        })),
      },
    });
    const provider = new loaded.CodexCliProvider();

    await expect(provider.submit('fail', 'gpt-5-codex')).rejects.toThrow('spawn exploded');
    expect(loaded.providerLogger.info).toHaveBeenCalledWith('[v2 codex] spawn error: spawn exploded');
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
      db: {
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
