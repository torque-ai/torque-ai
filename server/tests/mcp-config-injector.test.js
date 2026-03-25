'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

let injector;
let tmpHome;
let tmpDataDir;

function claudeDir() { return path.join(tmpHome, '.claude'); }
function mcpPath() { return path.join(claudeDir(), '.mcp.json'); }
function keyFilePath() { return path.join(tmpDataDir, '.torque-api-key'); }

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-mcp-inject-'));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-mcp-data-'));

  fs.writeFileSync(keyFilePath(), 'torque_sk_test-key-1234');

  delete require.cache[require.resolve('../auth/mcp-config-injector')];
  injector = require('../auth/mcp-config-injector');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('ensureGlobalMcpConfig', () => {
  it('creates ~/.claude/.mcp.json when absent', () => {
    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(true);
    expect(result.reason).toBe('created');
    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers.torque.type).toBe('sse');
    expect(data.mcpServers.torque.url).toContain('torque_sk_test-key-1234');
    expect(data.mcpServers.torque.url).toContain('3458');
  });

  it('merges into existing file with other servers', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(mcpPath(), JSON.stringify({
      mcpServers: {
        'other-tool': { type: 'stdio', command: 'other', args: [] },
      },
    }, null, 2));

    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(true);
    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers['other-tool'].command).toBe('other');
    expect(data.mcpServers.torque.url).toContain('torque_sk_test-key-1234');
  });

  it('skips write when entry already matches', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    const existing = {
      mcpServers: {
        torque: {
          type: 'sse',
          url: 'http://127.0.0.1:3458/sse?apiKey=torque_sk_test-key-1234',
          description: 'TORQUE - Task Orchestration System with local LLM routing',
        },
      },
    };
    fs.writeFileSync(mcpPath(), JSON.stringify(existing, null, 2));
    const mtimeBefore = fs.statSync(mcpPath()).mtimeMs;

    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe('already_current');
    expect(fs.statSync(mcpPath()).mtimeMs).toBe(mtimeBefore);
  });

  it('updates URL when key changes', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(mcpPath(), JSON.stringify({
      mcpServers: {
        torque: {
          type: 'sse',
          url: 'http://127.0.0.1:3458/sse?apiKey=torque_sk_old-key',
          description: 'TORQUE - Task Orchestration System with local LLM routing',
        },
      },
    }, null, 2));

    const result = injector.ensureGlobalMcpConfig('torque_sk_new-key', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(true);
    expect(result.reason).toBe('updated');
    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers.torque.url).toContain('torque_sk_new-key');
    expect(data.mcpServers.torque.url).not.toContain('old-key');
  });

  it('preserves file on JSON parse failure', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(mcpPath(), '{ broken json !!!');

    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe('parse_error');
    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe('{ broken json !!!');
  });

  it('creates ~/.claude/ directory when missing', () => {
    expect(fs.existsSync(claudeDir())).toBe(false);

    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(true);
    expect(fs.existsSync(claudeDir())).toBe(true);
  });

  it('skips when apiKey is empty or missing', () => {
    const result1 = injector.ensureGlobalMcpConfig('', { homeDir: tmpHome });
    expect(result1.injected).toBe(false);
    expect(result1.reason).toBe('no_key');

    const result2 = injector.ensureGlobalMcpConfig(null, { homeDir: tmpHome });
    expect(result2.injected).toBe(false);
    expect(result2.reason).toBe('no_key');
  });

  it('uses non-default SSE port', () => {
    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 9999,
    });

    expect(result.injected).toBe(true);
    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers.torque.url).toContain(':9999/sse');
  });

  it('preserves user-added fields on entry update', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(mcpPath(), JSON.stringify({
      mcpServers: {
        torque: {
          type: 'sse',
          url: 'http://127.0.0.1:3458/sse?apiKey=torque_sk_old-key',
          description: 'TORQUE',
          customField: 'user-value',
          timeout: 30000,
        },
      },
    }, null, 2));

    injector.ensureGlobalMcpConfig('torque_sk_new-key', {
      homeDir: tmpHome, ssePort: 3458,
    });

    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers.torque.url).toContain('torque_sk_new-key');
    expect(data.mcpServers.torque.customField).toBe('user-value');
    expect(data.mcpServers.torque.timeout).toBe(30000);
  });
});

describe('readKeyFromFile', () => {
  it('reads plaintext key from .torque-api-key file', () => {
    const key = injector.readKeyFromFile(tmpDataDir);
    expect(key).toBe('torque_sk_test-key-1234');
  });

  it('returns null when key file does not exist', () => {
    fs.unlinkSync(keyFilePath());
    const key = injector.readKeyFromFile(tmpDataDir);
    expect(key).toBeNull();
  });

  it('trims whitespace and newlines from key file', () => {
    fs.writeFileSync(keyFilePath(), '  torque_sk_trimmed  \n');
    const key = injector.readKeyFromFile(tmpDataDir);
    expect(key).toBe('torque_sk_trimmed');
  });
});
