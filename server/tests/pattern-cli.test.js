'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  initializeProviderRuntime,
  main,
} = require('../patterns/cli');

describe('patterns/cli', () => {
  let rootDir;
  let patternsDir;

  function writePattern(name, files) {
    const patternDir = path.join(patternsDir, name);
    fs.mkdirSync(patternDir, { recursive: true });
    for (const [fileName, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(patternDir, fileName), content, 'utf8');
    }
  }

  function createOutput() {
    return {
      chunks: [],
      write(chunk) {
        this.chunks.push(String(chunk));
      },
      text() {
        return this.chunks.join('');
      },
    };
  }

  function createDb({ ready = false } = {}) {
    let isReady = ready;
    return {
      isReady: vi.fn(() => isReady),
      init: vi.fn(() => {
        isReady = true;
      }),
      close: vi.fn(() => {
        isReady = false;
      }),
    };
  }

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-cli-'));
    patternsDir = path.join(rootDir, '.torque', 'patterns');
    fs.mkdirSync(patternsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('runs a pattern through injected provider runtime dependencies', async () => {
    writePattern('summarize', {
      'system.md': 'Summarize clearly.',
      'user.md': 'Input: {{input}}',
    });
    const db = createDb();
    const serverConfig = { init: vi.fn() };
    const codex = {
      runPrompt: vi.fn(async ({ prompt }) => `model:${prompt}`),
    };
    const providerRegistry = {
      init: vi.fn(),
      registerProviderClass: vi.fn(),
      getProviderInstance: vi.fn(() => codex),
    };
    const stdout = createOutput();
    const stderr = createOutput();

    const code = await main(
      ['--dir', patternsDir, '-p', 'summarize'],
      { stdout, stderr, stdin: { isTTY: true }, cwd: rootDir },
      {
        db,
        serverConfig,
        providerRegistry,
        CodexCliProvider: class FakeCodexCliProvider {},
      },
    );

    expect(code).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toBe('model:Summarize clearly.\n\nInput:');
    expect(db.init).toHaveBeenCalledTimes(1);
    expect(serverConfig.init).toHaveBeenCalledWith({ db });
    expect(providerRegistry.init).toHaveBeenCalledWith({ db });
    expect(providerRegistry.registerProviderClass).toHaveBeenCalledWith('codex', expect.any(Function));
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it('lists patterns without resolving provider database dependencies', async () => {
    writePattern('summarize', {
      'system.md': 'Summarize clearly.',
      'metadata.json': JSON.stringify({ description: 'Short summary' }),
    });
    const stdout = createOutput();
    const stderr = createOutput();
    const getDb = vi.fn(() => {
      throw new Error('db should not be resolved for list mode');
    });

    const code = await main(
      ['--dir', patternsDir, '--list'],
      { stdout, stderr, stdin: { isTTY: true }, cwd: rootDir },
      { db: getDb },
    );

    expect(code).toBe(0);
    expect(stdout.text()).toContain('summarize - Short summary');
    expect(stderr.text()).toBe('');
    expect(getDb).not.toHaveBeenCalled();
  });

  it('requires an injected or container database service instead of the legacy facade fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'patterns', 'cli.js'), 'utf8');
    expect(source).not.toMatch(/require\(['"]\.\.\/database['"]\)/);

    expect(() => initializeProviderRuntime({
      serverConfig: { init: vi.fn() },
      providerRegistry: {
        init: vi.fn(),
        registerProviderClass: vi.fn(),
        getProviderInstance: vi.fn(),
      },
      CodexCliProvider: class FakeCodexCliProvider {},
    })).toThrow('database service is unavailable');
  });
});
