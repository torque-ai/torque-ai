import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { parseArgs, resolveConfig, runCli } = require('../bin/torque-peek.js');

function createIo() {
  const stdout = [];
  const stderr = [];

  return {
    io: {
      stdout: {
        write(chunk) {
          stdout.push(String(chunk));
        },
      },
      stderr: {
        write(chunk) {
          stderr.push(String(chunk));
        },
      },
      log(message = '') {
        stdout.push(`${message}\n`);
      },
      error(message = '') {
        stderr.push(`${message}\n`);
      },
    },
    stdout,
    stderr,
    getStdout() {
      return stdout.join('');
    },
    getStderr() {
      return stderr.join('');
    },
  };
}

function createClosingServer() {
  const server = new EventEmitter();
  server.listening = false;
  server.address = () => ({ address: '127.0.0.1', port: 9876 });

  queueMicrotask(() => {
    server.listening = true;
    server.emit('listening');
    queueMicrotask(() => {
      server.listening = false;
      server.emit('close');
    });
  });

  return server;
}

describe('@torque-ai/peek CLI', () => {
  it('parses command options and environment defaults', () => {
    expect(parseArgs(['start', '--host=0.0.0.0', '--port', '9877', '--token', 'secret'])).toEqual({
      command: 'start',
      options: {
        host: '0.0.0.0',
        port: '9877',
        token: 'secret',
      },
      positionals: [],
    });

    expect(resolveConfig({}, {
      TORQUE_PEEK_HOST: '127.0.0.2',
      TORQUE_PEEK_PORT: '9999',
      TORQUE_PEEK_TOKEN: 'env-token',
      TORQUE_PEEK_PID_FILE: '/tmp/peek.pid',
    })).toMatchObject({
      host: '127.0.0.2',
      port: 9999,
      token: 'env-token',
      pidFile: '/tmp/peek.pid',
    });
  });

  it('check prints dependency details and fails when required tools are missing', async () => {
    const io = createIo();
    const code = await runCli(['check'], {
      io: io.io,
      checkDependencies: () => ({
        platform: 'linux',
        supported: true,
        adapter: 'linux',
        ok: false,
        available: ['xdotool'],
        missing: ['xprop', 'maim or import'],
        capabilities: ['compare', 'interact', 'launch'],
        checks: [
          { name: 'xdotool', available: true },
          { name: 'xprop', available: false, install: 'Install x11-utils.' },
        ],
      }),
    });

    expect(code).toBe(1);
    expect(io.getStdout()).toContain('Peek dependency check');
    expect(io.getStdout()).toContain('Status:       degraded');
    expect(io.getStdout()).toContain('Missing:      xprop, maim or import');
    expect(io.getStdout()).toContain('missing xprop');
  });

  it('status requests /health and supports JSON output', async () => {
    const io = createIo();
    const requestJson = vi.fn(async ({ config, method, requestPath }) => ({
      ok: true,
      status: 200,
      body: {
        success: true,
        status: 'healthy',
        platform: 'win32',
        supported: true,
        adapter: 'win32',
        version: '1.0.0',
        uptime_seconds: 4,
        capabilities: ['capture'],
        dependencies: { ok: true, missing: [] },
        seen: `${method} ${requestPath} ${config.port}`,
      },
    }));

    const code = await runCli(['status', '--port', '1234', '--json'], {
      io: io.io,
      requestJson,
    });

    expect(code).toBe(0);
    expect(requestJson).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      requestPath: '/health',
      config: expect.objectContaining({ port: 1234 }),
    }));
    expect(JSON.parse(io.getStdout())).toMatchObject({
      status: 'healthy',
      platform: 'win32',
      seen: 'GET /health 1234',
    });
  });

  it('start wires the platform adapter into createServer', async () => {
    const io = createIo();
    const server = createClosingServer();
    const adapter = { platform: 'test-os' };
    const createServer = vi.fn(() => ({ server, pidFile: 'peek.pid' }));
    const createPlatformAdapter = vi.fn(() => adapter);

    const code = await runCli(['start', '--host', '127.0.0.1', '--port', '0', '--pid-file', 'peek.pid'], {
      io: io.io,
      requestJson: vi.fn(async () => {
        throw new Error('not running');
      }),
      createServer,
      createPlatformAdapter,
      installSignalHandlers: false,
    });

    expect(code).toBe(0);
    expect(createPlatformAdapter).toHaveBeenCalledWith(process.platform);
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      host: '127.0.0.1',
      port: 0,
      pidFile: 'peek.pid',
      adapter,
      installSignalHandlers: false,
    }));
    expect(io.getStdout()).toContain('Peek server listening');
  });

  it('stop posts to /shutdown with token-aware config', async () => {
    const io = createIo();
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { success: true, shutting_down: true },
      })
      .mockRejectedValueOnce(new Error('stopped'));

    const code = await runCli(['stop', '--token', 'secret'], {
      io: io.io,
      requestJson,
      sleep: async () => {},
    });

    expect(code).toBe(0);
    expect(requestJson).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      requestPath: '/shutdown',
      body: { reason: 'cli stop' },
      config: expect.objectContaining({ token: 'secret' }),
    }));
    expect(io.getStdout()).toContain('Peek server shutting down.');
  });
});
